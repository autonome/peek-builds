---
enabled: false
touches: [packages/capabilities/, apps/server/capabilities.js, apps/desktop/main/, tools/, docs/design/folknet-peeklets.md]
depends-on: []
---

# Draft: optional bounded transient Folknet worker jobs

**DISABLED; provider jobs support unverified.** Not permission to upload code, provision
compute, use credentials, spend or deploy. Contract: `docs/design/folknet-peeklets.md`
§§2, 4–8 and Peek-owned host seam in `docs/worker-runtime-portability.md` §4.

**Bez is reference only.** Optional execution is on the user's Folknet through an
independent Peek-owned adapter, not Bez infrastructure. No remote-lane/on-lane wrapper,
lane-local configuration, Dagu, Forgejo/git-bundle pipeline, Bez job manifest or
coordinator/writer service is reused or installed. No Bez keys, checkout, network,
machines, inventories or scheduler is needed. General admission/cleanup/recovery
lessons do transfer; platform claims do not (design §1 evidence table). No raw
SSH/admin authority is exposed to peeklets.

`depends-on: []` is deliberate: a pure transform needs neither a model broker nor new
remote datastore routes. Shared capability package and worker demos already exist.
This is not a ready-to-implement provider protocol. Runtime/security/billing gates
below are mandatory prerequisites to enabling any remote path, not fabricated spec IDs.

## Scope

One reviewed bundled pure text-transform entry, explicit user submission, no external
I/O, store authority, inference, child jobs, schedules, generic background init or
pubsub. Do not copy the whole Electron app, arbitrary installed workers, desktop grant,
profile database/snapshot, cookies, filesystem, OS automation or feature secrets.

Draft API is `api.jobs.submit({entry,input,exportApprovalId,clientRequestId})`, returning
an owner-bound opaque run ID; status/cancel/result query methods survive UI reopening.
Draft manifest extension and `(api, ctx)` example are in design §6. Do not interpret
currently ignored unknown manifest keys as approved capabilities.

## Work

- Extend existing shared validator/types/reducer with explicit bounded worker entry and
  `jobs` capability support, entry allowlists and strict resource/export policy. The
  worker entry is a manifest extension, not a provider-specific second manifest.
  Maintain existing tiles behavior and server projection freshness. All paid/remote
  callers including core UI require explicit grant/consent/resource admission, with
  additional monetary admission when metered.
- Build a portable shared host over an adapter; use existing WorkerEntry signature and
  RunContext second argument (`command` trigger params for input, deadline/signal and
  waitUntil). Bound waitUntil by the same hard run deadline. Absent namespaces stay
  absent; v1 API only exposes bounded log. Preserve import-time API binding with one
  fresh bundled graph per run, not cache-busting only the root of a dependency graph.
- Package immutable artifact + entry + dependency/lockfile + host ABI/runtime revision
  + manifest/resolved-policy digests. Verify provenance and digest independently;
  changes require renewed approval. No mutable imports/URLs at execution. Returned
  artifact/logs are data, never imports, scripts or trusted HTML.
- Fake adapter and local reviewed-code harness first. Provider adapter later supplies
  wire-neutral stage artifact, submit/lookup, observe, cancel, bounded result/log fetch,
  deletion and billing reconciliation. Publish an honest AdapterDeclaration; no
  assumptions of JS support, sandbox strength or runtime limits from another provider
  or Bez's guests. Configure approved operator/destinations, account and capability
  evidence independently. These are required adapter semantics, not known public REST
  routes or an established Folknet jobs SDK.
- Initial requested bounds: 64 KiB JSON input/output, 30-second wall duration including
  waitUntil, 1-second CPU, 64 MiB memory, 16 KiB logs; one in-flight/install, two/profile,
  queue four. Document and bound queue wait/cold-start, staging/storage/egress resources
  and retention too. These numbers are Peek policy requests, not Folknet guarantees.
  Explicitly classify billing: operator-attested owned/unpriced allocation requires
  resource admission but no invented price catalogue; metered allocation additionally
  requires finite maximum charges and monetary reservations; unknown billing refuses.
  Refuse unenforceable resource bounds or unbounded metered charges before submission.
- Main coordinator owns durable owner/run/receipt identities, dedupe keys and resource/
  charge reservations before send. Separate UI and job lifetimes. Default continuation
  after UI closure is disclosed; profile lock/switch, revoke, disable or uninstall
  requests cancellation and revokes run relay authority. Pending compute stays visible
  until stop/terminal evidence. No renderer timer/hold makes job expiry reliable.
- Implement state machine from design §6, including nonterminal unknown and orthogonal
  cancelRequested. Late success may follow cancel request; local timeout is not proof
  of remote cancellation. No automatic resubmission after ambiguous acceptance. Dedupe
  conflicting input reuse; idempotency does not promise exactly-once execution/billing.
- Local bounded result/log retention defaults to 24 hours after terminal; keep minimal
  outstanding billing/receipt records until reconciled. Remote deletion is requested
  and tracked, not guaranteed erasure from backups/operators. Results validate owner,
  run, digest, content type/size/decompression and schema before display. Never fetch
  arbitrary result URLs using ambient main authority.
- Keep provider inference credentials, submit credentials and Peek data credentials
  outside worker isolation. Future relay authority must be separately TTL/run-bound,
  revocable and per-operation server-enforced. **No current MCP bearer grant is handed
  to module code.** Nested inference and child-job grants remain absent even when the
  parent desktop tile has models/jobs grants. Future budgets require atomic parent/
  child accounting and depth/fan-out caps, under a later spec.

## Release gates / staged deployment

1. Offline fake plus local trusted pure transform. This phase establishes host and
   lifecycle behavior only, not hostile-code isolation or provider conformance.
2. Canonical provider jobs/API/SDK revision and arbitrary-code support verified. If
   Folknet only offers inference, this spec cannot be satisfied on Folknet; keep it
   disabled and ship model access independently if its own gates pass.
3. Independent hard wall/CPU/memory/egress/isolation enforcement, TTL while desktop is
   asleep/offline, tenant boundaries, credential custody, artifact verification and
   declared code-loading/runtime compatibility verified. A closure, replaced fetch,
   publisher signature, process import probe or cooperative AbortSignal is insufficient.
4. Verified billing classification and resource quotas; only when metered, finite billing
   cap including queue/cold-start/failure/cancel/storage/egress. Provider receipt lookup,
   dedupe window, cancellation certainty and final usage evidence (or explicitly unknown
   usage with conservative reservation policy); privacy/operator/region/retention/deletion
   policy approved for the submitted data. Owned compute is not assigned fictitious prices.
5. Separate explicit account/contact/export/spend/deployment approval for one tiny
   non-sensitive pure transform. No generic third-party module execution until dedicated
   adversarial isolation review. Scheduling, data access and nesting require later specs.

No contact before startup acknowledgment, selected/unlocked profile, approved account,
export/code-upload disclosure and matching install/artifact consent. Status recovery
must not replay submissions or deliver another profile's data.

## Done looks like

- Pure-transform worker runs through the shared entry/RunContext contract with only log
  available, bounded inputs/results/resources, no UI dependency and an immutable identity.
- Offline fake demonstrates submit/reopen/status/cancel/restart/uncertain acceptance and
  duplicate-delivery behavior without credentials or remote operations. Durable ledger
  and ownership survive renderer destruction; no exactly-once or free-cancel claims.
- Remote support remains visibly disabled unless all provider/security/billing gates
  pass; a supported adapter declares measured limits and operator/privacy limitations.
- Revocation denies new authority immediately at broker/relay; already exported data
  and already-running compute are not claimed retrievable/stopped until evidence exists.

## Verify

Future offline acceptance (not implementation tests run by this docs-only track):

- Validator/reducer/projection: unsupported worker/runtime/entry, unknown fields,
  resource overflow/NaN, nested/desktop grants attempted, artifact mutation, traversal,
  mutable imports, invalid input schemas. Existing tile manifests remain compatible.
- Host: two runs with a dependency capturing API at import see their own graph; thrown
  entry is fatal; rejected waitUntil fatal; hard busy-loop deadline independent of
  worker timers; denied namespaces are undefined; bounded log/memory/result handling.
- Policy/ledger: missing consent/startup/profile gates, core bypass, queue/rate/aggregate
  resource budget races; unpriced without monetary catalogue but with quotas, unknown
  billing refusal, metered unknown price/currency mismatch/cancel/failure billability;
  old-profile result lookup, profile deletion with outstanding charges and credentials
  redaction.
- State-machine fault injection: crash before/after submit receipt persistence, duplicate
  provider events, conflicting dedupe input, lost response without lookup, provider retry,
  cancel-before-accept/late-success, stale terminal event, unreachable control plane,
  sleep/disconnect past deadline, reconnect/restart; never silently resubmit.
- Lifecycle: renderer destroyed/hold expired without losing owner; revoke/uninstall/
  profile switch requests cancellation and denies fresh relay authority; stopped versus
  uncertain status visible; result/log expiry/deletion does not erase unsettled charges.
- Security fixtures: cross-owner status/result/cancel, malicious returned artifact/log,
  compressed oversized output, URL exfiltration, unexpected nested invocation, replayed
  expired relay. Fake assertions cannot prove real sandbox/network isolation.
- Run projection freshness, targeted new tests/type/lint gates and `git diff --check`.

Separately authorized provider acceptance must test actual cold start, busy loop,
CPU/memory exhaustion, all network escape paths, credential extraction/tenant attacks,
TTL during desktop shutdown, receipt/dedupe/cancel semantics, billing and deletion.
Linux/macOS integration, provider runtime, isolation, spending and deployment are unrun;
never run existing demos in credential-reading remote mode as this spec's verify gate.
