/**
 * Placeholder for tile:window:open integration tests.
 *
 * The delegation from tile-ipc.ts → ipc.ts's window-open handler cannot be
 * exercised under ELECTRON_RUN_AS_NODE=1 because ipc.ts transitively imports
 * Electron runtime APIs (BrowserWindow, app, etc.) that are only available
 * when Electron is launched as the window-producing process.
 *
 * See tests/desktop/tile-window-open.spec.ts for the Playwright-based
 * end-to-end coverage of the fix.
 */

import { describe, it } from 'node:test';

describe('tile:window:open delegation (placeholder)', () => {
  it('documents that e2e coverage lives in Playwright', () => {
    // Intentionally empty — see docstring.
  });
});
