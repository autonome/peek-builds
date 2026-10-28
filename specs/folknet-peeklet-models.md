---
enabled: false
touches: [packages/capabilities/, apps/server/capabilities.js, apps/desktop/main/, docs/design/folknet-peeklets.md]
depends-on: []
---

# Draft: bounded model broker for peeklets (Folknet adapter gated)

**DISABLED.** No authorization for credentials, real inference, billing or deployment.
Design contract: `docs/design/folknet-peeklets.md` §§1–5, 7–8. Provider protocol is
unverified. Empty dependency list means no verified missing repository prerequisite,
not that provider work is ready. Do not enable until the gates below are resolved.

**Bez is reference only.** This is an independent Peek-owned broker for the user's
Folknet, not a wrapper around Bez's gateway, inventories, lanes or coordinator/writer.
No Bez installation, keys, checkout, network, machines or scheduler is required. See
the evidence classification in design §1: deployment examples are not platform facts;
no primary Folknet contract has yet been verified.

## Scope and approach

First deliver an offline/fake-backed, profile-scoped broker with generic `models`
capability and proposed `api.models.start`/events/cancel/status surface. Keep pure
validation, policy, atomic durable reservations and adapter types portable; Electron
is transport/vault/lifecycle glue only. Future server transport reuses policy, not
renderer IPC. No remote jobs, autonomous tools, datastore mutations, provider fallback,
arbitrary fetch proxy, generic agent loop or hosted service in this increment.

- Extend existing `packages/capabilities/index.js` and `index.d.ts`: explicitly validate
  bounded allowlisted model/task pairs and finite input/output/time/concurrency/resource
  limits, with additional charge limits only for metered accounts; resolve without
  granting merely because requested. Reproject server CommonJS using existing
  codegen/check-freshness. Do not duplicate capability logic.
- Configure independent operator/destination/adapter/account/capability evidence in
  trusted per-profile settings, not Bez files or aliases. No hardcoded hosts, model
  aliases, capacities or pricing. Discovery is approved adapter-specific contact, not
  assumed REST routes or LAN scanning. Separate catalogue membership, readiness,
  permission and capacity; expire stale evidence. Readiness inference probes require
  full admission/consent, never automatic background model calls.
- Add broker-owned contact/export consent and account settings/vault ports. Feature
  `secrets` authority must not read account credentials. Fail closed on unavailable
  secure storage; never use feature settings for plaintext auth.
- Register paid/remote IPC with explicit capability and READY/VISIBLE states, strict deep
  request validation beyond the gate's shallow schema, owner-bound IDs, profile-ready
  and startup/contact/export/budget checks. Core/trustedBuiltin callers do not bypass.
- Implement the draft request/events contract in the design: task-discriminated schemas,
  model revision and parameter allowlists; bounded credit/ack streaming, slow-consumer
  cancellation; no raw URLs/headers/tools or unbounded provider buffers. Nonstream
  tasks share bounded result and terminal envelopes. Task support is discovered and
  verified, not promised from generic types; embeddings/classifiers/images are not
  forced through chat messages.
- Durable resource ledger atomically reserves finite quotas across call/install/profile/
  account and all concurrent processes. Bound rates, queue and concurrency. Explicit
  billing classification: operator-attested `unpriced-owned` needs no invented monetary
  catalogue or currency; `metered` additionally requires integer-currency worst-case
  charge reservations, fresh prices and finite ceilings; `unknown` refuses submission.
  Missing prices never imply unpriced. Retain uncertain resource/charge reservations
  through restart/rollover until safe reconciliation; unknown usage stays unknown.
- Provider adapter supports wire-neutral capabilities/catalogue (pricing if metered),
  start, events/result, cancellation and receipt lookup/reconciliation operations; mark unsupported features
  explicitly. Persist intent before send. Never automatically retry an ambiguous paid
  call, change model or refund a timeout based solely on local observation.
- Implement main-owned deadlines and lifecycle matrix from the design. Unload cancels
  inference but not accounting; hide alone is not unload. Profile switch/lock prevents
  cross-profile delivery and requests cancellation. Holds are bounded convenience,
  not required correctness. Reopening status does not resubmit work.
- Settings/install UI discloses account, destination, export scope, resources/cost
  ceiling, actual provider guarantees and outstanding reservations. Explicit cancel,
  revoke and recovery/error states; no provider contact before approved configuration.
  Diagnostics contain only redacted IDs/metrics; output stays untrusted data.

Example capability and call in design §3 are draft API examples, not existing provider
protocol. Offline fixtures use invented **fake** model ID `fake:text-v1`, one attested
unpriced account and one metered account with a finite fake price function and known
usage, never a real Folknet ID or endpoint. Other tasks are extension points only;
Bez's text-completion examples establish no general model/task availability.

## Provider / deployment gates

1. Establish canonical provider identity, versioned docs and SDK provenance; record
   tasks, schemas, framing, auth scopes, model revisions, usage and billing semantics.
2. Prove finite provider-enforced request/resource ceilings for every mode. Establish
   owned/unpriced allocation from operator terms or, if metered, maximum billable charge
   including cancel/failure. Local token estimates do not qualify as hard budgets.
   No live path with unknown billing/resource bounds; metered estimate-only mode needs
   separate approval/spec. No commercial catalogue required for unpriced owned compute.
3. Document cancellation limits, idempotency/dedupe window, lost-response lookup,
   retention/training/region/operator trust, deletion and account-wide cap limitations.
4. Approve target OS credential custody and explicit contact/export/spend test policy.
   Only then separately authorize non-sensitive bounded inference conformance. This
   disabled spec authorizes neither a test account nor a paid test.

Stage offline fake first; gated adapter second; separately authorized OS/provider
acceptance third. Jobs need their own approval, even if inference passes.

## Done looks like

- Fake-backed broker and policy tests demonstrate strict admission and bounded events
  without remote contact; missing capability/task/consent/account/budget refuses before
  sending. A selected-text workflow can display an escaped result and usage state.
- Caller never receives account keys. All callers including core UI use identical cost
  and export gates. Changing profile/install/grant invalidates outstanding authority.
- Restart/stream-overflow/cancel/lost-submit tests preserve accounting and uncertain
  status; no double-billing retry or hidden fallback. New UI can inspect old owned IDs.
- Provider adapter is not described as supported until contract-conformance gates pass;
  missing support is a visible disabled reason, not a guessed implementation.

## Verify

Offline automated acceptance matrix (to implement, **not run by this design track**):

- Shared validation/reduction/type/projection tests: missing/unknown model, task mismatch,
  invalid parameters, NaN/Infinity/negative/unsafe integers, oversized inputs/results,
  malformed catalogue and unsupported task; fuzz nested schemas and event framing.
- IPC tests: stolen/cross-tile IDs, stale grant, LOADING caller, missing profile gate,
  core bypass attempt; no send before consent and no contact from notice/profile picker.
- Ledger tests: concurrent windows/processes, queue overflow, per-call/install/profile/
  account aggregate resource ceilings; attested unpriced works without prices but never
  without quotas, unknown billing refuses, missing price cannot select unpriced; metered
  stale/unknown pricing, currency mismatch, reservation crash
  points, duplicate/conflicting receipts, unknown usage, rollover and external-account
  usage disclosure. No reservation release on mere timeout/cancel request.
- Fake stream tests: out-of-order/duplicate/malformed chunks, blocked consumer, bounded
  memory/bytes/time, exactly one local terminal, detached renderer, abort after terminal,
  redaction of seeded prompt/key/provider-error/signed-URL strings.
- Lifecycle tests: hide vs unload, hold expiry, suspension, sleep/disconnect, revoke,
  profile switch/lock, restart after accepted-but-unrecorded receipt; no replay or
  cross-profile result; malicious output cannot invoke tools or mutate datastore.
- Run `node packages/capabilities/check-freshness.js`, targeted implementation tests,
  type/lint gates for changed code and `git diff --check`. Use repo test scripts once
  implementation files are chosen, not guessed commands for nonexistent tests.

Separately approved real-provider/OS tests must verify actual usage/cancel/deadline,
stream/backpressure, pricing ceilings, credential backend and privacy/deployment
claims. Linux/macOS/provider/spending/isolation/deployment acceptance remains unrun.
