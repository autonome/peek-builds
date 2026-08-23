/**
 * window-kernel-singleton.ts — the single PRODUCTION `WindowKernelExecutor`,
 * built over a real `WindowBackend` (`electron-window-backend.ts`
 * `ElectronWindowBackend`) rather than the `NoopKernelBackend`
 * `window-kernel-shadow.ts` runs over.
 *
 * ONE PRODUCTION CALL SITE, AND IT IS THE CUTOVER.
 * `window-machine.ts getKernelExecutorForApp` is that call site: it
 * passes the adapter's own backend (`window-os-adapter.ts getBackend`), so
 * the kernel and the old machine drive the same `ElectronWindowBackend` and
 * speak the same `WindowId` space. An executor built over the real backend
 * performs REAL window effects (`show`, `raise`, `close`, stacking, …) the
 * moment anything feeds it a command or event — unlike the shadow executor
 * (`window-kernel-shadow.ts`), which can only ever reach a
 * `NoopKernelBackend` that records and discards. Nothing else may build one:
 * a second executor over a second backend would mint a disjoint id space.
 *
 * INJECTION, NOT IMPORT. This module does not import
 * `electron-window-backend.ts` (or anything that transitively pulls in
 * `electron`) at module scope. `ElectronWindowBackend` is constructed from
 * real Electron window handles, and a static `import { app } from 'electron'`
 * (or any transitive pull of `electron`) throws under `ELECTRON_RUN_AS_NODE=1`
 * — the mode the unit-test runner (`main/*.test.ts` → `electron --test`) uses.
 * That is the same trap `hybrid-editable-focus.ts` never worked around (it has
 * no unit test for exactly this reason) and the one
 * `window-escape-renderer-handled.ts initRendererHandledEscapeTracking`
 * solves by taking `ipcMain` as a parameter instead of importing it. Same
 * shape here: `getKernelExecutor` takes the `WindowBackend` as an argument,
 * supplied by whichever production module eventually constructs the real
 * backend and calls in — this module never constructs one itself, so it stays
 * loadable (and unit-testable with a fake backend) with no display and no
 * window plumbing, exactly like `window-kernel-shadow.ts`.
 *
 * LAZY, IDEMPOTENT CONSTRUCTION — same pattern as `window-machine.ts
 * getWindowOsAdapter()` and `window-kernel-shadow.ts getShadowKernelExecutor()`.
 * Nothing is built at import time: the first call constructs the executor
 * with the backend it was given; every later call — whatever backend it is
 * passed — returns that same instance. A caller cannot swap the backend
 * underneath an already-constructed executor by calling again with a
 * different one; `_resetKernelExecutorForTests` is the only way to force a
 * fresh construction.
 */

import { WindowKernelExecutor } from './window-kernel-executor.js';
import type { WindowBackend } from './window-backend.js';

let executorInstance: WindowKernelExecutor | null = null;

/**
 * The single production `WindowKernelExecutor`, constructed on first call
 * over `backend`. See the module header — `window-machine.ts
 * getKernelExecutorForApp` is the one production caller.
 */
export function getKernelExecutor(backend: WindowBackend): WindowKernelExecutor {
  if (!executorInstance) executorInstance = new WindowKernelExecutor(backend);
  return executorInstance;
}

/** Test-only: reset the singleton so the next `getKernelExecutor` call constructs fresh. */
export function _resetKernelExecutorForTests(): void {
  executorInstance = null;
}
