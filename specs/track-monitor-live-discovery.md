---
enabled: false
reviewer-model: zai/glm-5.3
touches: [.pi/extensions/track-monitor/, .pi/track-monitor.json]
depends-on: []
---

# Manual track: live discovery and actionable coordinator wake-ups

User explicitly requires the Pi monitor plus spec-track system for rapid parallel
development. Disabled only to prevent a duplicate automated writer; sole asynchronous
author is manual track `track-monitor-live`. Coordinator does not implement this.

## Observed defect

The extension works and the live Pi process owns its scratch lease, but collection
captures a fixed targets list at startup. New tracks/config edits are invisible
until manual reload; completed process-review and P12 authors were missed. Wake-up
wording also biases the coordinator toward status-only narration instead of taking
already-approved next coordination steps. No new authority is granted by this fix.

## Required outcome

- Build on the existing project-local extension, canonical `spec-status.mjs`, Git
  registered worktrees, existing writer runtime records, and existing spec-watch
  scheduler/review/landing contracts. No second development orchestrator/daemon.
- Automatically discover new direct registered manual AND spec worktrees belonging
  to this primary checkout. Apply declared parked/exclude policy; never traverse
  arbitrary outside worktrees, symlink into private trees, expose unrelated parked
  names, or infer completion merely from absence/PID exit. Canonical spec state and
  exact review freshness win; retain ancestor proof for manual landing.
- Pick up valid watchlist/config changes during monitoring without another reload,
  preserving dedupe/checkpoints, pending changes, quota counters, source-error
  thresholds, last-known tips, one lease/timer and in-flight cancellation safety.
  Invalid config must produce a bounded sanitized warning and fail safely without
  silently losing watches or emitting false transitions. Keep explicit targets
  usable for compatibility and CI repository/workflow selection.
- Prioritize actionable completion, gate/review/blocker/landing and CI transitions.
  Continue coalescing while Pi is busy/has queued user messages. No model call on
  unchanged polls; suppress noisy edit/commit churn where possible without losing
  actual completion. Aim for about 30-second polling, 60-second batching and a finite
  30/hour automatic-wake ceiling suitable for rapid parallel work; document chosen
  defaults and retain pending work when rate limited. Never busy-poll the model.
- Wake-up guidance: inspect current evidence; advance already-approved coordinator
  actions (return missing review/fixes to author, request bounded scope proposal,
  land exact reviewed/verified work through existing gates, dispatch explicitly
  approved candidates) rather than just report and stop. Coordinator is not product
  author or substitute reviewer. Preserve all approval/account/credential/spend/
  release boundaries, sole writers, tick locks and scope rules. Do not run /spec-watch
  outside its lock, reset failed-round budgets, or duplicate live agents. Extension
  timer itself stays READ ONLY; only the woken coordinator applies existing authority.
- Preserve print/JSON and linked-worktree exclusion, user off/reload persistence,
  shutdown/abort and ownership-checked lease release, bounded subprocesses/data and
  redaction. No raw logs/argv/errors/notes/prompts/credentials in notifications.
- `/track-monitor status` must clearly show actual activation, last-sample freshness,
  discovery/config mode, pending/throttle health as feasible. One reload may be
  needed to install changed code into this live Pi; after that new track registration
  must work without further reloads. Do not patch/inject into a live Pi process or
  change global trust/config to pretend activation happened.

## Acceptance and review

Keep all existing monitor tests passing; add fake-clock/Pi/status/worktree tests
proving new track detection AFTER startup without config/reload, live config refresh,
invalid-config safety, exclusions, meaningful review/exit/landing transitions,
no duplicate timer/model wake on unchanged or busy polls, preserved rate/checkpoint/
source health, shutdown late-result suppression and redaction. Explicitly distinguish
simulated wake API coverage from actual live-session activation. Real read-only
snapshot smoke check allowed; no real model in tests or CI dispatch/account mutation.

Author verifies and commits, then delegates independent read-only spec-reviewer at
THIS cwd, model `zai/glm-5.3`, fallback only `deepseek/deepseek-v4-pro` on provider
failure. Record VERDICT pass/fail, exact reviewed final tip/spec revision/base,
findings/fixes and test commands/counts. Fix then verify/commit/rereview as needed,
bounded cycles; no commit after passing exact-tip review. No product/native tests
claimed from extension tests. Report any remaining frontend reload dependency.

No primary/other-track/upstream pi-tracks edits, merge/push/tag/CI dispatch/worktree
removal, real inference/jobs, credentials or auth repair. Disposable owned /tmp test
fixtures authorized. Scope contains only existing monitor code/config/docs/tests.
