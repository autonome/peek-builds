---
enabled: true
touches: [apps/desktop/main/tile-launcher.ts, apps/desktop/main/tile-tokens.ts, apps/desktop/main/tile-ipc.ts, apps/desktop/main/tile-preload.cts, apps/desktop/main/tile-api.d.ts, apps/desktop/main/runtime-entry.ts, apps/desktop/main/main.ts, apps/desktop/main/feature-startup.ts, apps/desktop/main/tile-lifecycle.ts, apps/desktop/main/model-broker/**, apps/desktop/main/*.test.ts, apps/desktop/tests/desktop/model-facade.spec.ts, apps/desktop/tests/desktop/model-runtime.spec.ts, docs/design/folknet-peeklets.md]
depends-on: [folknet-models-authority]
---

# Folknet models B: preload bootstrap, models facade and runtime wiring

Milestone B of the Folknet peeklet models split (`folknet-peeklet-models.md`,
"Scope of this spec"). Offline only: real transport stays disabled; end-to-end
tests use an injected fake transport and fake credentials. The proposal behind
this split is in that track's handoff, "Proposed scope amendment" §§2–4.

## Bootstrap and facade

- A narrow synchronous main/preload exchange, registered in `tile-ipc.ts` before
  window creation and consumed synchronously in `tile-preload.cts`, returns only
  plain models-facade eligibility and revision data for an eagerly bound sender
  (proposed `tile-tokens.ts` `getModelBootstrapForOwner`, checked against
  milestone A's registry authority). No network, disk or async work in that
  handler; missing authority denies. Renderer URL, query or manifest fields never
  assert authority.
- `tile-launcher.ts` (`CreateTileBrowserWindowSpec`, `createTileBrowserWindow`,
  web-preferences helpers, `setTokenOwner` call sites): every supported models
  renderer has its sender bound and a main-owned grant snapshot ready when its
  preload runs. Unsupported guest paths keep models denied.
- `window.app.models` exists only when the bootstrap grants it; the rest of
  `window.app` stays synchronously available at import time. Every call still
  revalidates in main.
- Revocation: on grant change or revocation, in-flight work is cancelled and stale
  wrappers are denied immediately, and the renderer is reloaded so the facade
  shape follows the new grant. No always-present throwing facade.
- If eager binding before preload cannot be confirmed on the pinned Electron, keep
  models disabled and record that under Result; never relax sender checks.

## Runtime and lifecycle

- `main.ts` `initialize()`: publish a ready/profile-registry port so
  `runtime-entry.ts` constructs exactly one `ModelBroker` after initialization,
  never during the startup notice, profile selection or core imports, and calls
  `setModelIpcHost` with it.
- `feature-startup.ts` `initializeFeatures`: forward unregister, disable and grant
  changes to cancellation and approval invalidation.
- `tile-launcher.ts` (`releaseTileWindow`, `shutdownTile`, `unloadTile`,
  `unloadAllTiles`, crash/close handlers): host cleanup before identity or token
  removal; hide does not cancel.
- `tile-lifecycle.ts` (`transition`, `getState`): a transition subscription so
  suspension and other transitions invalidate the owner promptly; READY/VISIBLE
  probes still fail closed on their own.
- `runtime-entry.ts`: powerMonitor sleep/wake/lock, startup acknowledgment,
  teardown. Profile switch cancels and clears before teardown/relaunch. The profile
  authority source is an injected port, never an assumed unlocked flag.

## Done

- `apps/desktop/tests/desktop/model-facade.spec.ts`: real Electron no-grant,
  grant, builtin and stale-sender cases with fake host transport, plus a
  synchronous base-API regression.
- `apps/desktop/tests/desktop/model-runtime.spec.ts`: real startup, profile
  teardown/relaunch, hide/unload/crash, revoke and simulated power events.
- The core spec's acceptance items 2 and 6 hold in the real app, not only in
  component tests. No provider contact.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
```

The two Playwright specs run headless under the `peek-bg-run` conventions.
