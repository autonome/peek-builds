# Folknet for peeklets: a small text broker, jobs later

Status: **draft; specs disabled; no implementation or remote operations authorized**.
Companions: `specs/folknet-peeklet-models.md`, `specs/folknet-peeklet-jobs.md`.
This refines the research in `specs/folknet-peeklets-design.md`.

## 1. Evidence and non-dependencies

**Bez is read-only educational reference, never infrastructure.** Peek owns its
broker, adapter, configuration and optional worker host. No Bez checkout, services,
keys, aliases, inventory, machines, lanes, Dagu, Forgejo, scripts or job formats are
required. Running Bez on Folknet does not establish a general Folknet jobs API.
No host bindings, private configs, credentials or session logs were inspected.
No live gateway probes, model calls, jobs, account actions or paid operations ran.

| Evidence class | Established | Not established |
| --- | --- | --- |
| Primary universal Folknet API | None verified | No canonical discovery, SDK, catalogue, jobs runtime or billing contract is claimed. This does not mean services do not exist. |
| Bez `docs/infrastructure.md`, “As discovered” | Describes a deployment using a LiteLLM model gateway and per-key model allowlists; catalogue liveness is not completion readiness | Not a platform guarantee or a Peek service dependency |
| Bez `docs/folknet-inventory.md` | Distinguishes snapshot age/liveness from completion readiness | No universal discovery schema or permission for automatic probes |
| Bez `docs/coordinator-on-folknet.md`, `docs/folknet-writer-design.md` | Illustrate separating credential custody, authority and supervision | Not general worker hosting or transferable subscription rules |
| Bez `docs/job-concurrency.md` | Illustrates aggregate admission, immutable identity, cleanup and uncertain stop problems | Its scheduler/leases/capacity are not Peek resource enforcement |
| Bez public source `crates/generation/src/model.rs` (symbols below) | Concrete OpenAI-compatible text-generation client wire subset | Not proof every Folknet deployment accepts it, nor evidence of remote caps/cancellation |
| Proposed Peek contract below | An independently testable adapter profile and bounded local broker | Not implemented APIs or live provider conformance |

References to Bez identify public source paths, not files Peek loads. Evidence revision
for the inspected model source is its SHA-256 (not a deployment version):
`0fb09814d68ec41c1e00494566d61613514d4b340aaa4de5f4b8679937deb11b`.

### Concrete gateway evidence and deliberate differences

In `crates/generation/src/model.rs`:

- `HttpModelClient::auth_header` constructs optional `Authorization: Bearer <key>`;
  `api_url` appends `v1` unless the base already has a numeric version suffix.
  `complete_watched` sends POST chat/completions with `Content-Type: application/json`.
- `ChatRequest` has `model`, role/content `messages`, `max_tokens`, `stream: true`,
  `stream_options: {include_usage: true}` plus seed and model-specific thinking fields.
- `ChatChunk`, `ChunkDelta`, `parse_chat_body` read `data:` JSON, content deltas,
  nullable content, reasoning/refusal, finish reasons and terminal `[DONE]`.
  Missing `[DONE]` is an error. The reference also accepts nonstream JSON replies.
- `Usage` reads `prompt_tokens`, `completion_tokens`, `total_tokens`; the reference
  defaults missing usage to zero. Peek instead preserves **unknown**, not fabricated zero.
- `with_retry` repeats even failed POST attempts up to three times. Peek explicitly
  **does not copy this**: no automatic POST retries, fallback or receipt lookup fiction.
  Errors are propagated with context/raw snippets in that client, not a documented
  provider error schema. Peek maps status/transport errors to redacted codes.
- No provider cancel endpoint, idempotency guarantee, enforced remote deadline or
  billing receipt protocol is established by these symbols. Closing a local reader
  is not evidence that remote generation stopped.

Peek's proposed `openai-text-v1` subset below is intentionally narrower and stricter:
no seed/thinking extensions, no tools, no JSON-response fallback, no model discovery.
An operator must confirm this exact subset for their target, including max_tokens
semantics (especially reasoning tokens), finish/usage behavior and retention policy.
Offline implementation needs no fictional universal Folknet SDK or public provider docs.
Operator confirmation gates **deployment**, not fake-backed engineering.

### Peek source baseline

| Files / symbols | Consequence |
| --- | --- |
| `packages/capabilities/index.js`, `index.d.ts`: `validateTileManifest`, `resolveCapabilities` | Models/jobs absent; unknown keys do not confer authority. Explicit validation/reduction/types/tests required; manifests still require tiles. |
| `packages/capabilities/codegen.js`, `check-freshness.js`; `apps/server/capabilities.js`; `apps/desktop/main/tile-manifest.ts` | Shared vocabulary, generated server projection; no provider manifest fork. |
| `apps/desktop/main/tile-api.d.ts`, `tile-preload.cts` | Add plain-data promise facade; no AsyncIterator/AbortSignal serialization assumption. |
| `apps/desktop/main/tile-ipc-gate.ts`: `registerTileIpc`, `runPipeline` | Token/sender binding exists, but default states include LOADING and trustedBuiltin bypasses capability/state checks; missing state probe can skip rejection. Broker independently fails closed. |
| `apps/desktop/main/tile-ipc.ts` | Network fetch buffers bodies; not an inference stream or credential boundary. Feature-scoped secrets cannot hold host account keys. |
| `apps/desktop/main/feature-secrets.ts`: `SecretStore`, `EncryptedFileSecretStore`; `electron-secret-cipher.ts` | Reuse backend/cipher only with an isolated host namespace; unavailable cipher refuses access. |
| `apps/desktop/main/entry.ts`, `runtime-entry.ts`, `feature-startup.ts`, `profiles.ts` | Startup notice precedes runtime; profile selection/lock and registry readiness must precede broker use. profiles uses `node:sqlite`. |
| `apps/desktop/main/tile-suspension.ts`, `tile-lazy.ts` | Suspension is main-owned. Existing hold is bounded convenience, not a remote lease. |
| `tools/hello-worker/run.mjs`, `manifest.json`, `worker.js` | Named/default entry demo, optional memory store; real-store mode can read credentials. Not run here. |
| `tools/second-worker/run.mjs`, `worker.js` | RunContext second argument, import-time API probe, cache-busted root module, simulated channel/store/timer. Not isolated module graph, scheduler or hard deadline. |
| `apps/server/grants.js` | Existing MCP grants lack run TTL/resource budgets; never export them as worker credentials. |

`docs/workers-design.md`, `docs/workers-capabilities.md` and
`docs/worker-runtime-portability.md` supply host/entry context, not proof of isolation.
A closure, replaced fetch, cache-busting URL or publisher signature does not sandbox
hostile JS. Serialized entry calls do not prove async runs cannot overlap.

## 2. Model-first milestone and trusted configuration

Desktop only, one task `text.generate`, one selected-text demonstration **test harness**,
one adapter profile, owned/unpriced accounts only. No generic inference platform,
commercial billing ledger, remote jobs, scheduling, server broker or account service.
Embeddings/images/classifiers remain future task-discriminated contracts, not chat
parameters. `models` is independent of `network`, `secrets` and future `jobs`.

A small trusted per-profile broker panel (host-owned, not a peeklet) records:
operator label, exact HTTPS chat-completions URL, `openai-text-v1`, host credential
reference, local model IDs mapped to operator-supplied wire IDs, revision label,
contact approval, operator-attested `unpriced-owned` allocation and resource policy.
No default address/alias, URL inference, LAN/mDNS scan, GET models, readiness probe or
fallback. Model revision is operator-labelled unless deployment offers immutable IDs;
mutable alias changes require reconfirmation. Configuration is not export consent.
`metered` and `unknown` billing refuse before contact in v1, including builtin callers.
The panel edits only this profile configuration through a main-owned port with exact
trusted-window sender checks, never a tile capability/builtin bypass. It displays the
full destination, allowlist, unpriced attestation and unresolved-work acknowledgment;
no feature may set account/destination. Offline tests exercise it with a fake vault.

Reject URL userinfo/query/fragment, redirects, insecure TLS and caller URLs/headers.
Use exact configured URL, system TLS validation, no ambient cookie/session credentials,
no feature network proxy, no environment-derived auth. Production requires HTTPS;
loopback HTTP is injected by offline tests only, never a user-profile escape hatch.
Credentials reside in a separate host-owned encrypted file/SecretStore instance under
the selected profile, namespace `model-broker/accounts/<accountId>`, not a feature ID
accepted by `tile:secrets:*`; never synced or exposed via api.secrets. Fail closed when
secure cipher unavailable. Broad gateway key scope remains an operator risk.

Host-issued one-shot export approval binds profile/install/grant revision, account,
destination revision, purpose, exact selected UTF-8 text hash and bytes; expires in
60 seconds and is consumed atomically on admission. Caller passes matching text only.
The harness explicitly presents the text and destination before approval. No implicit
profile, cookies, hidden content, feature secrets or entire-page export. Model output
is escaped text, never HTML/tools/code execution or an instruction to mutate Peek.

## 3. Exact proposed Peek facade and bounded transport

Fragment below is proposed manifest authority, not an installable complete manifest:

```json
{
  "models": {
    "allow": [{"model": "operator:text-v1", "task": "text.generate"}],
    "maxInputBytes": 16384,
    "maxOutputBytes": 32768,
    "maxOutputTokens": 512,
    "maxDurationMs": 30000,
    "maxConcurrent": 1
  }
}
```

All numbers are positive safe integers no higher than broker hard limits. Unknown
fields/tasks reject. Resolved authority intersects manifest, installed consent, current
grant, profile policy and configured allowlist; requesting does not grant. No wildcard.

All methods return promises of plain cloneable data; no callbacks, signals or iterators
cross contextBridge. Proposed `api.models` methods:

- `start({model, task:'text.generate', input:{text}, maxOutputTokens,
  exportApprovalId, clientRequestId}) -> {callId}`. IDs are opaque bounded strings;
  dedupe key is owner-scoped, 1–64 ASCII identifier characters. Same key/request hash
  returns same callId, never resends; conflicting reuse rejects. No arbitrary parameters.
- `poll({callId, afterSeq}) -> {events, lastSeq}`. One outstanding poll per owner;
  returns immediately, at most 8 events / 32 KiB. afterSeq acknowledges only previously
  delivered events; stale cursor below retained floor yields `CURSOR_EXPIRED` and status,
  not a replay. Monotonic integer seq starts at 1. No push IPC or background delivery.
- `cancel({callId}) -> {callId, localState, remoteState}`; idempotent best-effort abort.
- `status({callId}) -> {callId, localState, remoteState, usage, errorCode}`; never resends.

Events are `{callId, seq, kind:'delta', text}` or `{callId, seq, kind:'terminal',
outcome, remoteState, usage, errorCode}`. Terminal outcome is `completed|truncated|
refused|failed|aborted`; remoteState is `finished|unknown|not-sent`.
Usage is null or `{promptTokens, completionTokens, totalTokens}` of nonnegative safe
integers, explicitly provider-reported, not billed/proven compute. Missing fields make
usage null. One local terminal event per call; polling may redeliver it until acknowledged
(consumer dedupes seq). After terminal retention expires, status still reports terminal.
No claim of exactly-once network delivery. Error codes are fixed enum, never raw bodies.

```js
// Proposed future harness API; all arguments/results cross the bridge as plain data.
const { callId } = await api.models.start({
  model: 'operator:text-v1', task: 'text.generate', input: { text: selectedText },
  maxOutputTokens: 128, exportApprovalId, clientRequestId: 'selection-1'
});
let afterSeq = 0;
let terminal = false;
while (!terminal) {
  const batch = await api.models.poll({ callId, afterSeq });
  for (const event of batch.events) {
    renderAsText(event); // Harness escapes all content; no HTML evaluation.
    terminal ||= event.kind === 'terminal';
    afterSeq = event.seq;
  }
  if (!terminal) await delay(100); // Harness helper, not a broker timer.
}
```

IPC channels `tile:models:start|poll|cancel|status` use token/sender binding through
registerTileIpc, explicit `models` capability and READY/VISIBLE states. The broker
**also** checks owner/profile/install/grant revisions, real state probe (missing denies),
startup acknowledgment, unlocked selected profile, registry readiness and account policy,
even for trustedBuiltin. Start rechecks immediately before dispatch. Internal lifecycle
cancel/recovery has no renderer grant requirement; it cannot start new work. Old IDs
never authorize a new profile/installation. Denied capability means facade absent.

Hard local ceilings (lower policy wins): 16 KiB UTF-8 input; 24 KiB serialized request;
32 KiB output; 256 KiB decoded wire body; 8 KiB per SSE event; 4 KiB delta; 30 s from
admission including connect/headers/body; 5 s headers timeout. One active call/profile,
no queue, one broker/profile; max 10 admissions/hour, 100/day, 1 MiB input and 2 MiB
reserved output/day. Profile-wide totals also bound installs/accounts; per-install limits
may only lower them. No cross-process/shared-account commercial ledger. Requests from
other applications or another Peek profile are explicitly outside this quota.

Event ring: at most 16 events / 64 KiB per call, including reserved terminal slot.
Poll does not reset deadline. If unacknowledged output stalls for 5 s or capacity would
be exceeded, abort reader and emit terminal `aborted`/`SLOW_CONSUMER`, remote unknown.
Reads pause only within these bounds. Wire and output limits include discarded reasoning
and metadata in wire count; no unbounded decompression (request identity encoding,
reject compressed replies). Terminal/status remain queryable after ring removal.

## 4. Exact proposed openai-text-v1 wire contract

Send once to configured URL; headers `Authorization: Bearer <host-key>`,
`Content-Type: application/json`, `Accept: text/event-stream`,
`Accept-Encoding: identity`. Bearer is required by this profile; operator confirms key
scope. No caller headers, cookies, tools, system prompt or application data injection.
The body, using the configured wire model ID, is exactly:

```json
{
  "model": "fake-text-v1",
  "messages": [{"role": "user", "content": "Explicitly approved selected text"}],
  "max_tokens": 128,
  "stream": true,
  "stream_options": {"include_usage": true}
}
```

`fake-text-v1` is fixture-only, not a Folknet alias. `max_tokens` is a **requested**
remote bound, never claimed enforced without operator evidence. v1 sends selected text
as the prompt; no automatic summarization wrapper outside the approved content.

Require HTTP 200 and text/event-stream. Incrementally decode UTF-8 (reject invalid),
handle arbitrary byte/line splits, LF/CRLF, comments and multiline `data:` joined per
SSE; enforce event bound before JSON parsing. Ignore bounded SSE id/event fields; no
EventSource reconnection. JSON chunks have at most one choice, index 0 (missing index
accepted); content string/null, role-only/empty deltas allowed. Usage-only choices:[]
is allowed. Reject extra choices, tools/function calls, nonempty reasoning fields or
unknown finish reasons with `PROTOCOL`; no implicit task extension. Bounded unknown
metadata fields may be ignored, never executed. Refusal text is untrusted display data.

Require a finish_reason (`stop|length|content_filter`) then `[DONE]` before EOF;
finish maps to completed/truncated/refused. Usage may occur between finish and DONE;
no more content after finish. DONE alone, malformed JSON, premature EOF, in-stream
error object or conflicting terminal/usage is protocol failure, remote unknown. Usage
is optional; successful terminal without usage remains usage null. Provider stream IDs
are optional diagnostics, not durable receipts or permission to look up requests.

Map 401/403 to AUTH, 429 to RATE_LIMIT, other 4xx to REQUEST_REJECTED, 5xx to
PROVIDER, TLS/connect/reader errors to TRANSPORT. Read/discard only bounded error bytes;
never expose provider error messages or Retry-After-driven retries. Remote state is
conservatively unknown after dispatch, even on error statuses, absent trusted evidence
of non-execution. A valid complete stream establishes finished response, not billing.
Cancel closes local transport only; this profile defines **no remote cancel/lookup**.

## 5. Persistence, uncertainty and lifecycle

New profile-local `model-broker.sqlite` via `node:sqlite` stores schema version, call ID,
owner `{profileId, installId, installRevision, grantRevision}`, client key/request hash,
account/config/export revisions, timestamps, reserved bytes/tokens/time, local/remote
states and reported usage. No prompt/output/credential/raw provider error persistence.
In-memory event text disappears on restart; status is durable, not a result archive.
Host vault is separate. Quota rows and calls update atomically in BEGIN IMMEDIATE
transactions. Single profile broker holds a lifetime SQLite BEGIN EXCLUSIVE transaction on a separate
`model-broker-owner.sqlite` connection (busy timeout zero); second owner fails closed
on SQLITE_BUSY. This sidecar has no call data and is not the transactional call DB.
Process death releases the lock; do not delete/recreate its file to bypass ownership.
Do not rely solely on desktop's existing profile single-instance lock. Recover call
state before allowing any admission.

Durable state: `prepared -> dispatching -> terminal`. Persist dispatching **before**
HTTP starts. Crash in prepared is not-sent; dispatching on recovery becomes local
terminal aborted / remote unknown. Persist terminal before exposing it. Any write
failure stops admission/aborts transport; recovery conservatively treats dispatching
as unknown. No POST retries, receipt lookup requirement or replay on view restoration.
User must explicitly create a new approved call with a new key to try again.

Reserve full per-call local resource quotas at admission and consume them for that
quota period even on cancel/failure; never refund on local abort. Clock rollback cannot
reset quotas (persist monotonic high-water wall date/hour). Keep compact dedupe/call
metadata 30 days, max 3000 records; refuse if full rather than evict uncertain identity.
Dedupe guarantee is bounded to that retention; caller must not reuse expired keys.
Daily reset does not erase unknown outcomes. Unknown remote execution sets a durable
profile admission latch; only an explicit operator acknowledgment of unresolved remote
work clears it, not timeout/restart/day rollover. No invented capacity reconciliation.

| Lifecycle | Model policy |
| --- | --- |
| Hide | Continue within existing 30 s deadline; no hidden resubmission. |
| Unload/crash/suspension/disable/uninstall/grant revoke | Abort local stream, record remote unknown unless already finished; no output to detached owner. |
| Profile switch/lock | Stop admissions, abort, clear in-memory output and account key, prevent cross-profile polling/delivery. |
| Sleep/disconnect | Best-effort abort; elapsed deadline checked before accepting any post-wake bytes. Remote stop unverified. |
| Restart | Recover durable state and latch; never resend; status only for current authorized owner. |

Hold expiry cannot affect safety; broker owns timers and storage. Diagnostics contain
only IDs/timings/counts/fixed errors. Content diagnostics are out of scope. Operator
must confirm confidentiality, training use, retention/deletion, region and trust for any
live selected data. TLS does not hide content from gateway/compute operators.

Local limits **do not bound** remote queue duration, CPU/GPU time, memory, actual output
tokens, cancellation or other clients. For owned compute, v1 permits explicit operator
attestation accepting these unverified remote bounds plus the latch/quota policy; it
must not advertise hard remote resource or monetary caps. Metered/unknown accounts
remain excluded, not forced through a speculative billing system.

## 6. Optional remote jobs: separate disabled follow-up

Models do not require arbitrary-code hosting. Jobs retain their own disabled spec and
need an actual independent runtime/control plane; no Bez automation adapter. First
entry is one reviewed immutable pure text transform, no external I/O, data, models,
children, scheduler or generic background init. Existing worker signature remains
`(api, ctx) => Promise<unknown>` with command trigger params, signal/deadline/waitUntil
in second-argument RunContext; API only exposes bounded redacted log.

Requested test bounds: 64 KiB JSON input/output, 30 s wall including waitUntil,
1 s CPU, 64 MiB memory, 16 KiB logs, one/install and two/profile concurrent, queue four.
These are not verified Folknet features. Require independent enforcement of busy-loop,
memory/CPU/egress/deadline/TTL while desktop offline, fresh isolated module graph,
immutable bundle/entry/dependency/ABI/runtime/policy digests and provider verification.
Credentials stay outside isolation. Provenance identifies publisher, not safe code.
Future data relay must be run/TTL/operation/item/budget-bound, never generic MCP grants;
nested models/children absent by default even if desktop grant has them.

Persist run intent/owner/digests/reservations before submit; keep orthogonal
cancelRequested and remote unknown until provider evidence. No replay after ambiguity,
no claim local abort stops execution. Results/logs are bounded hostile data, no automatic
URL fetch or artifact import. Proposed local terminal result TTL 24 h, retain uncertain
metadata for reconciliation; remote deletion is confirmed/unsupported/pending, never
promised erasure. Missing bounded runtime means jobs cannot ship on Folknet as written;
it does not block model fixtures or operator-configured model profile.

Jobs-specific questions only: independently obtainable code execution? supported runtime
and artifact format? enforced isolation/egress/resource/TTL? authenticated run lookup,
stop and deletion evidence? queue/cold-start/storage and billing policy? No affirmative
answer or deploy permission is inferred. See `specs/folknet-peeklet-jobs.md` for follow-up.

## 7. Implementation scope and staged gates

Concrete new modules/symbols and acceptance plan are in the model spec. Defaults chosen:
text only, desktop profile broker, no queue, pull-based plain-data events, owned/unpriced
only, operator-configured exact endpoint, no discovery, metadata-only persistence and
uncertain-outcome latch. No human decision blocks this disabled offline design.

1. Separately authorize offline implementation: shared capability and pure policy,
   SQLite recovery, injected vault/HTTP adapter, fake SSE fixtures and bridge harness.
2. Offline acceptance passes without network except explicitly local fixture server.
   No universal public Folknet API prerequisite.
3. Before live enablement: target operator confirms wire subset, identity/model labels,
   unpriced allocation, key custody, privacy and acceptance of unverified remote bounds.
   Separately authorize any OS/live conformance tests; this design grants none.
4. Jobs, metered accounts and other tasks need separate scoped approval/spec work.
   Keep both existing specs disabled now; the small trusted profile panel is included
   in the future offline model milestone, not a generic settings/account service.

## 8. Docs-only verify gate

Check cited paths/symbols, parse JSON fences, syntax-check JS fences as async function
bodies with external harness names left unresolved, validate disabled frontmatter and
empty dependencies, check projection freshness, and run `git diff --check`. Review
owner/builtin/startup/export/lifecycle/uncertainty invariants. No full Electron gate
needed for docs-only changes. Implementation/OS/live provider/isolation/spending tests
are **unrun**; fixture plans do not establish deployment guarantees.
