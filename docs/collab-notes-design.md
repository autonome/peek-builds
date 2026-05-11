# Collaborative Notes — Design

**Status:** v1 design. Implementation has not started.
**Scope:** the `features/collab-notes/` feature: real-time + async
multi-user editing of structured notes, with no Peek-operated server in
the data path.
**Task:** peek task `053db0fe-5c8d-4fd5-a6e9-6316ab6ae059`.

---

## Principles

1. **Local datastore is the source of truth.** PDS records are a
   transient queue. They exist only to bridge offline gaps between
   peers, and are deleted as soon as both ends have applied them.
2. **No Peek-operated server.** Not in the signalling path, not in the
   storage path, not anywhere. The user's atproto PDS is theirs; we use
   it, we don't run it.
3. **Cross-runtime.** Electron desktop, Tauri (desktop + mobile),
   future server runtime. No platform-specific APIs, no long-lived
   client endpoints, no native modules without portable equivalents.
4. **Identity is plural and protocol-agnostic.** Users hold multiple
   accounts across potentially multiple protocols; the feature speaks
   the API contract, not the protocol details.
5. **Lazy identity.** Auth happens when a feature needs it, not at
   Peek startup. Collab-notes triggers atproto sign-in on first use
   inside the feature.

---

## Identity (`api.identity`)

Portable, plural, protocol-agnostic. v1 ships only the atproto provider;
the shape is forward-compatible for additional protocols.

```ts
api.identity.accounts(): Account[]
api.identity.account(id: string): Account | null
api.identity.addAccount(protocol: ProtocolId, opts: object): Promise<Account>
api.identity.removeAccount(id: string): Promise<void>
api.identity.signWith(id: string, bytes: Uint8Array): Promise<Uint8Array>
api.identity.publicKey(id: string): Uint8Array
api.identity.encryptionKey(id: string): Uint8Array     // X25519 derived

type ProtocolId = 'atproto' | (future)

type Account = {
  id: string                     // opaque Peek-local UUID
  protocol: ProtocolId
  display: { handle: string; name?: string; avatar?: string }
  protocolData: AtprotoData | ...
}

type AtprotoData = {
  did: string                    // did:plc:...
  pds: string                    // PDS service URL
  // OAuth tokens stored separately in profile-local secure storage,
  // referenced by Account.id — never serialized into protocolData.
}
```

**Secure storage of tokens + keys** is per-runtime:
- Electron: `keytar`
- Tauri: `tauri-plugin-stronghold`
- Server: explicit-path file with permissions, or env var

**Encryption-key derivation:** Ed25519 → X25519 standard conversion of
the atproto signing key. Reuses identity material; one identity, one
key story. If atproto adds dedicated encryption keys to the DID document
later, migrate to those.

**v1 protocol support:** `atproto` only. v1 lexicons:
- `space.peek.collab.signal` — encrypted WebRTC signalling records
- `space.peek.collab.update` — encrypted CRDT update records (transient)
- `space.peek.collab.clock`  — encrypted per-peer-per-note ack pointers
- `space.peek.collab.invite` — encrypted note-membership invitations
  (lexicon name proposed; final shape carried as an open question)

---

## Contacts (identity-of-others, separate feature)

Collab-notes consumes the Peek **contacts feature** (`features/contacts/`)
as the address-of-recipients surface. A Contact carries one or more
`ProtocolRef`s (`{ protocol, identifier }`); the X3DH handshake described
under "Encryption" below resolves a Contact to a peer DID and per-pair
session.

Contacts has its own design (peek task
`af8abc4a-bb88-41ed-b432-4e8ec8f30030`). Relevant to this doc:

- Contact creation is **lazy**: any handle/DID used in a share/invite
  command auto-adds the target to contacts with `source: 'invite-
  outbound'` and `verified: 'tofu'`. The user can upgrade verification
  to `fingerprint` out-of-band.
- The per-pair shared secret used to HMAC rkeys (see §"What the
  firehose can read…") is derived from the X3DH session keyed to a
  Contact's atproto ref. One Contact → one secret per Account-pair.
- Contacts must ship **before collab-notes Phase 3** (multi-user). Can
  proceed in parallel with Phases 0–2.

---

## CRDT layer

**Automerge** (WASM build), JSON-shaped document model.

Document schema per note:

```ts
{
  id: string                  // opaque, random at creation
  title: Automerge.Text
  body: Automerge.Text
  tags: string[]
  links: Array<{ kind: string; target: string }>
  members: Array<{
    accountRef: { protocol: ProtocolId; identifier: string }
    role: 'owner' | 'editor' | 'reader'
    addedAt: number           // ms epoch
  }>
  membershipSeq: number       // bumped on member change; drives key rotation
}
```

`accountRef` is protocol-tagged so v1 atproto members can later coexist
with members on other protocols, when the transport supports it.

`Automerge.Text` for `title` and `body` lets the editor render
collaborative cursors and resolve concurrent edits character-precisely.

---

## Encryption

Signal-style. End-to-end, with forward secrecy and a per-note symmetric
key rotated on membership change.

**Pairwise handshake** (X3DH): two peers establish a shared root key
using their long-term DID-derived X25519 keys plus ephemeral keys.

**Double ratchet:** each direction-of-traffic between two peers ratchets
the symmetric key per message. Past-traffic compromise doesn't expose
older payloads.

**Per-note key:** AES-256-GCM key shared between members. Distributed
via the pairwise channel from owner to each new member. Rotated when
`membershipSeq` bumps; previous members can't decrypt updates after
their removal.

**Library:** libsodium WASM (`sodium-native` on server, `libsodium-wrappers`
in browser/WebView). One crypto stack across runtimes.

**Algorithms:**
- Pairwise: X25519 + HKDF + AES-256-GCM
- Per-note payload: AES-256-GCM with 96-bit nonce
- Signatures: Ed25519 (the user's atproto signing key)

---

## Online transport — WebRTC

When both peers are online and reachable, sync messages flow over a
WebRTC datachannel. WebRTC works in every runtime we target
(Electron, Tauri WebView desktop+mobile, server via `wrtc`).

**Signalling.** Encrypted SDP/ICE payloads in atproto records under
`space.peek.collab.signal`. Each peer writes signals to its own PDS,
addressed to the other peer:

```
collection: space.peek.collab.signal
rkey:       <HMAC(recipientDid, perPairSecret)>-<seq>
value:      { ciphertext, sig }            // SDP/ICE encrypted to recipient
```

The recipient DID is HMAC'd into the rkey so a firehose observer
can't read "Alice is signalling Bob" off the wire — the rkey is an
opaque pair-of-bytes. Only Alice and Bob (sharing the per-pair
secret) compute the same HMAC and locate each other's signals.
Payload is encrypted to the recipient's X25519 key.

Discovery latency is ~seconds (firehose delivery, or polling). Fine for
handshake; once the datachannel is up, real sync flows P2P and never
touches the PDS.

**STUN:** public servers (Cloudflare / Google). **TURN:** skipped at
v1. If NAT traversal fails, the connection falls through to the async
queue path — no special-casing.

**Signal record lifetime:** signals are deleted as soon as the
handshake completes, or after a short TTL if no response. Steady state:
no signal records on either PDS.

---

## Async transport — PDS as transient queue (Merkle-clock semantics)

When peers don't overlap, updates flow through each user's own PDS.
The PDS is a *queue*, not a store. Records are created, fetched, and
deleted within hours of overlap. The local datastore remains the
source of truth; PDS records exist only to bridge a gap.

Automerge is internally a Merkle-CRDT — every change has a
content-addressed hash and the change history is a hash-linked DAG
(see [Psaras 2020, "Merkle-CRDTs"](https://research.protocol.ai/publications/merkle-crdts-merkle-dags-meet-crdts/psaras2020.pdf)).
The PDS protocol below exposes that fact rather than papering over it
with sequence numbers: update records are addressed by change hash,
and acknowledgement is a set of DAG *heads* (latest-known change
hashes), not a scalar counter. This is also what Automerge's native
sync protocol exchanges over a live connection — the WebRTC and
PDS-queue paths now speak the same primitive.

### Why heads and not sequence numbers

A single user can be signed into multiple devices on the same DID;
both write to the same PDS. With per-`(sender, note)` sequence numbers
the two devices would collide on rkey assignments and need extra
coordination. Content-addressed (hash) rkeys are unique by
construction, idempotent under retry, and naturally model the
concurrent-branch case (two devices each producing a change with no
common parent).

### The protocol per direction A → B

1. **Send.** A applies a local edit to note N, producing an Automerge
   change `c` with hash `h(c)` and parent hashes `parents(c)`. A wraps
   `c` in an encrypted envelope keyed to the per-note symmetric key,
   signs it with A's identity key, and writes it to A's PDS:

   ```
   collection: space.peek.collab.update
   rkey:       <noteIdHmac>-<h(c)>       // content-addressed
   value:      { senderDid, noteId, hash, parents, ciphertext, sig }
   ```

   Same change written twice (network retry, two devices producing the
   same op) → same rkey → `putRecord` is idempotent. No coordination.

2. **Discover.** B subscribes to A's firehose (or polls A's PDS) for
   `space.peek.collab.update` records. When B sees one, B downloads it.

3. **Apply.** B decrypts, verifies A's signature, applies the change
   via `Automerge.applyChanges`. Parent hashes in the envelope let
   Automerge resolve ordering even if changes arrive out of causal
   order — missing parents trigger a fetch of the prior changes.
   **Local datastore is now up to date; this is the source of truth.**

4. **Acknowledge (heads).** B updates a single rolling *heads* record
   on B's PDS:

   ```
   collection: space.peek.collab.clock
   rkey:       <HMAC(senderDid, perPairSecret)>-<HMAC(noteId, perPairSecret)>
   value:      { heads: [h1, h2, ...], updatedAt }   // encrypted to A
   ```

   **Both halves of the rkey are HMAC'd with the per-pair shared
   secret.** Plaintext sender DID in the rkey would otherwise leak
   the social graph directly off the firehose ("Bob acks Alice on
   some note"). Each side computes the same HMAC over the per-pair
   secret to locate the record. The value is encrypted to A's
   per-pair key so the heads list (which leaks DAG shape) is also
   private.

   `heads` is the set of latest change hashes B has applied from A —
   typically 1 in the common case, larger when A has concurrent
   branches not yet merged in B's view. Overwritten in place via
   `putRecord`; never accumulates.

5. **Cleanup (DAG ancestry).** A polls (or firehoses) B's heads
   record. For each update record on A's PDS, A asks Automerge:
   "is `h(c)` either in `B.heads`, or an ancestor of any hash in
   `B.heads`?" If yes, the change has been subsumed by what B has
   applied — A calls `com.atproto.repo.deleteRecord` to remove that
   update. If no, leave it (B hasn't seen it yet or has applied a
   concurrent branch that doesn't subsume it).

   Automerge's ancestry query is O(DAG depth), bounded by the
   length of the change chain, in practice fast.

### Steady-state PDS footprint

After all updates have been delivered and acked:
- Update records on A's PDS: **0**
- Update records on B's PDS: **0**
- Heads records on A's PDS: **1 per peer per note** (B's heads for A)
- Heads records on B's PDS: **1 per peer per note**

The PDS storage cost for an N-peer note is `O(N)` heads records, no
update payloads. Heads records are small (set of ~32-byte hashes,
usually 1 element). In a healthy collaboration with regular overlap,
update records are short-lived; in long-offline scenarios, only
unacknowledged-tail records exist.

### What the firehose can read off this protocol

PDS record commits are always public; only rkey and value can be
opaqued. After the HMAC'ing applied to signal/clock rkeys above and
content encryption everywhere, what a firehose observer sees per
record:

| Record | Public | Hidden |
|---|---|---|
| `space.peek.collab.signal` | publisher DID, timestamp, "is doing collab handshake" | recipient DID, SDP/ICE content |
| `space.peek.collab.update` | publisher DID, timestamp, size class, "is sending a CRDT update to someone" | recipient DID, noteId, change content, DAG ancestry |
| `space.peek.collab.clock` | publisher DID, timestamp, "is acknowledging some peer for some note" | sender DID being acked, noteId, heads list, DAG shape |

The sender DID of every record is intrinsically public — atproto
authenticates record commits by the publisher's DID. The recipient
DID and noteId are HMAC'd through the per-pair secret on rkeys, and
the value is always encrypted to the relevant key. No record reveals
the social graph by itself.

### Residual leaks (cannot be hidden in this layer)

- **Use of collab-notes**: the `space.peek.collab.*` lexicon namespace
  identifies a user as a Peek collab participant. Cannot hide without
  abandoning Peek-specific lexicons.
- **Publication attribution**: every record commit names its publishing
  DID. Cannot hide who *sent* something; can hide whom it's *for*.
- **Activity timing and cadence**: each DID's editing pattern is visible
  in commit timestamps. Cover traffic could mask this; v1 doesn't ship
  cover traffic.
- **Correlation across multiple identities of the same user**: a
  network observer watching outbound traffic from a single Peek device
  sees writes to PDS-1 (account A1) and PDS-2 (account A2) from the
  same source IP at correlated times. The accounts are linkable at the
  network layer even if not at the atproto layer. Per-account egress
  isolation (Tor, separate VPN tunnels) is out of v1 scope.
- **Group fingerprinting (N ≥ 3 members)**: synchronized publication
  patterns across N DIDs in the `collab.*` namespace probabilistically
  identify them as a group. Mitigated weakly by per-account
  publication jitter; cannot be fully hidden without cover traffic.
- **WebRTC source IPs**: peers learn each other's public IPs during
  ICE negotiation. STUN servers see each peer's IP independently. No
  TURN at v1, so no relay can see traffic. Network-anonymizing
  transports are out of scope.

See "Open questions" for which of these we plan to address later vs.
accept permanently.

### When WebRTC works in parallel

Online overlap doesn't create PDS update records at all. Automerge's
native sync protocol already exchanges heads; the WebRTC datachannel
runs that protocol directly. After a session, both sides write their
new heads to the PDS so the next offline cycle has accurate ack
visibility. Updates exchanged inline never hit the PDS.

### Forward secrecy under transient storage

The double-ratchet key advances on every Automerge sync message,
whether delivered via WebRTC or PDS-queue. A queued update sits on the
PDS encrypted with the ratchet key that was current when it was
written. Decryption requires that key — which the recipient has from
their pairwise state — but compromising the user's *current* state
doesn't expose past payloads, since prior ratchet states are
discarded after delivery + ack.

Combined with ack-and-delete: by the time a long-term compromise could
target old payloads, those payloads are no longer on the PDS at all.

---

## Cross-runtime feature shape

`features/collab-notes/` lives in the existing tile/feature directory.
Consumes only portable APIs:

- `api.identity.*` — added in Phase 0
- `api.pubsub.*` — existing
- `api.datastore.*` — existing; Automerge docs serialized as binary
  blobs in a new table
- `api.pds.*` — existing (read/write/delete records on the user's PDS
  via OAuth)
- `api.network.fetch` — existing
- **New:** `api.network.webrtc` — portable wrapper around
  `RTCPeerConnection` and `RTCDataChannel`

Each runtime supplies the WebRTC binding:
- Electron: `RTCPeerConnection` via Chromium (built-in)
- Tauri WebView: native WebView's `RTCPeerConnection` (Chromium on
  Linux/Windows, WebKit on macOS/iOS, Android System WebView)
- Server: `wrtc` package (native Node binding)

**Forbidden surface inside the feature:**
- Direct `BrowserWindow.*` or any Electron-only call
- Node `fs` outside the datastore abstraction
- Any persistent connection that assumes static IP/port

**Test parity:**
- CRDT merge correctness — pure JS unit tests, no runtime dependency
- Two-window-in-one-process integration test — replaces WebRTC with
  an in-process bus, exercises the full protocol incl. PDS
  emulation
- Runtime parity test — same feature loads under Electron and Tauri
  test harnesses; verifies the `api.network.webrtc` and `api.identity`
  contracts are sufficient

---

## Phasing

| Phase | Scope |
|---|---|
| 0 | `api.identity.*` portable surface; atproto OAuth provider; lazy auth UI inside collab-notes feature |
| 1 | `features/collab-notes/` scaffold; single-user Automerge note datastore; note UI (create, open, edit) — no network |
| 2 | Pairwise crypto handshake (X3DH + double ratchet) + WebRTC datachannel sync between two devices of the same user (validates the protocol on the simplest topology) |
| 3 | Multi-user (membership, per-note key, membership-rotation flow) |
| 4 | PDS-as-transient-queue (encrypted updates, clock acks, cleanup loop) — async support |

Each phase produces a shippable slice. Phase 0 in particular is
infrastructure that other features can consume independently of
collab-notes.

---

## Open questions

- **Conflict-of-membership semantics.** Two members concurrently
  remove each other while the network is partitioned: who wins?
  Automerge resolves the doc-level conflict deterministically, but
  the social outcome ("both removed each other") is unintuitive. May
  need a higher-level rule (e.g. owner role is sticky).
- **Invitation lexicon (proposal, not yet locked).** Dedicated
  lexicon `space.peek.collab.invite`, records published to sender's
  PDS, encrypted to recipient via the per-pair X25519 key, rkey
  HMAC'd same shape as signal/clock. Sender deletes the record once
  recipient acks acceptance (their first heads record covering the
  invite-injected `membershipSeq` bump). Open: does the value contain
  the per-note symmetric key directly, or just a pointer that the
  recipient pulls via the regular update flow once accepted? Resolve
  before Phase 3.
- **Mobile push-notification provider strategy.** Invites and
  collaboration activity want OS-level wake-ups on mobile so users
  don't miss them while Peek is backgrounded. Tauri's mobile push
  story is platform-specific (APNs for iOS, FCM for Android), and
  the "no Peek server" constraint complicates the typical token-
  registration flow (someone has to relay platform pushes). Options:
  user-provider's PDS could host a push-relay endpoint; or use
  Bluesky's existing push infra (if/when atproto formalizes it); or
  defer to v1.1 and rely on background-fetch polling. Resolve before
  mobile parity ships.
- **Key compromise + recovery.** If a user's device is compromised,
  what's the revocation story for their per-note keys? Membership
  rotation handles the forward case; what about already-issued
  ciphertext on their own PDS (which they no longer want to be
  decrypt-able by an attacker)?
- **PDS rate limits.** Update records + clock upserts hit
  `com.atproto.repo.putRecord` and `.deleteRecord` frequently during
  active editing. Bluesky's PDS has rate limits; Peek must coalesce
  writes (batched sync messages, throttled clock updates) to stay
  within them. The exact thresholds depend on the user's PDS host.
- **Large note initial sync.** First-time members joining an
  established note download the full Automerge document. Chunking
  via PDS blob storage (encrypted) may be needed beyond a size
  threshold.
- **Timing-correlation defenses.** Activity-cadence on the firehose
  fingerprints both individual users and groups, even with all rkeys
  HMAC'd and all content encrypted. Knobs available:
  - Coalescing window per peer (debounce writes during active
    editing). Already needed for PDS rate limits; double-counts as a
    timing mitigation.
  - Per-account publication jitter (randomized delay before commit).
    Trades latency for unlinkability across a user's identities.
  - Cover-traffic publications under the same lexicon. Highest cost,
    strongest defense. Defer beyond v1.
  Decision deferred to Phase 4; the protocol doesn't preclude any of
  these.

---

## Non-goals (v1)

- Multiple atproto accounts simultaneously editing the same note from
  one user (single account-per-Peek-profile is sufficient for v1, but
  the identity API supports it for later).
- Non-atproto protocols.
- Real-time presence indicators ("Alice is typing"). Possible v1.1.
- Conflict-free rich text formatting beyond what Automerge provides
  natively.
- An invitation UI flow — v1 may require sharing a note ID + DID out
  of band.
