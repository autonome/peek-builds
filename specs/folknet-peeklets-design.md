---
enabled: false
touches: [docs/design/folknet-peeklets.md, specs/folknet-peeklet-models.md, specs/folknet-peeklet-jobs.md, specs/folknet-peeklets-design.md]
depends-on: []
---

# Design Folknet model access and transient execution for peeklets

User-requested design work, manually owned by the `folknet-peeklets` research track.
Keep disabled: draft contracts, not authorization to run remote code or spend credits.

## Completion

Research deliverables now exist in `docs/design/folknet-peeklets.md`,
`specs/folknet-peeklet-models.md` and `specs/folknet-peeklet-jobs.md`.
Current code evidence, wire-neutral contracts, security/cost/lifecycle limits,
staged gates and future tests are recorded there. Public GitHub/npm discovery did
not establish canonical Folknet documentation; provider conformance remains gated,
not replaced by guessed endpoints or guarantees. Keep all three specs disabled.
See `handoff.md` for the docs-only verification result and remaining decisions.

## Goal

Specify two independently grantable capabilities:

1. Peeklets call models served on Folknet through a profile-scoped broker, without
   obtaining the user's Folknet credential or ambient access to all models/data.
2. Optionally, a peeklet declares a bounded non-UI worker entry that can run as a
   transient Folknet job and return results, rather than moving its whole desktop
   runtime or Chromium/Electron process to remote compute.

Build on `docs/workers-design.md`, `docs/workers-capabilities.md`,
`docs/worker-runtime-portability.md`, the current shared `packages/capabilities/`,
`apps/desktop/main/tile-api.d.ts` and `tools/hello-worker`/`tools/second-worker`
where present. Existing design prose may predate implementations; inspect actual
code before claiming something exists or is missing. Do not turn a same-process
closure, imported untrusted JS or a best-effort fetch shim into a claimed hostile-
code sandbox. Remote-worker credentials/grants, provider inference credentials,
provider job-submit credentials and user data permissions are distinct authorities.

## Deliverables

- `docs/design/folknet-peeklets.md`: current evidence, proposed architecture and API
  examples, security/privacy/cost model, lifecycle/recovery semantics, existing
  worker compatibility, staged implementation and unresolved provider questions.
- Two bounded disabled implementation specs: model access first, optional transient
  jobs second. Explicit dependencies only on verified prerequisites, no fabricated
  ready-to-implement provider protocol. Each has Done looks like and Verify.
- If canonical Folknet docs/SDK contracts cannot be located, list exact unknowns,
  requested references and contract-conformance gate. Never invent endpoints,
  authentication, wire schemas, pricing, arbitrary-code execution or cancellation
  guarantees. User has been asked for a canonical API/jobs reference.

## Required design decisions

Model access: catalogue/task types (not chat-only assumptions), request/streaming
contract, model-ID and parameter validation, capabilities resolved and checked in
main/server, profile credentials outside renderer, explicit data export consent,
per-call/per-tile/per-profile hard bounds and aggregate budgets/concurrency,
usage/cost reservations and reconciliation, unknown-price/unbounded-cost refusal,
cancellation/timeout/unload/profile-switch/suspend behavior, response backpressure,
redacted diagnostics, no silent provider fallback or retry double billing. Clarify
which limits are truly provider-enforced versus local estimates; no promises of
hard spend ceilings without provider support. Model output is untrusted data, not
authority to run tools or mutate the store.

Transient jobs: immutable entry artifact/manifest hash and bounded inputs,
supported runtime/task contract (unknown until provider verified), isolation/trust
requirements, least-privilege worker API and TTL/revocable credential or relay,
network/storage/data permissions, nested model/child-job budget limits (disabled
by default), state/result retention and deletion limits, cancellation/uncertain
outcomes, idempotency/dedupe without exactly-once claims, cold start and desktop
sleep/disconnect/reconnect, persistent owner/run identity, terminal state machine,
artifact/log trust and limits. No desktop windows/cookies/filesystem/OS automation,
parent credentials or unrestricted profile snapshot copied into a job. Stage a
small pure-transform worker before generic background peeklet compatibility.

UI/policy: choose/configure account per profile, explicit grant/install disclosure,
spending/export status, cancel/revoke flows, disabled-by-default remote execution,
no contact until configured and approved, no execution before startup gates.
Separate UI lifetime from job lifetime; transient UI closure is not automatically
proof remote compute stopped. Do not make bounded completion depend on tile
renderer timers or assume suspension keeps a page resident.

## Verify / done

Documentation/spec-only work. Verify cited repository paths/symbols, authoritative
provider sources if available, consistency with current manifest/worker contracts,
disabled frontmatter, example validity and `git diff --check`. Mark Linux/macOS/
provider runtime, spending, isolation and deployment checks unrun. No remote jobs,
model inference, credentials, account changes or paid operations. Commit reviewed
spec/design work in its track and update handoff; coordinator handles landing.
