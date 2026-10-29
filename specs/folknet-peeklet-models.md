---
enabled: true
touches: [packages/capabilities/index.js, packages/capabilities/index.d.ts, packages/capabilities/test.js, apps/server/capabilities.js, apps/desktop/main/tile-api.d.ts, apps/desktop/main/tile-preload.cts, apps/desktop/main/tile-ipc.ts, apps/desktop/main/runtime-entry.ts, apps/desktop/main/model-broker/, docs/design/folknet-peeklets.md]
depends-on: []
---

# Offline text broker and operator-configured gateway profile

**Approved for automated offline implementation.** No credentials, real inference,
jobs, billing, deployment or live probes authorized.
Contract: `docs/design/folknet-peeklets.md` §§1–5, 7–8. Empty dependencies mean no
missing repository prerequisite; target deployment approval is separate.

**Bez is reference only.** Independent Peek-owned broker for an operator-configured
Folknet gateway; no Bez installation, service, script, aliases, inventory, keys,
checkout, lanes, machines, Dagu or Forgejo dependencies. Its public model client is
wire evidence, not a universal Folknet contract. Design §1 pins evidence and differences.

## Scope of this spec: the offline broker core

This spec delivers the offline broker core only. Three dependent specs carry
the integration that needs files outside these touches, because the persistent
install/grant identity and a synchronous preload bootstrap do not exist yet:

- `folknet-models-authority.md` (A): registry-owned install identity, models
  consent and grant revision, and token binding.
- `folknet-models-runtime.md` (B): synchronous preload bootstrap, the exposed
  `models` facade, broker construction in `runtime-entry.ts`, and lifecycle wiring.
- `folknet-models-panel.md` (C): the actual trusted profile panel window.

Within this spec: production `models` stays absent from `window.app`,
`setModelIpcHost(null)` stays the production default, and `runtime-entry.ts`
constructs no broker. The profile panel and selected-text harness are host
controllers tested offline, not windows. Acceptance items 2, 6 and 7 below are met
by component tests with injected owner/state/lifecycle ports; their real Electron
counterparts belong to B and C. The milestone as a whole is complete only when
this spec and A, B and C have all landed.

## One milestone, not a platform

Deliver a fake-backed desktop profile text broker plus
`openai-text-v1` adapter tested against loopback HTTP/SSE fixtures. No public universal
Folknet SDK/docs prerequisite for offline engineering. Live support remains disabled
until target operator confirmation. Text generation only; no jobs, embeddings, images,
classifiers, tools/agents, store mutation, fallback, model discovery, readiness probing,
generic settings/account service, server broker or commercial billing ledger. Include
only a small host-owned profile broker panel for destination/account/allowlist policy. Other tasks need
separate discriminated schemas, not arbitrary chat passthrough parameters.

Only `unpriced-owned` operator-attested accounts accepted. `metered`/`unknown` refuse
before contact. No fake currency/price catalogue or hard monetary-cap claim. Local
resource quotas are hard; remote token/compute/queue/cancel bounds remain explicitly
unverified unless confirmed by operator. Owned-compute deployment must explicitly
accept that limitation; it is not silently inferred from missing prices.

## Exact facade / transport

Implement exactly design §3 `api.models.start`, `poll`, `cancel`, `status`: promise
methods with plain objects and opaque owner-bound call IDs. No AsyncIterator,
AbortSignal or callback crossing contextBridge. Pull/ack via `afterSeq`, max one
outstanding poll, 8 events/32 KiB per response; main ring 16 events/64 KiB including
terminal reserve, delta max 4 KiB, slow consumer 5 s. One local terminal record;
transport redelivery dedupes seq, no exactly-once delivery claim.

`start` accepts only `{model, task:'text.generate', input:{text}, maxOutputTokens,
exportApprovalId, clientRequestId}`. Strict unknown-key/type/UTF-8-byte/integer/schema
validation; no caller URLs, headers, tools, opaque parameters or provider key. Same
owner/key/hash returns same ID; conflict rejects. Poll/status/cancel validate current
owner/install/profile/grant and READY/VISIBLE state. Lifecycle cleanup uses host-only
cancel path that cannot start requests. Output is escaped data, never executed.

All four `tile:models:*` channels use registerTileIpc plus independent broker checks:
real state probe (missing denies), current capability/grant revision, bound sender,
startup risk acknowledgment, selected/unlocked ready profile and registry, approved
account/contact/export policy. **trustedBuiltin does not bypass any check.** Recheck
immediately before dispatch. Revocation blocks admissions and cancels existing work.
`models` grant is separate from network/secrets/jobs, facade absent without grant.

## Concrete file / symbol plan

Existing files (avoid broad main-directory changes):

- `packages/capabilities/index.js`: extend `validateTileManifest` / `resolveCapabilities`
  for exact design §3 models fragment, finite bounded fields and explicit allowlist
  intersection; preserve existing tiles requirement. `index.d.ts`: model request/grant
  types. Add new `packages/capabilities/test.js` for validation/reduction regressions. Regenerate
  `apps/server/capabilities.js` via existing codegen, never hand-maintain projection.
- `apps/desktop/main/tile-api.d.ts`: proposed ModelsApi/plain envelope types;
  `tile-preload.cts`: capability-gated promise wrappers for four methods, no push listener.
- `apps/desktop/main/tile-ipc.ts`: invoke new `registerModelIpc` at existing registration
  boundary; existing gate defaults/builtin exemption do not confer model authority.
- `apps/desktop/main/runtime-entry.ts`: construct one `ModelBroker` only after profile
  path, startup and feature registry readiness; inject owner/state/lifecycle ports.
  No broker imports in notice process or profile picker; clear on profile teardown.

New, clearly scoped directory `apps/desktop/main/model-broker/`:

| Module / proposed symbols | Responsibility |
| --- | --- |
| `contract.ts`: `ModelRequest`, `ModelEvent`, `ModelAdapter`, `BrokerPorts` | Plain task-specific API and injected clock/state/vault/HTTP contracts |
| `policy.ts`: `validateStart`, `admitModels` | Pure schema, grant, approval/hash, account and resource intersection; no Electron or network |
| `broker.ts`: `ModelBroker` | Admission, one active call, ring/ack, timers, owner checks, lifecycle cancel, unknown latch |
| `store.ts`: `ModelStore` | Profile SQLite schema, atomic quota/intent/dedupe/terminal persistence and recovery |
| `account-vault.ts`: `ModelAccountVault` | Dedicated host SecretStore/cipher backend, never registered with feature secrets; fail closed |
| `openai-text.ts`: `OpenAITextAdapter` | One configured URL, exact headers/body and bounded incremental SSE state machine; no retries/lookup |
| `ipc.ts`: `registerModelIpc` | Four explicit guarded IPC handlers; no trust bypass, deep validation and owner extraction |
| `profile-panel.ts`: `ModelProfilePanel` | Small trusted host-owned profile panel: exact destination, credential entry, model allowlist, unpriced attestation/contact policy and unknown-work acknowledgment; main-owned sender-checked port, never exposed to tiles |
| `selection-harness.ts`: `SelectionHarness` | Test-only selected-text approval/renderer harness over the same broker; not another settings/account service |
| `policy.test.ts`, `store.test.ts`, `broker.test.ts`, `openai-text.test.ts`, `ipc.test.ts`, `profile-panel.test.ts`, `selection-harness.test.ts` | Offline suites below; fixture server injected only in tests |

Reuse backend/cipher from `feature-secrets.ts` / `electron-secret-cipher.ts` without
modifying feature APIs. Use node:sqlite as existing profiles code does, new profile-local
`model-broker.sqlite`, separate encrypted account file and lifetime SQLite exclusive
ownership sidecar as in design §5. Trusted profile panel port initially tested with a
fake vault; exact trusted-window sender checks deny feature/builtin configuration.
No hidden feature-configurable endpoint/key path; no generic account service.

## Durable bounds / lifecycle

Implement design §§3,5 constants: 16 KiB input, 24 KiB request, 32 KiB output,
256 KiB wire, 8 KiB SSE event, requested 512 output tokens max, 30 s total, 5 s headers;
one active/profile, queue zero, 10/hour, 100/day, 1 MiB input and 2 MiB output reserved/day.
No cross-process commercial account ledger. Exclusive crash-safe broker ownership/profile
and SQLite BEGIN IMMEDIATE protect all window admissions; second owner refuses.
Other apps/profiles using account remain outside Peek quota, disclosed to operator.

Persist metadata-only call/quota records and dispatching before send; terminal before
delivery. No content/key/raw errors persisted. Crash recovery: prepared is not-sent;
dispatching is aborted/remote unknown. No automatic POST retry/replay, no provider receipt
lookup prerequisite. Reserve full quotas even on failure; never refund local abort.
Unknown remote outcome durably latches new profile admissions until explicit operator
acknowledgment; timeout/restart/day rollover cannot clear it. Retain metadata/dedupe
30 days, cap 3000 records, refuse when full; clock rollback cannot reset quotas.

Hide continues bounded work; unload/crash/suspension/revoke/uninstall cancels locally.
Profile lock/switch also clears key/output and prevents cross-profile delivery.
Sleep best-effort abort and enforce deadline before wake data acceptance. Hold is
optional convenience, not correctness. Status recovery never reconstructs content or
resubmits. Account/destination revision changes require renewed contact/export and
unpriced attestation; no secrets in feature namespace or synced settings.

## Offline acceptance / done

1. Capability tests: allowlist intersect, no request-as-grant, unknown keys/tasks/model,
   NaN/Infinity/unsafe/negative values, output/time bounds; network/jobs not implied.
2. Policy/IPC: stolen IDs, cross-profile/install/sender, stale grant, builtin bypass,
   LOADING/null probe, locked/not-ready profile, pre-startup, no account/contact/export,
   expired/reused approval, changed selected-text hash, missing secure storage. Zero sends.
3. SQLite fault injection: all prepare/dispatch/terminal crash points, two windows,
   second process refusal, quota transactions/dedupe races, same key/conflicting payload,
   storage errors, cap/retention, clock rollback, unknown latch survives restart/reset;
   explicitly acknowledged new work uses new approval/key. No automatic resubmit.
4. Fake HTTP/SSE: assert exact URL/headers/body/max_tokens; arbitrary UTF-8/CRLF chunk
   splits, comments/multiline SSE, role-only/null deltas, usage-only final chunk, missing
   usage remains null. stop/length/content_filter map correctly. Reject missing finish
   or DONE, duplicate/conflicting usage, content after finish, invalid UTF-8/JSON, extra
   choices, tools/reasoning/error chunks, compression, oversized event/body/output,
   redirects/wrong MIME/TLS failure/nonstream JSON. No provider messages leak.
5. Bounded stream: zero/stalled polling, ring overflow, invalid ack, concurrent poll,
   slow consumer, deadline/headers timeout, cancel races and terminal redelivery;
   memory stays bounded, one local terminal, remote unknown after ambiguous dispatch.
   401/403/429/4xx/5xx/transport fail with fixed error codes; exactly one POST attempt.
6. Lifecycle harness: hide vs unload, hold expiry, suspension, sleep/wake, profile
   switch/lock, revoke/uninstall, detached sender, late chunks after abort, restart.
   No cross-owner output, replay or content persistence; escaped malicious output never
   invokes tools/mutates datastore. Seeded keys/prompts/raw errors absent from diagnostics.
7. Selected-text harness: trusted test config + explicit snapshot approval -> fake text
   output and provider-reported/unknown usage -> cancel/reopen status. No generic settings
   service or automatic whole-page/profile export. Panel tests reject untrusted senders,
   never read back entered keys and require reapproval on destination/account changes.
   Show actual destination/owned-compute
   attestation and uncertain outcome, not a fabricated price/cancellation guarantee.

Future implementation verify: targeted repository TS test/type/lint scripts for these
new modules (select exact commands from current package scripts when implementing),
shared capability tests, `node packages/capabilities/check-freshness.js`,
`git diff --check`. Passing fixtures is offline completion, not deployment conformance.

## Separate live release gate

Operator confirms identity, exact URL and wire subset, model revision/alias policy,
max_tokens/reasoning behavior, finish/usage semantics, scoped Bearer key and secure OS
custody; attests unpriced allocation and accepts unverified remote bounds; approves
privacy/training/retention/region for exported text. Only then separately authorize
bounded non-sensitive live/OS tests. No canonical universal Folknet API, remote cancel
or receipt lookup is assumed. Metered access needs a later scoped spec, not a billing
platform prerequisite here; panel wiring must not enable live transport before approval. Jobs stay disabled
independently. No live provider/OS/spending/isolation tests were run by this design track.
