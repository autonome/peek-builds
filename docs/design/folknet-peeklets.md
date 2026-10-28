# Folknet for peeklets: model broker, then optional transient workers

Status: **draft design, provider contract unverified, no implementation authorized**.
Companion specs: `specs/folknet-peeklet-models.md` and
`specs/folknet-peeklet-jobs.md` (both disabled). This completes the research brief
in `specs/folknet-peeklets-design.md`; it does not enable spending or remote code.

## 1. Evidence and boundaries

**Bez is reference only.** Peek owns its broker, configuration, model adapter and
optional job adapter independently. Execution, if supported and separately approved,
is **on the user's Folknet**, not on Bez infrastructure. Peek never requires Bez to
be installed or reachable, nor shares its keys, checkout, network, machines,
inventories or schedulers. Do not wrap its remote-lane/on-lane scripts, use its
lane-local bindings, Dagu deployment, Forgejo/git-bundle pipeline or job manifests,
or install its coordinator/writer services. No SSH/admin interface is exposed to
peeklets. Running a Bez build lane on Folknet does not establish a Folknet jobs API.

### Evidence classification

| Class / source | What is established | What is not established |
| --- | --- | --- |
| Primary Folknet model/control-plane contract | **None verified from provider-controlled public code/docs in this research.** | Canonical identity/revisions, endpoint discovery/auth, tasks, usage/cancellation, quotas and billing contracts remain unknown. |
| Primary Folknet transient-execution contract | **None verified.** | A public REST/jobs service, arbitrary-code support, JS runtime, isolation, enforced limits, receipts and deletion are not inferred from machines running Bez. |
| Bez `docs/infrastructure.md`, “As discovered”, “Build lane”, “Outside sources” | Describes that project's deployment: a model gateway, compute guests and project-specific delivery scripts. Outside sources links WPT, WebGL and WebGPU CTS, not Folknet platform code/docs. | LiteLLM, aliases, hardware/pool capacities, lane shapes, service discovery and access methods are not platform contracts or Peek prerequisites. |
| Bez `docs/folknet-inventory.md` | Deployment observations/design distinguish catalogue liveness from completion readiness and age out snapshots. Prose mixes proposed and subsequently built details. | No canonical Folknet catalogue/discovery schema or universal freshness interval; no permission to perform readiness inference. |
| Bez `docs/coordinator-on-folknet.md`, `docs/folknet-writer-design.md` | Specialized coordinator/writer designs illustrate separating credential custody, authority and supervision; some results are labelled measured, others unverified. | Neither is a general remote module service; its account/subscription/spend rules do not transfer to Peek. |
| Bez `docs/job-concurrency.md` | Examples of per-job checks missing aggregate admission, stale capacity, immutable source identity, cleanup/recovery and uncertain stop behavior. | Its queue/lease scheme, measured limits and scheduling choices are not enforceable Peek resource bounds. |
| Peek source below | Existing capability, IPC, lifecycle and worker-demo behavior. | Existing worker demos do not prove provider conformance or hostile-code isolation. |
| Proposed Peek functionality (§§2–7) | Broker/adapter seams, API sketches, consent, resource admission, optional monetary ledger, run identity and recovery requirements. | Not implemented APIs, Folknet endpoints, advertised tasks or available runtime guarantees. |

Bez citations above identify read-only educational documents in the sibling project's
`docs/`, not files Peek must load. No private bindings, credentials or rig access were
used. No relevant public Folknet repository/API documentation link was found in those
five references; unrelated conformance-suite upstreams are not provider evidence.

Repository source, not old design tense, is the implementation baseline:

| Evidence inspected | Current fact / consequence |
| --- | --- |
| `packages/capabilities/index.js`, `index.d.ts` | Shared `validateTileManifest` and `resolveCapabilities` already exist. No models/jobs capability or typed top-level worker entry. Validation requires a `tiles` array; unknown keys are not reliable rejection. Resolution does not grant unknown capabilities. New fields need explicit validation, reduction, types and tests. |
| `packages/capabilities/codegen.js`, `check-freshness.js`; `apps/desktop/main/tile-manifest.ts` | Shared logic is projected into server CommonJS; keep one vocabulary, not provider-specific manifest forks. |
| `apps/desktop/main/tile-api.d.ts` | Existing `initialize`, `onShutdown`, `network`, `secrets`, `tile.hold`. No model/job broker surface. |
| `apps/desktop/main/tile-ipc-gate.ts` | `registerTileIpc`/`runPipeline` bind tokens to senders and check schema, grant, state and role. Required capabilities default to none; actual default state window includes LOADING, READY, VISIBLE despite narrower comments. New paid operations must explicitly require READY/VISIBLE and a ready profile broker. No startup safety inferred from default IPC policy. The gate also bypasses required-capability/state checks for trustedBuiltin and skips state rejection for a missing/null probe; broker admission must fail closed independently. |
| `apps/desktop/main/tile-ipc.ts` | `tile:network:fetch` checks hostname against grant then buffers response text/bytes; not an inference streaming, cost or credential boundary. `tile:secrets:run` scopes operations to grant tile ID. Neither grants provider account access. |
| `apps/desktop/main/feature-secrets.ts`, `electron-secret-cipher.ts` | Platform-neutral `SecretStore` with encrypted-file desktop backend; unavailable cipher refuses reads/writes. Feature secrets are readable by their owning feature, so **do not** put broker account credentials in a feature's namespace. |
| `apps/desktop/main/tile-suspension.ts`, `tile-lazy.ts`, `tile-ipc.ts` | Main owns suspension; defaults: ten-minute idle, thirty-minute hold cap, idle floor twice shortest schedule interval. Pending result dispatches can hold a tile. `tile:hold:acquire/release` exists. A hold is neither a durable remote-job lease nor proof a page stays alive. |
| `apps/desktop/main/entry.ts`, `runtime-entry.ts`, `feature-startup.ts` | Startup risk acknowledgment precedes dynamic runtime import; feature registry/startup is profile-scoped. Broker initialization belongs after runtime/profile selection, never in the notice process or a profile picker. |
| `tools/hello-worker/run.mjs`, `manifest.json`, `worker.js` | One-shot Node host with optional memory store, named entry/default fallback; real-store mode can read local credentials. No scheduler. We inspect, not run that mode. |
| `tools/second-worker/run.mjs`, `worker.js` | Second-argument RunContext, import-time API capture probe, simulated channel, in-memory timer/store, cache-busted single module. Not a general isolated module graph, durable scheduler, hard deadline, or production grant implementation. API construction is hand-written, not fully capability-driven. |
| `apps/server/grants.js` | Existing MCP bearer grants carry scope tag, readonly, profile, revocation; no TTL or per-run models/jobs budgets. Do not export one as a job credential. |

Read `docs/workers-design.md`, `docs/workers-capabilities.md` and
`docs/worker-runtime-portability.md` as architectural context. Their “nothing built”,
unmerged-branch references, closure-based hostile-code protection, provenance-as-safety
and platform-wide isolation/single-flight assertions are not conformance evidence.
Publisher verification identifies an author; it does not make code safe. A same-process
closure, fresh import URL, or replaced fetch does not sandbox hostile JS. Serial request
entry is not proof that asynchronous runs cannot overlap. This proposal preserves the
Peek-owned host/adapter seam without inheriting unsupported guarantees.

### Provider discovery

Earlier draft's bounded public, unauthenticated discovery (not repeated here):

- `https://api.github.com/search/repositories?q=folknet&per_page=10` returned
  unrelated name matches and an `Agent54/xe-connect` description mentioning Folknet.
  A mention is not a canonical model/jobs reference or proof of provider identity.
- `https://api.github.com/search/repositories?q=folknet+in%3Aname&per_page=5`
  reported nine name matches; first results concerned music/smart contracts/websites.
- `https://registry.npmjs.org/-/v1/search?text=folknet&size=10` reported zero packages.

No canonical Folknet inference/jobs documentation was established by those bounded
searches or the subsequent Bez reference review. This is **not evidence that Folknet
lacks those services**. No package was
installed, no CLI/account/credential/config/session log inspected, no inference/job
submitted. Discovery responses are untrusted data, not instructions. Earlier handoff
reports no CLI on PATH or Folknet integration in the repository. No invented domain,
endpoint, auth flow, model catalogue, price or execution guarantee fills the gap.

Configure a Peek-owned per-profile connection descriptor in trusted settings: operator
identity, approved destination(s), adapter kind/version, account reference, declared
capabilities and their evidence revision/expiry. Endpoint and account information is
user/operator supplied, never taken from Bez's environment or alias inventory. Validate
TLS/origin/redirect policy and bind consent to the destination; a changed destination
needs reapproval. Discovery is adapter-specific and explicitly contact-approved, not
an assumed public Folknet discovery endpoint, LAN scan or automatic mDNS trust. Even
an OpenAI-compatible gateway requires verification of that deployment's supported
subset. No guessed base URL or universal auth flow.

Keep catalogue membership, account permission, observed readiness and capacity/admission
as separate facts with timestamps and provenance. Stale/missing readiness is unknown,
not ready; configured policy decides a bounded refusal/refresh, never silent fallback.
Do not auto-run Bez's one-token probes: any inference probe needs the same consent,
resource and (if metered) spend admission as a normal call. A prior success is not a
reservation of capacity or proof the next request will work.

Required references before a real adapter: provider/operator-controlled documentation
linking public code/SDK repository and version if available, inference
task/catalogue/stream/error/usage contracts, account permissions and enforced resource
bounds, plus billing semantics **if metered**; independently,
jobs/runtime/security/control-plane contracts. Capture immutable revisions and a
capability support matrix. An
OpenAI-shaped example, package name match or marketing mention is insufficient.

## 2. Architecture and separate authorities

Two opt-ins, neither implying the other:

1. **Models:** tile → validated main IPC → profile model broker → provider adapter.
   A future server broker can use the same pure policy/ledger logic with authenticated
   server requests instead of Electron IPC. Start on desktop; no server prerequisite.
2. **Jobs:** tile → main run coordinator → jobs adapter → isolated bounded worker host.
   Worker code keeps `(api, ctx?) => Promise<unknown>`; provider APIs stay below the host.
   No Electron/Chromium app is uploaded. No need for a scheduler or duplex pubsub in
   the first manually submitted pure-transform job.

Keep these authorities independently identifiable, revocable and non-interchangeable:

- Provider inference account credential: host only, model calls only where provider
  scopes permit; broad provider keys remain an acknowledged account compromise risk.
- Provider job-submit credential: coordinator only, never worker code or renderer.
- Peek data authority: local grant or future attenuated server grant, not either key.
- Model budget authorization: broker-owned ledger, bound to profile/install/caller.
- Job submit authorization: artifact allowlist plus resource/export/cost policy.
- Job-internal nested inference/child-job authorization: **absent in v1**, not inherited.

Do not extend `trustedBuiltin` bypass to paid or remote operations. All callers,
including core UI, require configured account, approved export and resource/budget
admission, even for unpriced owned compute. Manifest requests
are ceilings, not user consent; intersect manifest, install consent, profile policy,
account scope and adapter support at every admission. No ambient wildcard models/jobs.
New capability names are proposed generic `models` and `jobs`, not `folknet` network
access. Direct user-authored network calls with their own credentials are outside this
broker's cost/privacy guarantees; disclose that limitation.

## 3. Draft model contract

All names below are **proposed Peek API**, not present code or Folknet wire schemas.
A catalogue exposes stable provider-qualified model IDs, revision, task discriminator,
input/output/parameter schema versions, supported streaming/cancel features, limits,
billing mode (`unpriced-owned`, `metered`, or `unknown`) and, only when metered,
price version and a conservative finite maximum charge function. Treat catalogue data
as untrusted and size-bounded. Tasks may include text generation, embeddings,
classification, transcription or image generation **only after provider verification**;
there is no chat-only universal messages schema. Unknown tasks/models are unavailable.

Illustrative proposed capability fragment (not a complete installable manifest):

```json
{
  "models": {
    "allow": [{ "model": "folknet:<verified-model-id>", "task": "text.generate" }],
    "maxInputBytes": 16384,
    "maxOutputBytes": 32768,
    "maxOutputUnits": 512,
    "maxDurationMs": 30000,
    "maxConcurrent": 1
  }
}
```

`<verified-model-id>` is a placeholder, not a real model. This resource-only fragment
can cover approved unpriced owned compute. For metered access, proposed additional
`maxCallChargeMicros` is a required finite integer ceiling, in millionths of the
configured billing currency, not a claimed Folknet price. Separate profile/install
policy sets rolling resource totals, request rate, queue length and aggregate
concurrency, plus billing-period monetary totals when applicable; a per-call limit
alone does not bound aggregate use.

```js
// Draft API; run only inside an approved, initialized peeklet in a future build.
const call = await api.models.start({
  model: 'folknet:<verified-model-id>',
  task: 'text.generate',
  input: { text: 'Summarize this explicitly selected text.' },
  parameters: { maxOutputUnits: 128 },
  exportApprovalId: 'host-issued-selection-approval',
  clientRequestId: 'unique-within-this-install'
});
try {
  for await (const event of call.events) {
    // Bounded tagged data: output delta, usage, or terminal; never executable tools.
    renderAsText(event);
  }
} finally {
  await call.cancel(); // Idempotent request, not proof billing/compute stopped.
}
```

`renderAsText` is application pseudocode. Start returns an opaque owner-bound call ID
and local stream facade, not a transferable provider credential. API cancellation and
renderer AbortSignal map to a broker operation; AbortSignal is not serialized over IPC.
Nonstream tasks use the same start/terminal envelope with bounded result chunks. The
broker validates finite numbers, safe integers, unknown keys, input schema and byte
limits, allowlisted model revision, task, output limits, deadlines and parameter schema
before any contact. No arbitrary URLs, provider headers, tools, remote file references
or opaque passthrough parameters. No automatic fallback model/provider.

Events carry call ID, monotonic sequence and one tagged payload; exactly one local
terminal delivery, duplicate provider events ignored. Bounded credit/ack IPC transport
(e.g. 16 chunks, total 256 KiB, each at most 32 KiB), max result bytes and slow-consumer
timeout prevent main/renderer queue growth. Adapter pauses reads if possible, otherwise
aborts on overflow and records uncertain billing. Never buffer an unbounded body using
the current network helper. Provider-specific framing and usage normalization stay in
the adapter. Terminal has outcome, usage evidence, final/estimated/unknown charge status
and redacted error code; no raw provider body/stack exposed. For verified unpriced
owned compute charge status is `not-applicable`, never fabricated usage or a guessed
zero-dollar price.

Output is untrusted data. Escape text, validate structured results, never auto-execute
code/tool calls, fetch output URLs or mutate Peek data on a model's instruction. A
separate user-approved action with its own grant must apply any proposed store change.

## 4. Admission, cost, consent and account custody

A profile's trusted settings surface chooses an account and displays supported tasks,
provider/operator visibility, approved export classes, current reservations, settled
usage and unresolved charges. No provider contact (including catalogue refresh) until
account configuration **and** explicit contact approval. Installation discloses models,
maximum resources, purpose, export scope and whether code itself leaves the machine.
Account configuration is not blanket data-export consent. Selected text requires a
host-issued approval bound to owner, profile, destination, purpose, size and content
snapshot/hash; recurring automatic export requires a separate revocable scope consent.
Data read permission never implies permission to export it. No profile snapshot,
cookies, hidden page contents or feature secrets are automatically included.

Use a dedicated host-only profile account vault/SecretStore backend, never
`api.secrets.get` or feature settings, never synced by default. Fail closed when secure
storage is unavailable. Audit actual OS cipher availability on target platforms; do not
promise every Linux configuration is securely supported. Rotation stops admissions,
invalidates cached catalogue/prices and reauthorizes the account, without replaying calls.

Admission always uses a durable atomic resource ledger: reserve bounded input/output,
duration, concurrency and aggregate resource quotas against call/install/profile
**and account-wide** ceilings, including queued/in-flight work across windows/processes.
Local estimates are labelled estimates; hard provider resource bounds must be evidenced.
One broker lease/transaction owner prevents concurrent over-admission.

Billing is a separate discriminated policy, not a mandatory commercial catalogue:

- `unpriced-owned`: trusted account configuration attests owned/unpriced allocation,
  destination and scope, backed by operator terms; no commercial price catalogue,
  currency or monetary reservation is required. Resource quotas, consent and admission
  remain mandatory. Unknown token/CPU usage stays unknown, not zero. Electricity and
  shared hardware cost are not claimed free or attributed from rack-wide telemetry.
- `metered`: reserve worst-case charge in addition to resources; currency must match,
  no floating-point accounting. Apply the monetary rules below.
- `unknown`: block submission until billing classification is established. Missing
  prices do not silently select unpriced mode. A destination/account change invalidates
  the classification and cached support evidence.

For metered work, reserve all billable input, output, compute, storage, egress,
minimum fees and failure/cancel charges as applicable. Refuse missing/stale prices, missing finite maximum, unknown billing units
or unsupported provider resource ceilings. Local token estimates are not spend limits.
Require provider-enforced per-request/resource maximum plus documented billing semantics
to advertise a hard monetary ceiling. Otherwise real paid submission is blocked in this
initial design; a future “estimate only” mode needs a separate policy decision/spec.
These price requirements do not block verified unpriced owned compute, but missing
hard resource limits still do.

In every mode, durably record request intent before send and provider receipt when
known. Keep uncertain resource reservations until stop/expiry or conservative maximum
usage evidence permits reconciliation; a local abort does not free remote capacity.
The following charge rules apply only to metered work. Reconcile usage with
authoritative billing evidence, release unused reservation only when safe,
retain maximum reservation for uncertain outcomes and duplicate receipts. A local timeout
or cancellation does not establish zero charge. Lost final usage leaves unresolved debt;
no automatic reset at month rollover, profile deletion or restart. Account usage outside
Peek cannot be bounded by Peek; account-level provider caps are needed for total spend.
Do not blindly retry a potentially accepted operation: lookup by documented idempotency
key/receipt first. If unsupported, show uncertain and require deliberate new work.
This no-blind-retry rule also applies to unpriced remote operations: duplicated work
still consumes quotas and capacity. No claim of exactly-once inference or billing.

Diagnostics default to IDs, task, timings, byte counts and charge state, never prompts,
outputs, auth headers, signed URLs or raw errors. Opt-in content diagnostics require
separate consent and finite retention. Redaction cannot hide data from the provider or
its compute operators: confidentiality, training use, region, subprocessors and retention
are provider-contract questions, not implied by encryption in transit.

## 5. Lifecycle and recovery

Main/coordinator owns deadlines, cancellation, ledger and cleanup; renderer timers are
not authoritative. Admission requires accepted startup risk gate, selected/unlocked
profile, explicit account/contact/export approvals and current owner grant. Never start
in pre-runtime imports, profile picker, or automatically from restoring a result view.
Revalidate consent/grant revisions immediately before dispatch.

| Event | Model policy | Job policy |
| --- | --- | --- |
| UI hides | Continue within existing deadline; hiding alone is not unload. | Continue approved bounded run. |
| Tile unload/crash/suspension | Cancel local stream and request provider cancel; retain receipt/uncertain reservation. | Job lifetime is coordinator-owned, not renderer-owned; approved continuation disclosed at submit. |
| Profile switch/lock | Stop admissions; cancel inference, detach outputs; no delivery to new profile. | Default request cancellation and revoke run relay authority; keep old-profile reconciliation record. |
| Disable/uninstall/revoke | Cancel calls, prevent fresh authority; settle charges separately. | Cancel jobs, revoke relay/children, prevent schedules/new jobs; do not erase outstanding identity. |
| Desktop sleep/disconnect | Cancel best effort before sleep; timeouts may be observed late after wake. | Provider deadline/TTL must stop work independently of desktop connectivity. |
| Restart/reconnect | Recover ledger, query receipts, never replay uncertain paid calls. | Query saved run IDs; reconcile completion/cancel/expiry without resubmitting. |

A renderer may use `api.tile.hold()` for bounded rendering while a call is in flight,
released in finally; the existing 30-minute cap means this is only convenience.
Broker correctness must survive hold expiry, forced unload or no renderer at all.
Store results in owner-scoped bounded records; UI can explicitly reopen/query them.
Do not keep lazy tiles resident just to poll remote compute. Existing tile schedules
are desktop wake topics, not durable provider scheduling; remote schedules are out of v1.

## 6. Optional transient jobs

First job: reviewed bundled pure text transform, explicit submit, no external I/O,
no datastore, no models, no children. Input/output at most 64 KiB JSON, wall deadline
30 seconds including entry and waitUntil, CPU at most 1 second, memory at most 64 MiB,
log at most 16 KiB, one concurrent job per install, two per profile, bounded queue of
four. These are **requested test limits**, not available Folknet runtime claims. Refuse
if adapter cannot enforce them, bound queue/cold-start/storage resources and retention,
or (when metered) bound all resulting charges.

Draft manifest extension and submission (neither currently supported):

```json
{
  "worker": { "url": "normalize.js", "entry": "normalize" },
  "capabilities": {
    "jobs": {
      "entries": ["normalize"],
      "maxInputBytes": 65536,
      "maxOutputBytes": 65536,
      "maxWallClockMs": 30000,
      "maxCpuMs": 1000,
      "maxMemoryMiB": 64,
      "network": false,
      "nestedModels": false,
      "childJobs": false
    }
  }
}
```

This is a proposed extension fragment, not an existing manifest accepted as authority.
Resolve it into a dedicated job grant, not the desktop's whole capability object.

```js
// Draft worker export; one bundled immutable module graph per run.
export async function normalize(api, ctx) {
  const lines = ctx.trigger.params.lines; // Host validates <=64 KiB JSON/schema first.
  if (ctx.signal.aborted) throw new Error('aborted');
  return { lines: lines.map(line => line.trim()) };
}
// Draft desktop call; job management is separate from the remote worker API.
const run = await api.jobs.submit({
  entry: 'normalize',
  input: { lines: ['  selected text  '] },
  exportApprovalId: 'host-issued-selection-approval',
  clientRequestId: 'unique-within-this-install'
});
// Later, possibly from a newly opened UI: await api.jobs.status(run.id).
```

Host adapts input to existing RunContext trigger `{kind:'command', name:'normalize',
params: input}` with deadline, signal, waitUntil as the second argument; no new vendor
context parameter. Worker API initially has only bounded redacted log; denied namespaces
are absent. Import-time compatibility globals may expose only this same API. No raw
invoke, window, cookies, filesystem, OS automation, secrets, parent credentials or
network. Any runtime scratch storage is isolated, ephemeral, size-limited and not Peek
storage. Return value goes to bounded run result, not automatically into datastore.

Artifact identity covers bundled module graph, entry, dependencies/lockfile, host ABI,
runtime revision, manifest and resolved job policy (canonical hashes), with publisher
provenance separately verified. Do not resolve mutable URLs or peek:// imports at run
time. A changed digest requires review/reapproval, not a silent latest deployment.
Provider verifies fetched artifact digest; result envelope binds run and artifact digest.
Results/logs remain hostile content even with a matching hash (integrity is not truth).
Never import a returned artifact or render log markup. Bound decompression, nesting,
result fetches and content types; no automatic arbitrary URL fetch in main.

The adapter must declare code-loading semantics, isolation, egress enforcement, resource
limits, scheduling/retry semantics and runtime/language support following
`docs/worker-runtime-portability.md` §4. ES modules/ES2022/Web API floor is a portability
target, not verified Folknet support; no inference from another vendor's 15-minute floor.
Use a fresh bundled graph in a fresh enforced isolation boundary per run. Cooperative
AbortSignal alone cannot stop a busy loop. Hard deadline/memory/CPU/egress limits require
an independently enforced runtime. Host credentials live **outside** worker isolation.
A Node closure or fetch shim remains a trusted-code demo only. No arbitrary third-party
code until adversarial isolation and all network paths are proven confined.

Future data access must use a run-bound TTL/revocable relay (or new server grants with
equivalent attenuation), outside the worker boundary, checking owner, operation, item
scope, deadline and budget on every call. Never ship current generic MCP grants.
Job-internal inference would have a separate broker authorization and shared atomic
parent/child budget reservations; child submission would need depth, count and fan-out
caps. Both remain denied even if the submitting tile has those desktop capabilities.
No generic background.js/init compatibility, periodic workers or arbitrary worker
commands in this increment.

### Persistent run state and uncertain outcomes

Persist owner `{profileId, accountId, installId, installRevision, entryDigest}` plus
local run ID, client dedupe key, input digest, policy/consent revision, reservations,
provider receipt/run ID and timestamps **before submission**. Renderer IDs are not
persistent ownership. Profile data deletion must surface outstanding billable runs first.

State progression: `prepared -> submitting -> accepted -> running -> succeeded|failed`.
From any nonterminal state cancellation sets a durable `cancelRequested` flag;
`cancelled` or `expired` requires authoritative provider stop/expiry evidence.
Transport ambiguity enters `unknown` (nonterminal), recoverable by receipt/key lookup
into accepted/running/terminal states. Local timeout can detach UI and request cancel
but cannot turn unknown into cancelled. Late success after cancel request is valid and
may be billable when metered; resolve by authoritative version/receipt, ignore duplicate events, retain
conflicting evidence for review. Terminal states do not regress on stale events.

Delivery/execution may be duplicated or uncertain; **not exactly once**. Dedupe keys
are scoped to owner plus entry/input digest, reject conflicting payload reuse and persist
across restarts. Provider dedupe window/support is unverified; local dedupe cannot prevent
a second remote execution after a lost submit response. No automatic resubmit in that
case. Pure transforms tolerate repeats but billing still may repeat. Future side effects
need server-side idempotency in addition to this state machine.

Local result/log default TTL: 24 hours after terminal, bounded per-profile storage; keep
minimal charge/receipt metadata until reconciliation and user-selected audit retention.
Request remote deletion after terminal/TTL, record confirmed versus unsupported/pending.
Do not promise erasure from provider logs, backups or operators, nor that deleting UI
history cancels compute. Region, privacy, deletion and maximum remote retention are
release blockers for sensitive payloads. Reconnect polling is bounded/backed off; no
indefinite free-looking polling/storage reservations.

## 7. Wire-neutral adapter obligations and release gates

These are required semantics, **not endpoints, SDK names or known Folknet features**:

| Models adapter operation | Must establish |
| --- | --- |
| Discover/validate account capabilities/catalogue | Versioned tasks, schemas, limits, readiness freshness and billing classification; finite charge ceilings/prices only when metered; explicit account approval before contact. |
| Start request | Validated request, resource ceilings, correlation/dedupe semantics, durable acceptance evidence. |
| Consume events/result | Framing, ordering, bytes/usage limits, backpressure, terminal/usage evidence. |
| Request cancellation; lookup/reconcile | Whether compute/billing stops, lookup after ambiguous send, final billing evidence and retention. |

| Jobs adapter operation | Must establish |
| --- | --- |
| Describe runtime/isolation | Actual language, code loading, independent resource/egress enforcement, operator trust and regions. |
| Stage immutable artifact | Digest verification, size/dependency limits, retention/deletion cost. |
| Submit and locate run | Resource caps, TTL starting point, queue/cold-start bounds, dedupe/lookup semantics; billing classification and finite monetary cap only when metered. |
| Observe/cancel/fetch/delete/reconcile | Authenticated owner-scoped states, bounded outputs/logs, cancellation certainty, final charges and deletion evidence. |

Missing optional stream/cancel features can be honestly disabled only if independent
finite completion/resource bounds (and monetary bounds when metered) still hold.
None of these operations implies an HTTP route: protocol/transport remain missing
adapter work, not invented REST services or a wrapper around Bez automation.
Missing arbitrary-code jobs support means the jobs spec cannot ship on Folknet;
model access can still proceed independently.

Staging:

0. This research: no calls, no deployment, disabled specs, provider questions retained.
1. Offline model broker fake: pure policy, vault port, atomic ledger and IPC stream tests.
2. Independently reviewed provider contract + explicit test-account/spend approval:
   conformance fixtures, then separately authorized bounded non-sensitive inference.
   Never treat this document as approval for that test.
3. Jobs fake/local reviewed pure transform, failure/restart/isolation probes. No remote
   code until jobs-specific contract, security and finite billing gates pass.
4. Separately authorized transient hosted pure transform. Generic third-party workers,
   data grants, nested models/jobs and scheduling need later specs and review.

Questions a person/provider must resolve before enabling: canonical provider identity and
code/SDK revisions; supported tasks/model revision identities and arbitrary-code runtime
(if any); endpoint/account discovery and authorization; hard resource enforcement and
billing classification (hard charges only if metered); credential scopes;
privacy/region/retention/deletion; cancellation semantics, usage availability, dedupe
window and receipt lookup; who operates/pays for the broker and runtime. In particular,
can an independent Peek user obtain scoped model access without any Bez service, and
is there an independently usable bounded code-execution facility at all? No affirmative
answer is claimed. Proposed default is user-configured per-profile account and desktop
broker, not a new hosted Peek service.
No person decision blocks completing this wire-neutral design.

## 8. Verification

Docs-only gate: check cited repository paths/symbols, review JSON fragment syntax
(manual review or parsing; state which ran), check disabled frontmatter/dependencies,
inspect JS examples for draft labels
and worker-contract consistency, review authority/cost/lifecycle state invariants,
run `git diff --check`. Do not run existing worker demos in remote mode. Full Electron,
Linux/macOS integration, real provider runtime, spending, isolation, retention and
deployment checks are **unrun**. Future implementation verification belongs to the two
disabled specs; no doc check is evidence of remote conformance.
