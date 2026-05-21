# atproto Record Signature Verification Plan

## Gap

`apps/desktop/main/atproto-source.ts:356` fetches a `space.peek.feature.release`
record via `com.atproto.repo.getRecord` and accepts whatever the PDS returns.
No signature is checked. `verifyBlobCid()` (line 502) only confirms that the
downloaded bundle bytes hash to the CIDs **declared by that record** — if the
record itself was forged, the CIDs inside it can be anything.

A compromised PDS (or a malicious party who controls the PDS answering for a
DID) can:

1. Serve a forged record with CIDs that point at tampered bundle blobs.
2. Serve those tampered blobs when the client calls `com.atproto.sync.getBlob`.
3. The client's CID check passes because the CIDs in the forged record match
   the tampered bytes.

Today's trust boundary is TLS to the PDS, not the publisher's signing key.

## How atproto signatures actually work

Atproto does not sign records individually. It signs the **commit** at the
top of the repo's Merkle Search Tree (MST). Record trust is transitive via
MST inclusion.

### Commit object

```
commit {
  did,             // the author's DID
  version,         // repo format version (currently 3)
  data,            // CID of the MST root
  rev,             // tid — monotonic revision id
  prev,            // CID of the previous commit (or null)
  sig,             // raw signature bytes
}
```

The signed message is `dag-cbor(commit-with-sig-field-removed)`. The signature
is low-S ECDSA over SHA-256 of that encoding. Non-low-S signatures MUST be
rejected.

### Signing key

- `did:plc` → `https://plc.directory/<did>` returns the DID document. The
  `verificationMethod` entry with id `#atproto` carries the repo signing key
  as `publicKeyMultibase`.
- `did:web` → `https://<host>/.well-known/did.json`, same entry.
- The multicodec prefix on the multibase-decoded key identifies the curve:
  - `0xe7 0x01` → secp256k1
  - `0x80 0x24` → P-256

### MST inclusion

Each MST node is dag-cbor. Leaves hold `{key, value: CID}` pairs. Re-hashing
a node's encoding must produce the CID the parent node points at. Record
trust = "commit is valid AND the record's CID appears at the correct leaf
under commit.data."

## Verification steps the client must perform

1. **Resolve DID → DID doc.** Extract PDS endpoint AND the `#atproto`
   signing key.
2. **`com.atproto.sync.getLatestCommit(did)`** → `{cid, rev}`.
3. **`com.atproto.sync.getBlocks([commitCid])`** → raw CBOR of the commit.
4. **Verify commit signature.**
   - Decode commit CBOR.
   - Extract `sig` field.
   - Re-encode the commit minus `sig` as dag-cbor → message.
   - ECDSA-verify `(sha256(message), sig, publicKey)` using the curve
     indicated by the multicodec prefix. Enforce low-S.
   - If fail → abort install.
5. **Walk MST from `commit.data`** to the leaf keyed by
   `space.peek.feature.release/<rkey>`. At each node, fetch via `getBlocks`,
   re-hash, confirm against the parent's CID. If any hash mismatches → abort.
6. **Cross-check record CID.** The leaf's `value` CID must match the CID of
   the record bytes returned by `getRecord` (or preferably: skip `getRecord`
   entirely and fetch the record CBOR via `getBlocks` at the leaf's value
   CID, then validate its schema).
7. **Now `verifyBlobCid()` closes the chain.** Publisher's key → commit
   signature → MST inclusion → record CID → blob CIDs → blob bytes.

## Implementation approach

### Library

`@atproto/crypto` (npm, maintained by Bluesky) gives us:
- Parsing of `publicKeyMultibase` for both curves
- Low-S ECDSA verification for secp256k1 and P-256

That's the smallest reasonable dependency. The MST walker is small enough to
hand-roll against the spec if we want to keep the install path lean; otherwise
`@atproto/repo` has one. Decision: **vendor `@atproto/crypto` only, hand-roll
MST walk**, to keep the install path's dependency surface tight.

### File layout

- `apps/desktop/main/atproto-verify.ts` — new module:
  - `resolveSigningKey(did): {curve, publicKey}` — DID doc fetch + key
    extraction.
  - `fetchSignedCommit(pdsUrl, did): {commit, commitCid, sig, signedBytes}`.
  - `verifyCommitSignature(signedBytes, sig, signingKey): boolean`.
  - `verifyRecordInclusion(pdsUrl, commit, collection, rkey): recordCid`.
  - `fetchAndVerifyRecord(atUri): verifiedRecord` — the public entry point
    the installer calls instead of `getRecord`.
- `apps/desktop/main/atproto-source.ts` — replace the naive `getRecord` call
  in `resolveInternal()` with `fetchAndVerifyRecord()`. Keep the existing
  `verifyBlobCid()` unchanged; it remains the last link in the chain.

### Key rotation (did:plc)

A conservative client rejects a commit signed by a key that wasn't the key
**active at the commit's `rev`** according to the PLC audit log (available
at `https://plc.directory/<did>/log`). This prevents a stolen historical key
from being used to forge new commits.

Phased rollout:

- **Phase 1**: verify against the *current* `#atproto` key from the DID doc.
  This is what most atproto clients do today. Big step up from the status
  quo; ships the feature.
- **Phase 2**: walk the PLC audit log, find the key active at the commit's
  `rev`, verify against *that*. Adds ~50 lines and one extra HTTP call but
  removes the stolen-old-key attack.

### Icon / screenshot blobs

Currently unreferenced from the `space.peek.feature.release` record, so they
are **not covered** by any CID or signature chain. A PDS can substitute them
freely. Two options:

1. **Include them in the lexicon.** Add `icon: blob` and
   `screenshots: blob[]` fields to `space.peek.feature.release`. `publish.js`
   already uploads these as blobs; just wire their CIDs into the record.
   Existing CID validation then covers them.
2. **Document as cosmetic.** If we decide icons/screenshots are not
   security-sensitive (they never execute), note that in the lexicon doc and
   accept the cosmetic-substitution risk.

Recommend option 1 — cost is trivial once the signature chain exists.

### Caching

A verified record is safe to cache on disk keyed by `(did, collection, rkey,
commitCid)`. Invalidate when `getLatestCommit` returns a newer `rev`. Saves
repeated MST walks on update checks.

### Failure modes

Every verification failure MUST abort install and surface a clear error:

- `DID resolution failed` — network or malformed DID doc.
- `Signing key not found` — DID doc has no `#atproto` verificationMethod.
- `Unsupported key curve` — multicodec prefix outside {secp256k1, P-256}.
- `Commit signature invalid` — the big one. Means the PDS is lying or the
  publisher's key was compromised.
- `MST inclusion failed` — commit is valid but doesn't contain the claimed
  record; PDS is lying about which record exists.
- `Record CID mismatch` — record bytes don't match the leaf's value CID.
- `Blob CID mismatch` — already covered by existing `verifyBlobCid()`.

Each should log the DID, the atUri, and the reason before aborting. Do not
fall back to unverified install under any circumstance.

## Testing

- **Unit tests** (`apps/desktop/main/atproto-verify.test.ts`):
  - Golden signed commit fixture → verifies cleanly.
  - Flipped bit in commit body → rejects.
  - Flipped bit in `sig` → rejects.
  - Non-low-S signature → rejects.
  - Wrong curve in DID doc vs signature → rejects with useful message.
  - MST leaf at the wrong path → rejects.
  - Tampered MST node hash → rejects.
- **Integration test**: stand up a local PDS fixture (or record a real one),
  happy-path install, then a fault-injection test that mutates one byte of
  the bundle and asserts install aborts with `Blob CID mismatch`.
- **Adversary test**: run the installer against a hand-crafted "malicious
  PDS" fixture that returns a forged record with CIDs pointing at tampered
  blobs the fixture also serves. Must abort at commit signature verification,
  not after downloading anything significant.

## Scope and cost estimate

- Core signature + MST verification: ~200–300 lines.
- `@atproto/crypto` dependency add: trivial.
- Test fixtures (golden commit, malicious PDS): ~1 day.
- Phase 1 (current key): ~2 days including tests.
- Phase 2 (PLC log walking): ~0.5 day once Phase 1 ships.
- Icon/screenshot lexicon extension: ~0.5 day.

Total: ~3 days for a complete tamper-evident install chain.

## References

- atproto repo spec: https://atproto.com/specs/repository
- atproto DID method (PLC): https://web.plc.directory/
- `@atproto/crypto`: https://www.npmjs.com/package/@atproto/crypto
- MST spec: https://atproto.com/specs/repository#mst
- Existing install code: `apps/desktop/main/atproto-source.ts`
- Existing blob-CID check: `atproto-source.ts:502` (`verifyBlobCid`)
