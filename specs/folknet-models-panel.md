---
enabled: true
touches: [apps/desktop/main/model-broker/**, apps/desktop/main/runtime-entry.ts, apps/desktop/renderer/model-profile/**, apps/desktop/tests/desktop/model-profile-panel.spec.ts, docs/design/folknet-peeklets.md]
depends-on: [folknet-models-runtime]
---

# Folknet models C: the trusted profile panel window

Milestone C of the Folknet peeklet models split (`folknet-peeklet-models.md`,
"Scope of this spec"). Offline only: real transport stays disabled; acceptance
uses an injected fake transport. The proposal behind this split is in that
track's handoff, "Proposed scope amendment" §5.

## What changes

- A window owner and a narrow sender-checked main/preload port for the existing
  `model-broker/profile-panel.ts` `ModelProfilePanel` controller, in or beside
  `model-broker/`.
- `apps/desktop/renderer/model-profile/` (`model-profile.html`, `model-profile.js`,
  `model-profile.css`): shows the exact destination, model allowlist, write-only
  credential entry, unpriced attestation and contact policy, export snapshot
  consent and unknown-work acknowledgment, using existing
  `renderer/components/index.js` exports. No shared component changes, no generic
  settings service.
- Opened from `runtime-entry.ts` through a host-owned menu command; the settings
  feature and builtin renderers get no configuration API.
- Registered with the existing window-machine APIs, on the profile session, with an
  isolated preload, navigation and new windows blocked, and ports disposed on
  destruction.

## Done

`apps/desktop/tests/desktop/model-profile-panel.spec.ts`: real trusted window
navigation and sender rejection, escaped output, no key readback, reapproval on
revision change, unknown-latch acknowledgment, cancel/reopen. Existing controller
tests still pass. With this landed, the Folknet models milestone is complete
offline; live release stays behind the core spec's separate live release gate.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
```

The Playwright spec runs headless under the `peek-bg-run` conventions.
