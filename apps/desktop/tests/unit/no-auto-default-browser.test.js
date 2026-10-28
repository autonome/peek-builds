/**
 * Guard: entry.ts must NOT auto-register as default http/https handler on launch.
 *
 * `app.setAsDefaultProtocolClient` must only be called from the
 * `tile:app:set-default-browser` IPC handler in tile-ipc.ts (i.e. via the
 * Settings button). Auto-registration on startup showed a macOS
 * "set Electron as your default browser?" prompt during every background launch.
 *
 * This test reads the TypeScript source of entry.ts and tile-ipc.ts and
 * asserts the structural invariant:
 *   - entry.ts contains zero calls to setAsDefaultProtocolClient
 *   - tile-ipc.ts still contains the expected Settings-button handler so the
 *     sanctioned path hasn't been accidentally removed
 *
 * Source-level checks are used here because entry.ts runs imperative startup
 * code synchronously during app.ready — before any Playwright connection can
 * attach a spy. This guard prevents the call from being re-introduced silently.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_DIR = join(__dirname, '..', '..', 'main');

describe('no-auto-default-browser', () => {
  // entry.ts is the startup gate; the startup code that used to live there is
  // now runtime-entry.ts. Both are scanned so the split cannot hide a call.
  for (const file of ['entry.ts', 'runtime-entry.ts']) {
    it(`${file} has zero setAsDefaultProtocolClient calls`, () => {
      const src = readFileSync(join(MAIN_DIR, file), 'utf8');
      const matches = src.match(/setAsDefaultProtocolClient/g);
      assert.equal(
        matches,
        null,
        `${file} must not call setAsDefaultProtocolClient (found ${matches ? matches.length : 0} occurrence(s)); ` +
        'default-browser registration must only happen via the tile:app:set-default-browser IPC handler in tile-ipc.ts'
      );
    });
  }

  it('tile-ipc.ts still has the tile:app:set-default-browser handler (Settings-button path intact)', () => {
    const src = readFileSync(join(MAIN_DIR, 'tile-ipc.ts'), 'utf8');
    assert.ok(
      src.includes("'tile:app:set-default-browser'"),
      'tile-ipc.ts must still register the tile:app:set-default-browser handler'
    );
    assert.ok(
      src.includes('setAsDefaultProtocolClient'),
      'tile-ipc.ts must still call setAsDefaultProtocolClient (the Settings button needs it)'
    );
  });

  it('the Settings-button handler refuses in a headless run, before any registration call', () => {
    const src = readFileSync(join(MAIN_DIR, 'tile-ipc.ts'), 'utf8');
    const handler = src.slice(src.indexOf("'tile:app:set-default-browser', { mode"));
    const guard = handler.indexOf('isHeadless()');
    const register = handler.indexOf('setAsDefaultProtocolClient');
    assert.ok(guard !== -1 && guard < register, 'the handler must return on isHeadless() before calling setAsDefaultProtocolClient');
  });
});
