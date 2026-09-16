# The worker credential — what authority a worker holds, and how it is bounded

Companion to `docs/workers-design.md`, which describes what a Peek worker is and settles that a
worker reaches Peek data through the `/mcp/*` API on `apps/server`. This document answers the
question that design left open: **what exactly does a worker hold, and what stops it doing more
than it declared?**

The short version, stated up front because the rest is the argument for it:

> Peek already has an object-capability system. It is `apps/desktop/main/tile-tokens.ts` plus
> `apps/desktop/main/tile-ipc-gate.ts`, and it works the way capabilities work inside one address
> space: an unforgeable opaque reference, an authority table the holder never sees, and a gate
> that consults the table on every call. The remote half — `mcp_grants` in
> `apps/server/grants.js` — has the same shape but a far poorer vocabulary: three fields, where
> the local side checks tables, topics and domains per call.
>
> So the work is not to adopt an object-capability scheme. It is to stop the remote half being a
> regression on the local half. That means the grant carries what the manifest already declares,
> the credential lives where feature code cannot reach it, and denied operations are absent
> rather than refused. None of that needs a token format, a signature, or a new dependency.
>
> A signed, offline-attenuable token — a macaroon, a UCAN, a biscuit — is **not recommended**,
> for a specific reason rather than a dismissive one: those schemes buy attenuation and
> verification without contacting the issuer, and in this system every call already contacts the
> issuer. Paying their costs to buy something already free is the wrong trade.

## Contents

1. [What Peek already has](#1-what-peek-already-has)
2. [The unforgeable reference](#2-the-unforgeable-reference)
3. [Attenuation](#3-attenuation)
4. [Delegation and revocation](#4-delegation-and-revocation)
5. [Removing ambient authority](#5-removing-ambient-authority)
6. [What this does to the generic-table question](#6-what-this-does-to-the-generic-table-question)
7. [Prior art, and why none of it is adopted](#7-prior-art-and-why-none-of-it-is-adopted)
8. [The staged path](#8-the-staged-path)
9. [Where this costs more than it is worth](#9-where-this-costs-more-than-it-is-worth)
10. [Open questions](#10-open-questions)

---

## 1. What Peek already has

Two capability systems exist in this codebase. They are not the same system, and the difference
between them is the whole problem.

### 1.1 The desktop: a capability table behind an opaque reference

`apps/desktop/main/tile-tokens.ts` `generateToken()` mints `tile-` followed by 24 random bytes and
stores a `TokenRecord` — `{ tileId, tileEntryId, grant, createdAt, ownerWebContentsId }` — in a
main-process `Map`. Its own comment states the property that matters: "Tiles never see the grant
directly."

That is the classic shape. The token is a *reference*; the authority is an object in a protected
space; the holder can exercise it but cannot read, copy, widen or forge it. The `CapabilityGrant`
it points at comes from `apps/desktop/main/tile-manifest.ts`
`resolveCapabilities(tileId, requested, isBuiltin)`, a pure function that reduces what a manifest
asked for to what policy allows — denying `pubsub.system` and `sync` to non-builtins, denying
`filesystem` outright to non-builtins, recording every refusal in `denied[]`.

`apps/desktop/main/tile-ipc-gate.ts` `runPipeline()` is the gate every `tile:<domain>:<verb>` frame
passes: payload schema (`validatePayload()`), token presence, token validity
(`getGrantForToken()`), sender-frame cross-check, declared required capabilities, lifecycle state
(a `stateProbe` against the FSM in `tile-fsm.ts`), and sender role (`roleForGrant()`). Rejections
go through `emitGateRejected()`, rate-limited to one publish per second per `(tileId, reason)`.

**Enforcement goes below the capability name, and this is the part worth carrying over.** The
manifest's declared tables, topics and domains are checked per call against actual arguments:

- `apps/desktop/main/tile-datastore-scope.ts` `validateTileDatastoreRequest(token, tables)` →
  `hasDatastoreTable()` tests every table named in a request against
  `grant.capabilities.datastore.tables`, and separately against a core `isValidTable()` allowlist
  so an injection-shaped name never reaches SQL. Every `tile:datastore:*` handler calls it.
- `tile:pubsub:publish` in `apps/desktop/main/tile-ipc.ts` matches the topic against
  `grant.capabilities.pubsub.topics` with a small glob matcher — exact, trailing `*`, leading `*`
  — with an `isInfraTopic()` carve-out routing `cmd:*` / `noun:*` through the `commands`
  capability instead.
- `apps/desktop/main/tile-network-enforcement.ts` `isNetworkDomainAllowed(grant, domain)` matches
  `grant.capabilities.network.domains` with `*.example.com` suffix wildcards.

Three weaknesses, named because a remote contract should not inherit them:

- **The capability check is mostly not in the pipeline.** `registerTileIpc()` accepts a
  `descriptor.requiredCapabilities`, but of the 215 registration sites in `tile-ipc.ts` only four
  use it, all four for `rules`. Every other channel gates itself inside its own handler body. That
  works, but "is this channel checked?" becomes a per-handler audit rather than a table anyone can
  read, and a newly added handler is unprotected by default rather than protected by default.
- **`TILE_STRICT` is off by default.** `apps/desktop/main/config.ts` reads it from the environment;
  `handleViolation()` throws only when it is on, and otherwise logs under `DEBUG`. The
  per-argument checks still return their error either way, so the enforcement is real — but a
  violation is close to silent in a normal run.
- **A violation never escalates.** `apps/desktop/main/tile-violations.ts`
  `publishCapabilityViolation()` publishes `tile:capability-violation` globally, rate-limited to
  one per `(tileId, capability, op)` per five seconds. Nothing revokes the token, unloads the tile,
  or counts repeats. A tile probing for authority it does not have can probe indefinitely.

### 1.2 The server: three fields and a bearer string

`apps/server/grants.js` `createGrant(userId, label, scopeTag, readonly, profileId)` mints a 32-byte
random key (`generateApiKey()`), stores only `hashApiKey()`'s SHA-256 of it, and returns the raw
key exactly once. `resolveMcpGrant()` looks a presented key up by hash, rejects a row with
`revoked_at` set, bumps `last_seen_at`, and returns the grant. `apps/server/auth.js`
`createMcpAuthMiddleware()` puts `userId`, `scopeTag`, `readonly`, `profileId` and `grantId` on the
request context, and every `/mcp/*` handler enforces from there.

The enforcement that exists is good, and this document is not arguing otherwise.
`apps/server/mcp-items.js` `scopeClause()` is a SQL `WHERE` fragment, not a post-filter, spliced
into every read before `GROUP BY`/`LIMIT`, so paging counts only in-scope rows. `getItemForRoute()`
resolves an id through `resolveItemId()` — itself scope-confined — then re-applies `scopeClause()`
in `fetchItemRowById()` as defence in depth. An out-of-scope id returns `not_found`,
indistinguishable from a genuine miss, so scope cannot be probed by comparing 404 to 200.
`readonly` is checked in exactly one place, `readonlyRefused()` in `apps/server/index.js`, as the
first line of each of the eight mutating routes, before the body is parsed.

What is missing is vocabulary and binding:

- **`scopeTag` + `readonly` + `profileId` is the entire authorization language.** No per-table,
  per-field, per-item-type or per-operation axis. `type` is a query filter, not a capability.
- **Possession of the bearer string is the whole of the authorization.** No expiry column, no
  client binding, no nonce, no proof of possession. `mcp_grants` holds
  `id, user_id, label, key_hash, scope_tag, readonly, profile_id, created_at, last_seen_at,
  revoked_at` and nothing else.

### 1.3 The comparison, which is the argument

| | tile token (desktop) | `mcp_grants` (server) |
|---|---|---|
| the reference | opaque, 24 random bytes, `Map` lookup | opaque, 32 random bytes, hash lookup |
| where authority lives | main-process `TokenRecord.grant` | an `mcp_grants` row |
| can the holder read its own authority? | no | no, but it is only three fields |
| vocabulary | tables, pubsub topics and scopes, network domains, window verbs and URL prefixes, shortcut keys, oauth providers, feature-source types | one tag, one boolean, one profile |
| checks below the capability name | yes — table, topic, domain, per call | none |
| bound to a holder | yes — `ownerWebContentsId`, trust-on-first-use | no |
| lifetime | dies with the tile (`revokeTokensForTile()`) | until an admin revokes |
| revocation | immediate, a `Map` delete | immediate, a `revoked_at` write |

Read the middle rows and the conclusion is not "Peek should adopt object capabilities". It is that
a worker, today, would hold a *less* capability-shaped credential than the same feature holds on
the desktop — and rented compute is exactly the setting where that regression matters most.

---

## 2. The unforgeable reference

**Decision: an opaque random string, resolved server-side, exactly as both existing systems already
do. Not a signed token.**

Unforgeability comes from entropy plus a lookup, not from a signature. `generateApiKey()` is 32
bytes of `crypto.randomBytes`; `generateToken()` is 24. Neither can be guessed, neither carries
readable claims, and neither can be edited into a wider one because there is nothing in it to edit
— the authority is a row, and the string is only a name for it. That is the strongest property in
either system and it survives unchanged.

Two things must be added around it.

### 2.1 The credential lives in the host, never in feature code

This is the single most important mechanic in this document, and the desktop already proves it.

In `apps/desktop/main/tile-preload.cts`, the tile token arrives through the `BrowserWindow`'s
`additionalArguments` and is captured in the preload's closure as `tileToken`. Every method on
`window.app` attaches it. Feature code — `background.js` — never has a reference to it, and cannot
obtain one, because `contextBridge.exposeInMainWorld` hands the renderer a bridged object rather
than the closure.

**The worker host must reproduce exactly this.** The credential is read from the runtime's secret
store by the host module, held in a closure, attached by the host's implementation of
`globalThis.app`, and never placed on any object the feature module can reach. In
`apps/desktop/features/mcp-server/store/remote-store.js` this is already true and already
correct: `openRemoteStore({ remoteUrl, credential })` captures `credential` as `token` and the
inner `request()` closure is the only thing that reads it. Its comment already commits to the
discipline — the token is "never logged, never included in an error message or a thrown stack" —
and the `unexpectedStatus()` and unreachable-server error paths honour it.

What this buys, stated precisely, because it is easy to overclaim: a worker running hostile code
**cannot exfiltrate its credential**. It can still exercise every authority the credential
carries, from inside the process, for as long as it runs. So the credential boundary bounds
*where* the authority can be used, not *how well* it is used. Which is the correct division of
labour: what a worker may do is the manifest's job (§3), whether the author is trustworthy is the
install decision's job, and neither is a token format's job.

### 2.2 The reference should be bound to its holder

The tile token is bound: `TokenRecord.ownerWebContentsId`, set by `setTokenOwner()` right after
`new BrowserWindow()`, with trust-on-first-use for `<webview>` guests whose id is not available at
mint time. `runPipeline()` compares it to `event.sender.id` and rejects a mismatch as
`sender-mismatch`. A stolen tile token is useless from another frame.

The grant credential has no equivalent, and that is the honest gap: it is a bearer string that
works from anywhere, forever, for anyone who obtains it — a deploy log, a crash dump, a backup of
the runtime's environment.

**The primitive to close it already exists in this repo.** `apps/desktop/main/atproto-proxy.ts`
`createDpopProof()` implements DPoP end to end with no library beyond `node:crypto`'s
`webcrypto.subtle`: an ES256 (P-256) keypair, a `dpop+jwt` header carrying the public JWK, a
payload of `{ jti, htm, htu, iat, exp: iat + 120, nonce?, ath }` where `ath` is
base64url(sha256(access token)) from `computeAth()`, and a full nonce-retry loop in
`performAtprotoRequest()` driven by `shouldRetryWithNonce()` off the server's `DPoP-Nonce` header.
`apps/desktop/features/lex/atproto.js` `generateDpopKeyPair()` generates the key.

So binding a worker credential to a key the worker holds is a **port of working code**, not a
research project: the worker generates a keypair at first boot, registers the public JWK against
its grant, and `request()` in `remote-store.js` — already the single chokepoint where the
`Authorization` header is set — signs each request. `createMcpAuthMiddleware()` verifies the proof
against the JWK stored on the grant row.

This is deliberately **not** in the first version (§8). It is named here so that "bearer string"
is a recorded, dated decision with a known upgrade path, rather than an oversight.

One caveat to carry forward: the existing DPoP private key is generated `extractable: true` and
persisted as JWK into the `feature_settings` table, so its `d` component sits in plaintext SQLite.
That is acceptable for a key on the user's own machine and is *not* acceptable as the model for a
key on rented compute. A worker's key should be generated non-extractable in the runtime and never
persisted — which also means it is regenerated on cold start, so the registration step has to be
cheap and idempotent.

And it leaves a bootstrap the design should not pretend away: registering a fresh public key is
itself an authorized call, so a worker still starts from something bearer-shaped held in the
runtime's secret store. Binding therefore narrows the exposure from "the credential is replayable
forever by anyone who reads it" to "the registration credential is replayable until it is
rotated", which is a real improvement and not a complete answer. The complete answer is a
long-lived registration credential that can *only* register a key, and a short-lived bound
credential that can do everything else — which is the shape atproto itself uses (§7.5).

---

## 3. Attenuation

**Decision: the manifest is the source of the restriction, `resolveCapabilities()` is the
reduction, and the server enforces it from the grant row. The restriction is not carried in the
credential.**

### 3.1 The manifest is already the right source

It exists, authors already write it, it is already validated, and it already has a policy layer.
`validateTileManifest()` enforces the shape and the limits — `MAX_TILES_PER_MANIFEST`,
`MAX_NETWORK_DOMAINS` (50), `MAX_DATASTORE_TABLES` (20). `resolveCapabilities()` applies policy:
`PRIVILEGED_CAPABILITIES` holds `filesystem`, `BUILTIN_ONLY_CAPABILITIES` holds `sync`, and
`pubsub.system` is builtin-only. Both are pure functions over plain data, already covered by
`apps/desktop/main/tile-manifest.test.ts`.

Inventing a second declaration for workers would mean two vocabularies for one concept, drifting.
This repo has already paid that bill once: `apps/server/schema.json` is recorded in
`handoff-mcp.md` as "a stale duplicate of `packages/schema/v1.json`", with the note that "changing
one and not the other is how they diverged."

**So `resolveCapabilities()` and the capability types move to a shared package** — alongside
`packages/schema` and `packages/sync`, which is the pattern this repo already uses for exactly this
problem — and both the desktop loader and the server's mint path call the same function. If the
reduction lives in two places it will diverge, and the divergence will be silent and
security-relevant, which is the worst combination.

### 3.2 Enforced by the server, from the row

`mcp_grants` gains one column: the resolved `CapabilityGrant`, stored as JSON, written at mint time
by running the shared `resolveCapabilities()` over the worker's manifest.
`createMcpAuthMiddleware()` sets it on the request context beside `scopeTag` and `readonly`, and
handlers check against it.

Why in the row rather than in the credential:

- **The verifier is the issuer.** Every `/mcp/*` call reaches `apps/server`, which minted the grant
  and owns the database. A credential that carries its own restrictions exists so a verifier who is
  *not* the issuer can check them without asking. There is no such verifier here.
- **The database is consulted anyway.** `resolveMcpGrant()` already does a hash lookup on every
  request to check `revoked_at`. Reading one more column from a row already being read is free. A
  signed token would add signature verification *and still need* that lookup, because revocation
  cannot be read off a token.
- **Narrowing takes effect immediately.** A manifest that removes a table produces a narrower grant
  at the next deploy, and the old authority is gone the moment the row is rewritten. With a carried
  restriction, previously-issued credentials keep their old, wider text until they expire.

### 3.3 What the checks look like

The same shape the desktop already uses, moved behind HTTP — each a small pure predicate over the
grant, mirroring an existing one:

| Desktop | Server equivalent |
|---|---|
| `hasDatastoreTable(grant, table)` | table check on any generic-table route (§6) |
| pubsub topic glob in `tile:pubsub:publish` | topic check on the worker pubsub channel |
| `isNetworkDomainAllowed(grant, domain)` | no server involvement — see below |
| `readonlyRefused(c)` | unchanged; already correct |
| `scopeClause(scopeTag, alias)` | unchanged; already correct |

Two honest gaps in that table:

- **`network` cannot be enforced by the server**, because the server is not in the path when a
  worker calls `fetch()`. `docs/workers-design.md` already records this: the host must replace the
  global, or `capabilities.network.domains` is a disclosure rather than a control. This is the one
  capability whose enforcement genuinely sits on the untrusted side, and no credential design fixes
  it.
- **`createTables` is a dead declaration.** `DatastoreCapability.createTables` is parsed by
  `validateTileManifest()` and copied into the grant by `resolveCapabilities()`, and no handler
  anywhere consults it. It should be removed rather than ported, so the remote vocabulary does not
  start life with a field that means nothing.

### 3.4 Where the check belongs

In the middleware chain, not in the handler bodies. The first weakness named in §1.1 is that the
desktop's checks live in 215 handlers of which four declare what they need, so a new handler is
unprotected until someone remembers. The server has the chance to do the opposite: a route declares
the capability it requires at registration, and a route that declares nothing is refused rather
than allowed. Hono middleware makes this cheap, and `readonlyRefused()` already proves per-route
gates work here — it just has to become declarative rather than a call someone might forget to
write.

---

## 4. Delegation and revocation

### 4.1 Delegation: the server mints, nobody attenuates client-side

**Decision: a worker that wants to hand out a narrower capability asks the server for one. It
cannot make one itself.**

The mechanism is a new row with a parent. `mcp_grants` gains `parent_grant_id`; a
`POST /mcp/grants/derive` route takes a requested capability set, checks it is a subset of the
caller's own, and mints a child. The subset check is the same shared `resolveCapabilities()`
reduction from §3.1, applied with the caller's grant as the ceiling instead of the policy defaults.

Two things in `docs/workers-design.md` need this:

- **An agent calling in.** `call_worker` should not hand the agent the worker's authority. What the
  agent gets is a child grant carrying only the command it invoked and the results of that command.
- **A worker calling a worker.** Ruled out of scope in the design for good reasons — cycles,
  cold-start storms, unbounded fan-out — but if it ever arrives, the credential model should not be
  the thing that blocks it.

Client-side attenuation, which is the property macaroons and UCANs exist to provide, buys neither,
because the party that would attenuate offline is talking to the issuer anyway.

### 4.2 Revocation is where a database wins outright

This is the strongest argument in the document, and it is worth being blunt: **the existing bearer
grant already has the best revocation story available**, and every token scheme in §7 is worse at
it.

`revokeGrant(userId, grantId)` writes `revoked_at` and the credential is dead on the next request —
immediate, complete, no expiry to wait out, no revocation list to distribute, no cache to bust.
`resolveMcpGrant()` already checks it. The desktop mirror, `revokeToken()` /
`revokeTokensForTile()`, is a `Map` delete with the same property.

With `parent_grant_id` in place, revocation becomes transitive for free: revoking a grant revokes
its subtree with one recursive query. A scheme that attenuates offline cannot offer that, because
the issuer never learned the child existed.

Four triggers, each of which should be wired rather than assumed:

| Trigger | Action |
|---|---|
| worker uninstalled | revoke the grant and its subtree — the analogue of `revokeTokensForTile()` |
| manifest narrowed | rederive the grant from the new manifest; the row is rewritten, not edited, so removed authority is gone at the next deploy |
| manifest widened | mint nothing automatically — a widening is a fresh consent decision, matching how `PRIVILEGED_CAPABILITIES` already requires explicit approval |
| compromise | revoke; the subtree goes with it |

The second row is the one most likely to be got wrong. A grant must be **derived from the manifest,
never edited in place**, so the row and the manifest cannot disagree. `describe()` and
`/mcp/session` already exist to catch it when they do — `docs/mcp-remote-backend-design.md` §4.3
has startup refuse to serve when the on-disk config claims a scope the store disagrees with, and
the same check should cover the capability set.

### 4.3 What is still missing without expiry

`mcp_grants` has no `expires_at`. For a credential held by a long-lived install that is defensible;
for one sitting in a rented runtime's environment it is weak, because the window between a leak and
someone noticing is unbounded. Adding an expiry with a refresh is cheap and is listed in §8's second
stage. It is not first-version work only because revocation already covers the case where someone
*knows*.

---

## 5. Removing ambient authority

Four concrete changes, each making "the credential is the authority" true rather than aspirational.

### 5.1 `openStore()` returns only what the grant permits

Today `PeekStore` in `apps/desktop/features/mcp-server/store/types.js` is a flat interface of
seventeen methods, and every holder of a store object can call all of them. A worker granted only
items can still call `listTags()`; a readonly worker can still *call* `createItem()` and gets a 403
back. That is ambient authority one layer below the credential — the object confers more than the
grant does, and only the far end says no.

**Decision: `openStore()` builds the object from the grant. A method the grant does not permit is
absent, not a rejecting stub.**

This is the decision `docs/workers-design.md` makes about `api.window` and `api.shortcuts` being
`undefined` rather than stubbed, applied one layer down and for the same reason: a `TypeError` at
the call site is a better failure than a plausible negative answer the caller carries onward. It
also makes the authority *legible* — a worker can enumerate what it holds by looking at the object
it was handed.

The mechanism already exists. `describe()` calls `GET /mcp/session`, which returns what the server
believes about the grant. Adding the capability object to that response is a few lines in
`apps/server/index.js`, and it becomes the input `openStore()` builds from. One ordering
consequence: `describe()` stops being an optional consistency check and becomes a required
bootstrap call, because nothing else can tell the client what to construct.

### 5.2 `StoreConfig.scopeTag` and `readonly` become hints, explicitly

`StoreConfig` in `types.js` carries `scopeTag` and `readonly` as client configuration. They must
never be read as authorization — `docs/mcp-remote-backend-design.md` §4.2 already argues this — but
the typedef does not say so, and an implementer reading only the types would not know. Two changes:
document them as fail-fast hints whose only job is to disagree loudly with `/mcp/session`, and have
`openRemoteStore()` refuse to open on a disagreement rather than silently preferring one.

### 5.3 The `/mcp/*` vocabulary grows past three fields

`createMcpAuthMiddleware()` sets `scopeTag`, `readonly`, `profileId`, `grantId`, `userId`. It gains
`capabilities`. Routes that today check nothing beyond scope gain a declared requirement (§3.4).
This is the bulk of the actual work, and it is ordinary route work rather than cryptography.

### 5.4 `createGrant()` stops taking a fixed five-tuple

`createGrant(userId, label, scopeTag, readonly, profileId)` hard-codes the whole authorization
vocabulary into its signature. It becomes `createGrant(userId, label, { capabilities,
parentGrantId, expiresAt })`, with `scopeTag` and `readonly` as members of the capability object
rather than peers of it. `resolveMcpGrant()` returns that object; `listGrants()` surfaces it, so an
admin sees what a grant can actually do rather than three fields that no longer describe it.

One thing that must not change: the separation of credential namespaces `apps/server/grants.js`
already enforces. Its comment explains it — a device key and a grant key never resolve against the
same table, "so one credential can never serve both the sync routes and `/mcp/*`", because "a
device is unscoped by nature". A worker credential is a third namespace and should stay one. The
reasoning that keeps a phone's sync key from being a whole-store MCP key is exactly the reasoning
that keeps a worker's grant from being either.

---

## 6. What this does to the generic-table question

`docs/workers-design.md` left this fork: add capability-scoped table routes to `/mcp/*`, or declare
a worker's datastore items-and-tags-only and accept that features keeping state elsewhere cannot be
workers.

**The fork was mis-framed, and looking at the schema dissolves most of it.**

`api.datastore.getRow` / `setRow` / `getTable` do not create tables. `apps/desktop/main/datastore.ts`
declares a fixed schema — `items`, `item_tags`, `item_events`, `item_visits`, `item_groups`,
`item_group_members`, `tags`, `content`, `blobs`, `settings`, `feature_settings`, `scripts_data`,
`feeds`, `themes`, `rules`, `manifest_cache`, `features_history`, `lazy_wake_shortcuts`,
`lazy_wake_declared`, `migrations` — and `hasDatastoreTable()` checks a requested name against both
the grant's list and a core `isValidTable()` allowlist. There is no bring-your-own-table facility;
`createTables` is the dead flag from §3.3.

So "generic table access" means "reach one of a fixed set of shared tables", and that splits into
two questions with different answers.

**Per-worker private state does not want a table at all.** `feature_settings(id, featureId, key,
value, updatedAt)`, with a unique index on `(featureId, key)`, is already the per-feature key-value
store, reached through `api.settings` and `api.extensions.getSettings`. It is confined by
construction: the row key *is* the feature id, so a grant naming one worker cannot address
another's rows, and no capability list is needed to make that true. This is the cleanest
object-capability shape in the codebase and it already exists. The work is to port the table to
`apps/server` — whose `settings` table is a flat global `(key, value)` holding `datastore_version`,
not a per-feature one — and expose it as a route whose feature id comes from the grant and never
from the request.

**Shared tables are a per-table decision the grant can already express.** `rules`, `themes`,
`item_groups` and the rest hold state with real cross-feature meaning. Each one a worker needs gets
a server-side equivalent and a route gated on `capabilities.datastore.tables` — the same predicate
`hasDatastoreTable()` already implements — added one at a time, when a feature needs one.

**So the security objection to the "add table routes" branch disappears**, because the manifest can
name exactly which tables and the grant can carry that. What remains is a plain schema-design cost:
`apps/server` has five tables (`items`, `tags`, `item_tags`, `item_events`, `settings`) against the
desktop's twenty, and every one a worker needs is a schema addition, a sync decision, and a row in
`docs/sync-coverage-gaps.md`. Real work, but ordinary work, and incremental instead of a gate on
the whole worker design.

**Revised answer to the fork:** neither branch. A first worker gets items, tags and events, which
exist, plus per-worker private state through a ported `feature_settings`, which is small,
self-confining, and unblocks the common case. Shared tables arrive individually, on demand, gated
on the declaration the manifest already carries.

---

## 7. Prior art, and why none of it is adopted

Everything below was fetched on 2026-08-18. Two provenance caveats, recorded because a security
argument that cites a source it did not read is worse than one that admits the gap:

- **`erights.org` was unreachable** (connection refused on every path). The object-capability
  claims here come from a mirror of "Capability Myths Demolished" (Miller, Yee, Shapiro, dated
  2003-01-27) at `papers.agoric.com/assets/pdf/papers/capability-myths-demolished.pdf`, read
  through a text-extraction proxy, plus the Wikipedia articles on the object-capability model and
  ambient authority. Treat the wording as high-confidence rather than byte-exact.
- **`biscuitsec.org`'s apex domain was unreachable and its revocation page returned 403.** Biscuit
  claims come from `doc.biscuitsec.org` and `SPECIFICATIONS.md` in `github.com/biscuit-auth/biscuit`.
  Its revocation-list *distribution* story is therefore **unverified**, not absent.

### 7.1 What the object-capability model actually asks for

Ambient authority is defined as "authority that is exercised, but not selected, by its user" — a
request that succeeds by naming a resource, with nothing accompanying it that says which permission
authorized it. The connectivity rule is "an object A can send a message to B only if object A holds
a reference to B", summarised as "only connectivity begets connectivity."

Two things follow that are directly useful here.

**Peek's desktop model already satisfies the definition.** A tile cannot name a table it was not
granted, because `hasDatastoreTable()` consults the grant behind the token rather than the tile's
own claim about itself. The authority is designated by the reference, not by the resource's name.

**And the literature's own answer to revocation is exactly what a grant row is.** The paper is
explicit that "capabilities themselves are not literally revocable"; revocable access is built by
indirection — a forwarding facet handed to the holder, backed by a revoking facet the grantor
keeps, so severing the second kills the first while the holder still possesses it. A credential
string that means nothing without a live row in `mcp_grants` *is* that pattern: the string is the
forwarder, `revokeGrant()` is the revoker. Peek is not choosing convenience over the model here; it
is implementing the model's own recommended construction with a database.

One correction to a common shorthand: the paper distinguishes object capabilities from access
control lists with **seven** properties, not three — the extraction surfaced them as no designation
without authority, dynamic subject creation, subject-aggregated authority management, no ambient
authority, composability of authorities, access-controlled delegation channels, and dynamic
resource creation. The letter-to-name pairing came through a PDF proxy and should be checked
against the original before anyone quotes it as a checklist.

### 7.2 Macaroons

"Macaroons: Cookies with Contextual Caveats for Decentralized Authorization in the Cloud",
Birgisson, Politz, Erlingsson, Taly, Vrable and Lentczner, NDSS 2014
(`research.google/pubs/macaroons-cookies-with-contextual-caveats-for-decentralized-authorization-in-the-cloud/`).

Mechanism: "nested, chained MACs (e.g., HMACs)". Each caveat appends a predicate and re-MACs, with
"the signature… the MAC of the pair vId :: cId, using the existing signature as the MAC key", which
`github.com/rescrv/libmacaroons` summarises as making it "really easy to add a caveat, but
impossible to remove a caveat". Attenuation needs nobody: "new, more restricted authorization
credentials can be directly derived from macaroons, without proxying requests to the target
service, or re-minting new credentials from it."

The two facts that decide it for Peek:

- **Verification is issuer-only anyway.** "Only the target service that originally mints a macaroon
  can check its validity. Specifically, the verification of an HMAC-based macaroon requires
  knowledge of its root key." So a macaroon does not buy third-party verification — it buys
  *offline attenuation* against a verifier who is still the issuer. Peek's verifier is the issuer,
  and Peek has no party that wants to attenuate without asking.
- **Revocation is left to the caller.** The paper enumerates four approaches rather than providing
  one: "(i) using very short-lived credentials, (ii) allowing the addition of freshness
  constraints, (iii) relying on external, authoritative state (such as revocation lists, or epoch
  counters), and (iv) splitting credentials". `libmacaroons`'s README does not discuss revocation
  at all. Option (iii) is a database, which Peek already has and already consults.

### 7.3 UCAN

`github.com/ucan-wg/spec`, v1.0.0. DAG-CBOR envelopes with `iss` / `aud` / `sub` / `cmd` / `args` /
`nonce` / `exp`, signed with DID keys: "A UCAN is signed by the sender (the `iss` field DID) and can
only be created by an agent in possession of the relevant private key." Delegation chains validate
locally, narrowing only — "Every unique delegated capability MUST have equal or narrower
capabilities from their delegator."

Revocation is a **separate specification** (`github.com/ucan-wg/revocation`, v1.0.0-rc.1) built on
append-only revocation stores keyed by canonical CID, deliberately partition-tolerant and
gossip-propagated: a server "MAY have an endpoint that lists the revoked UCANs by canonical CID", a
CRDT filesystem "SHOULD maintain the revocation store directly at a well-known path", and
revocations may arrive before the delegation they revoke. It also fixes that "Revocations MUST NOT
be reversible" — an erroneous revocation is repaired by issuing a fresh delegation, not by undoing.

For a single-user personal store served by one server, this is a large amount of distributed-systems
machinery to reproduce what `revoked_at` already does synchronously and reversibly.

One genuinely relevant idea to borrow without the format: the command-hierarchy check —
`delegation[n+1].cmd` must extend `delegation[n].cmd` — is the subset test §4.1 needs, and Peek can
run it against rows. (Provenance note: that formulation was found in the `ucan-wg/rs-ucan`
implementation's design notes rather than in the canonical spec README.)

### 7.4 Biscuit and SPKI/SDSI

**Biscuit** (`doc.biscuitsec.org`, `github.com/biscuit-auth/biscuit` `SPECIFICATIONS.md`) is
"an authorization token that is signed with public key cryptography (like JWT)", an append-only
Ed25519 block chain carrying Datalog checks, with "offline attenuation (like Macaroons)" and
genuine third-party verification — "any verifier for the token needs only to know the corresponding
public key". Revocation is a `revocation_id(<index>, <byte array>)` fact per block that a verifier
compares against externally supplied revocation lists; the fetched specification defines the
identifier and not how such lists are distributed. Biscuit is the most attractive of the three on
technical merit and remains the wrong fit for the same reason as the others: its headline features
are offline attenuation and public-key verification, and Peek needs neither.

**SPKI/SDSI**, RFC 2693 (September 1999,
`rfc-editor.org/rfc/rfc2693`), is worth a paragraph because its framing is the right one and its
mechanism is not. It is authorization-first rather than identity-first — "the application needs to
know if the keyholder is authorized for some access. This is the primary job of a certificate" —
reducing credentials to a five-tuple of issuer, subject, a delegation boolean, an authorization
S-expression, and validity dates. Delegation is that single boolean, not a narrowing algebra.
Revocation is timed CRLs with non-intersecting validity ranges. The RFC describes itself as giving
"the theory behind SPKI certificates… without going into technical detail", and notes that "the
world is not going to switch to SPKI certificates overnight". Peek's `mcp_grants` row, extended per
§3 and §4, is a five-tuple of the same kind with the delegation boolean replaced by a parent
pointer — which is the useful half of the idea without the certificate format.

### 7.5 atproto, which is already in this repo

Worth a section of its own because the dependency is already present and the primitives are already
written.

**DPoP is implemented.** `apps/desktop/main/atproto-proxy.ts` `createDpopProof()` builds and signs
a `dpop+jwt` with ES256 (P-256) via `node:crypto`'s `webcrypto.subtle` — no `jose`, no
`jsonwebtoken`, neither of which is a dependency anywhere in the repo — carrying
`{ jti, htm, htu, iat, exp: iat + 120, nonce?, ath }`, with `computeAth()` producing the
access-token hash and `shouldRetryWithNonce()` driving the server-nonce retry loop in
`performAtprotoRequest()`. `apps/desktop/features/lex/atproto.js` does full PKCE (S256) plus a
Pushed Authorization Request on top of it. This is the §2.2 binding primitive, already working.

**atproto's own permission vocabulary is close to Peek's manifest.** `atproto.com/specs/permission`
types permissions by resource — `repo`, `rpc`, `blob`, `account`, `identity`, and a meta-resource
`include` — and states that "each resource type has a defined set of parameters that can attenuate
the permission": `repo` takes a required `collection` list and an optional `action` subset of
create/update/delete; `rpc` takes a required `lxm` list of method NSIDs and an `aud` service
reference. That is per-resource-type, per-operation attenuation with a positional required
parameter — structurally the same idea as `datastore: { tables: [...] }` and
`window: { create, query, manage, urls }`, and worth reading before extending Peek's own vocabulary,
since the shape has been thought about carefully by people solving the same problem.

**And atproto's answer to inter-service authority is the one this document recommends.**
`atproto.com/specs/xrpc` documents inter-service authentication as a JWT signed with "the account's
signing key (the same used to sign repo commits)", bound by an `lxm` field — "short for 'lexicon
method'… Indicates the endpoint that this token authorizes" — and required "for all authenticated
XRPC endpoint requests". The lexicon
`com/atproto/server/getServiceAuth.json` adds a required `aud` audience DID and an optional `exp`
that "defaults to 60 seconds". The spec's own note on why: "Should be a short time window, as
revocation is not implemented. 60 seconds is a good token lifetime."

Read that alongside §4.2. atproto, having built the signed-token machinery, chose **server-issued,
narrowly-bound, short-lived tokens** rather than client-side attenuation — and had to accept "no
revocation" as the cost. Peek is in the strictly better position of already having revocation, and
should not trade it away.

The `lxm` idea itself is worth stealing for §4.1's derived grants: a child grant minted for an
agent's `call_worker` should name the single command it authorizes, and expire in seconds.

### 7.6 The decision, in one table

| | needs a verifier who is not the issuer | needs offline attenuation | needs delegation without the issuer | revocation |
|---|---|---|---|---|
| Peek's actual requirements | no | no | no | must be instant, certain, reversible |
| Macaroons | no (issuer-only by construction) | yes | yes | external — four suggested approaches |
| UCAN | yes | yes | yes | a separate spec, gossiped stores, irreversible |
| Biscuit | yes | yes | yes | identifier defined, distribution unverified |
| SPKI/SDSI | yes | partly | boolean only | timed CRLs |
| a grant row | — | — | — | one `UPDATE`, effective on the next request |

Every row but the last buys properties Peek does not need, and every one of them is worse at the
single property Peek does need.

**One thing worth conceding.** Signed tokens are strictly better in a world where `apps/server` is
not the only verifier — a second Peek backend, a federated instance, a worker runtime that wants to
check authority before making a request. None of those exist. If one arrives, the migration is real
work, and §3.2's decision is the one that would have to be revisited. That is a known, dated
tradeoff rather than an oversight.

---

## 8. The staged path

### 8.1 What a first worker genuinely needs to be safe

All of it is rows, closures and route guards. No cryptography, no new dependency, no token format.

1. **The host holds the credential; feature code never sees it.** (§2.1) The pattern is
   `tile-preload.cts`'s closure over `tileToken` and `openRemoteStore()`'s closure over
   `credential`. This is the highest-value item and it is nearly free, because both existing
   implementations already do it — the requirement is that the worker host not undo it.
2. **The grant row carries the resolved manifest capabilities.** (§3.2) One JSON column on
   `mcp_grants`, written at mint time by the shared `resolveCapabilities()`, put on the request
   context by `createMcpAuthMiddleware()`.
3. **`resolveCapabilities()` and the capability types move to a shared package.** (§3.1) Without
   this, the desktop and the server reductions drift, exactly as `apps/server/schema.json` drifted
   from `packages/schema/v1.json`.
4. **`openStore()` returns only the permitted methods.** (§5.1) Requires the capability object on
   `GET /mcp/session`.
5. **Routes declare the capability they require, and an undeclared route is refused.** (§3.4)
6. **Grant lifetime is tied to the install** — minted on install, revoked on uninstall, rederived
   on a manifest change. (§4.2)
7. **One grant per worker.** Never shared between workers, never a device key, never the user key.
   The namespace separation `grants.js` already enforces extends to a third namespace.

Everything above is a precondition for running *anyone's* feature code remotely, which
`docs/workers-design.md` settles as the destination: third-party features can be workers, gated on
the publisher verification in `apps/desktop/main/atproto-verify.ts`. The first version runs bundled
features only, and during that stage items 1, 2, 4 and 6 carry most of the value, because they are
what makes a mistake in a trusted feature bounded rather than total.

### 8.2 Second stage, once a first worker runs

- **Holder binding** via the DPoP primitive already in `atproto-proxy.ts` (§2.2), with the
  registration-credential caveat that section records.
- **Expiry and refresh** on `mcp_grants` (§4.3).
- **Derived grants** — `parent_grant_id`, a subset check, `POST /mcp/grants/derive` — which is what
  makes `call_worker` safe to expose to an agent (§4.1).
- **Short-lived, single-command child grants** for agent invocation, taking the `lxm` idea from
  atproto's inter-service auth (§7.5).
- **Violation escalation**, which the desktop also lacks (§1.1): count violations per grant and
  revoke on a threshold, rather than publishing an event nobody reads.

### 8.3 Probably never

- Macaroons, UCANs, biscuits, or any offline-attenuable signed token, unless a verifier appears
  that is not the issuer (§7.6).
- Per-field authorization. `scopeTag` plus per-table plus readonly is already finer than anything
  Peek's data model distinguishes.
- A policy language. Biscuit's Datalog is the right tool for a system with many resource kinds and
  many principals. Peek has one user.

---

## 9. Where this costs more than it is worth

Stated plainly, because a design that only lists benefits has not been thought about.

**The sequencing risk this section used to raise is closed.** The open question was whether the
server-side vocabulary of §5.3 defends against a threat anyone had accepted: if only features
shipped in the app could ever be workers, the code holding the credential is code the same people
wrote, and a capability system defends against in-house bugs rather than against intent. Third-party
features can be workers, so the vocabulary is earned and the question of building it against a
hypothetical threat does not arise.

What remains is a staging cost rather than a design risk. The first version runs bundled features
only, so the vocabulary is built before the population it defends against exists, and §8.1 item 4
— a wrong method call surfacing as a `TypeError` rather than a silent 403 — is most of what it buys
in the interim.

**Per-argument enforcement has a real ongoing cost.** The desktop's version is 215 handlers with
their checks written by hand, and §1.1 records what that produced: four handlers declaring their
requirements and the rest self-policing. Repeating the pattern server-side means every new `/mcp/*`
route is a place to forget a check. §3.4's declarative middleware is the mitigation and it is not
free either.

**Shared-package extraction is real, but not because of Electron coupling.**
`apps/desktop/main/tile-manifest.ts` imports only `node:fs` and `node:path`, both used by
`parseManifestFile()` alone — nothing in the tile layer touches Electron, and that is a property
the design keeps by intent rather than by accident: a tile's manifest describes what it may do,
and the host enforcing it is meant to be replaceable, which is exactly what a worker runtime
depends on. The real obstacles are the module system split (`apps/desktop` is TypeScript ESM;
`apps/server` declares `"type": "commonjs"` and sits outside the root `workspaces` list) and the
deployment boundary — `apps/server` is subtree-split and deployed standalone, so it can't import
`packages/` at runtime and carries its own copy instead (see the comment atop `apps/server/db.js`).
The precedent already in this repo, `packages/schema/v1.json` projected into
`apps/server/schema.json` by `packages/schema/codegen.js` and guarded by
`packages/schema/check-freshness.js`, projects *data*; the capability model is *logic*, and
closing that gap is the extraction: `packages/capabilities` holds the model as plain JavaScript
with hand-written `index.d.ts` types (`apps/desktop/main/tile-manifest.ts` re-exports it
unchanged), and `packages/capabilities/codegen.js` generates the checked-in CommonJS
`apps/server/capabilities.js` the same way the schema package generates its own projection.

**And the thing none of this fixes: a worker misusing what it legitimately holds.** A feed worker
granted `network: { domains: ["*"] }` and read access to items can post the user's items anywhere
it likes, and every check in this document passes. Narrowing `domains` helps only if authors
narrow it, and `feeds` today declares `["*"]`. The defences against that are provenance — which
this repo already has and which is stronger than expected, since
`apps/desktop/main/atproto-verify.ts` verifies a publisher's commit signature against the key that
was active at the commit's `rev` via the PLC audit log, walks the MST to the record, and re-hashes
every block, with "no unverified fallback" — plus the install-time consent decision, plus
revocation. A credential design contributes the third of those three and should not be sold as
contributing the first two.

---

## 10. Open questions

1. **Does the manifest need a worker-specific capability vocabulary at all, or is the tile one
   enough?** §3.1 assumes reuse. But several capabilities are meaningless remotely (`window`,
   `shortcuts`, `izui`) and at least one remote concern has no local equivalent — how much a worker
   may spend, in requests or wall time. **Settled by:** writing the manifest for one real worker
   and seeing what is missing.

2. **What is the ceiling for a derived grant, exactly?** §4.1 says a child must be a subset of its
   parent, computed by the shared reduction. "Subset" is obvious for `tables` and `topics` and
   unclear for `scopeTag` — is a child scoped to `work:project` a subset of a parent scoped to
   `work`? `scopeClause()` already treats `<scope>:`-namespaced child tags as in scope, which
   suggests yes, but that is a read-path convention, not a stated rule about authority.
   **Settled by:** writing the subset predicate and its tests, at which point the ambiguity becomes
   unavoidable.

3. **Where does the worker's registration credential live, and who can read it?** §2.2 narrows
   bearer exposure without eliminating it, and §8.1 leaves the credential in the runtime's secret
   store. Cloudflare secrets bindings and celld's operator environment have different properties,
   and `docs/worker-runtime-portability.md` makes both adapters behind one host contract, where
   reading the credential is a named operation (`readCredential`) whose implementation is the
   platform's secret storage — a 0600 file on a bare Node process, a secret binding on Cloudflare.
   **Settled by:** deciding whether a worker's grant is per-deployment or per-install — which is
   really the question of whether a hosted Peek runs everyone's workers in one account.

4. **Should the desktop adopt the fixes this document proposes for the server?** §1.1's three
   weaknesses — checks in handlers rather than the pipeline, `TILE_STRICT` off by default, no
   escalation — are desktop problems that a worker design has no business fixing, but they are also
   the reason the server should not copy the pattern. **Settled by:** a separate decision, on the
   desktop's own timeline. Named here so the divergence is deliberate rather than accidental.

5. **Does `feature_settings` sync?** §6 makes a ported `feature_settings` the answer for
   per-worker private state, which means a worker's state has to reach the desktop like anything
   else. `docs/sync-coverage-gaps.md` is the inventory and does not currently cover it.
   **Settled by:** the same policy call that owns every other `"sync": false` decision.

6. **What happens to a running worker when its grant is revoked mid-flight?** §4.2 makes revocation
   effective on the next request, which is correct for the credential and says nothing about the
   instance. A worker mid-alarm-handler will start getting 401s from a store it opened successfully.
   `remote-store.js` currently treats a non-transport HTTP error as a thrown tool error, which is
   probably right, but nothing tells the runtime to stop rescheduling the worker. **Settled by:**
   deciding whether revocation also cancels the schedule, which is a runtime-control-plane
   question rather than a credential one.
