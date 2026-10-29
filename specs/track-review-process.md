---
enabled: false
reviewer-model: zai/glm-5.3
touches: [.pi/APPEND_SYSTEM.md, docs/track-review-process.md, specs/folknet-peeklet-models.md, specs/startup-profile-picker.md, specs/macos-signing-and-notarization.md]
depends-on: []
---

# Manual track: author-owned independent review

User approved this bounded process update. Disabled only to prevent a duplicate
spec-watch writer; sole async writer is manual track `track-review-process`.

## Goal

Coordinator owns scope, scheduling, acceptance, landing and CI dispatch, NOT product
implementation or substituting its own opinion for independent review. Each track
author owns implementation, verification and a separate read-only reviewer-agent
review/fix cycle before offering its work for landing. Apply to manual and automatic
tracks; retain existing automation's final exact-SHA approval gate.

## Requirements

- Default review model `zai/glm-5.3`; permitted fallback
  `deepseek/deepseek-v4-pro`. Both are registered by local `pi --list-models`.
  Do not use Folknet-hosted models/endpoints, silently fall back to a writer model,
  read credentials, or change machine-wide auth/model configuration.
- Use existing supported `reviewer-model` frontmatter for the three named active
  implementation specs. Do not amend completed specs or unrelated old tracks and
  accidentally reopen landed work. Never invent tracks.json model settings.
- Add concise project Pi instructions and a source-backed process runbook: author
  verifies and commits; delegates independent read-only spec-reviewer with explicit
  model and exact authority/base/tip/gate evidence; handles concrete review fixes;
  reruns affected/full declared gates and rereview as required. Bounded failure
  rounds; unresolved scope/blockers return to coordinator without self-approval.
- Record reviewer model, actual verdict, exact reviewed commit/spec revision,
  concrete findings, response and gate results in handoff. A stopped process,
  successful tests, component-only completion or author self-review is not approval.
  Rebase/new code/spec changes invalidate prior exact-SHA approval.
- Reviewers never edit product files, commit/rebase/merge, dispatch CI, access
  credentials, rerun expensive suites or broaden scope. Authors remain sole writers.
  Avoid a generic new workflow platform/tool when existing prompt/frontmatter
  contracts suffice. Do not modify pi-tracks or protected user directories.
- The process-update author must itself obtain independent GLM/DeepSeek review
  against THIS brief and its committed diff before reporting ready. Failed reviews
  need author fixes and fresh exact-tip review. Docs-only verification is sufficient
  here: supported-field parsing, scope/path/command checks, whitespace and review;
  do not claim this runs a product or native OS gate.

No merge/push/tag/dispatch, no worktree removal, no primary/other-track edits by
worker. Coordinator will propagate the reviewed policy to existing tracks. This
spec does not authorize live Folknet inference/jobs or broaden any product spec.
