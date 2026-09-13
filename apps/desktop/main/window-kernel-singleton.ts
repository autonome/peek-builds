// The single production WindowKernelExecutor, built over the real ElectronWindowBackend.
// Takes the backend as a parameter rather than importing electron-window-backend.ts at module
// scope, which would throw under ELECTRON_RUN_AS_NODE=1 (the unit-test runner's mode).
// See docs/design/window-manager.md around the kernel-executor construction section.

import { WindowKernelExecutor } from './window-kernel-executor.js';
import type { WindowBackend } from './window-backend.js';

let executorInstance: WindowKernelExecutor | null = null;

// First call constructs the executor over `backend`; every later call returns that same
// instance regardless of the backend passed in — a caller cannot swap it without calling
// `_resetKernelExecutorForTests` first.
export function getKernelExecutor(backend: WindowBackend): WindowKernelExecutor {
  if (!executorInstance) executorInstance = new WindowKernelExecutor(backend);
  return executorInstance;
}

export function _resetKernelExecutorForTests(): void {
  executorInstance = null;
}
