/**
 * Phase 5: replay machinery removal.
 *
 * Asserts the compiled tile-preload.cjs carries no reference to the
 * deleted `cmd:request-registers` replay topic, the `registeredPayloads`
 * cache, or the `ensureCmdRequestRegistersListener` installer. Phase 4
 * made the subscribe-before-publish invariant load-bearing (Core's
 * subscribers are live before any tile reaches `ready`), so the replay
 * topic has no job and must not linger as dead code.
 *
 * Mirrors the "tile-ipc.js does not register a tile:command:result
 * handler" style assertion from tile-ipc.test.ts (Phase 3).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// At runtime under ELECTRON_RUN_AS_NODE=1 this test file lives at
// dist/backend/electron/tile-preload-no-request-registers.test.js and the
// compiled preload module is its sibling tile-preload.cjs (emitted from
// tile-preload.cts).
const hereDir = dirname(fileURLToPath(import.meta.url));
const compiledPreload = join(hereDir, 'tile-preload.cjs');

describe('Phase 5: cmd:request-registers replay machinery is gone', () => {
  it('compiled tile-preload.cjs contains no reference to cmd:request-registers', () => {
    const src = readFileSync(compiledPreload, 'utf8');
    assert.ok(
      !src.includes('cmd:request-registers'),
      'tile-preload.cjs still references cmd:request-registers — Phase 5 deleted that replay topic'
    );
  });

  it('compiled tile-preload.cjs does not install the replay listener or cache', () => {
    const src = readFileSync(compiledPreload, 'utf8');
    assert.ok(
      !src.includes('ensureCmdRequestRegistersListener'),
      'tile-preload.cjs still installs ensureCmdRequestRegistersListener — Phase 5 deleted it'
    );
    assert.ok(
      !src.includes('registeredPayloads'),
      'tile-preload.cjs still maintains the registeredPayloads cache — Phase 5 deleted it'
    );
  });
});
