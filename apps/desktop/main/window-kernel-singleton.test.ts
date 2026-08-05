/**
 * Unit tests for `window-kernel-singleton.ts` — the production
 * `WindowKernelExecutor` accessor. Harness conventions follow
 * `window-kernel-executor.test.ts` (`node:test` + `node:assert`,
 * `.js`-suffixed import of the compiled output). Coverage: lazy
 * construction, idempotence, and that the injected backend is the one the
 * returned executor actually drives — plus a source-drift pin (see its own
 * describe block below for exactly what that pin does and does not prove).
 *
 * The fake backend below implements the full `WindowBackend` port with no
 * `electron` import anywhere — same reason `window-kernel-executor.test.ts`'s
 * `RecordingBackend` does the same.
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getKernelExecutor, _resetKernelExecutorForTests } from './window-kernel-singleton.js';
import { WindowKernelExecutor } from './window-kernel-executor.js';
import type { WindowId } from './window-kernel.js';
import type { Rect, WindowBackend } from './window-backend.js';
import type { StackingLevel, WindowId as BackendWindowId } from './window-state.js';

const wid = (n: number): WindowId => `wks-${n}` as WindowId;

// ── The recording fake backend ───────────────────────────────────────────────

interface Call {
  name: string;
  args: unknown[];
}

/** Records every port command. Implements the whole `WindowBackend` surface so a new port method cannot be silently unimplemented here. */
class FakeBackend implements WindowBackend {
  readonly calls: Call[] = [];

  private record(name: string, ...args: unknown[]): void {
    this.calls.push({ name, args });
  }

  attachAppListeners(): void {
    this.record('attachAppListeners');
  }
  raiseWindow(id: BackendWindowId, opSeq: number): void {
    this.record('raiseWindow', id, opSeq);
  }
  focusContent(id: BackendWindowId, opSeq: number): void {
    this.record('focusContent', id, opSeq);
  }
  setFullscreen(id: BackendWindowId, on: boolean): void {
    this.record('setFullscreen', id, on);
  }
  reconcileFullscreen(id: BackendWindowId): void {
    this.record('reconcileFullscreen', id);
  }
  closeOrHide(id: BackendWindowId): Promise<void> {
    this.record('closeOrHide', id);
    return Promise.resolve();
  }
  askRendererToHandleEscape(id: BackendWindowId, seq: number): Promise<void> {
    this.record('askRendererToHandleEscape', id, seq);
    return Promise.resolve();
  }
  attachEscHandler(id: BackendWindowId): void {
    this.record('attachEscHandler', id);
  }
  setEscGrab(on: boolean): void {
    this.record('setEscGrab', on);
  }
  closeWindow(id: BackendWindowId): Promise<void> {
    this.record('closeWindow', id);
    return Promise.resolve();
  }
  destroyWindow(id: BackendWindowId): void {
    this.record('destroyWindow', id);
  }
  closeContent(id: BackendWindowId): void {
    this.record('closeContent', id);
  }
  showWindow(id: BackendWindowId, opts: { activate: boolean; opSeq: number }): void {
    this.record('showWindow', id, opts);
  }
  hideWindow(id: BackendWindowId): void {
    this.record('hideWindow', id);
  }
  pinAlwaysOnTop(id: BackendWindowId, on: boolean): void {
    this.record('pinAlwaysOnTop', id, on);
  }
  destroyAllContentGuests(): Promise<void> {
    this.record('destroyAllContentGuests');
    return Promise.resolve();
  }
  setStacking(id: BackendWindowId, level: StackingLevel): void {
    this.record('setStacking', id, level);
  }
  setWindowBounds(id: BackendWindowId, rect: Rect): void {
    this.record('setWindowBounds', id, rect);
  }
  setVisibleOnAllSpaces(
    id: BackendWindowId,
    on: boolean,
    opts?: { visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean },
  ): void {
    this.record('setVisibleOnAllSpaces', id, on, opts);
  }
}

// `DestroyWindow` is one of the four teardown commands `decide` answers with
// no unknown-window guard (window-kernel.ts) — so it needs no prior
// registration, and its effect (`destroyWindow`) carries no headless/
// appActive masking, unlike a show or a raise. That makes it the simplest
// command for proving which backend a returned executor actually drives.
function destroyCommand(exec: WindowKernelExecutor, id: WindowId) {
  return exec.execute({ type: 'DestroyWindow', id, expectedVersion: exec.getState().version });
}

describe('window-kernel-singleton getKernelExecutor', () => {
  beforeEach(() => {
    _resetKernelExecutorForTests();
  });

  it('constructs lazily: obtaining the executor performs no backend calls on its own', () => {
    const backend = new FakeBackend();
    const exec = getKernelExecutor(backend);
    assert.ok(exec instanceof WindowKernelExecutor);
    assert.deepStrictEqual(backend.calls, [], 'construction alone must not touch the backend');
  });

  it('is idempotent: a second call returns the SAME instance, even when passed a different backend', () => {
    const backendA = new FakeBackend();
    const exec1 = getKernelExecutor(backendA);
    const backendB = new FakeBackend();
    const exec2 = getKernelExecutor(backendB);
    assert.strictEqual(exec1, exec2, 'the second call must not construct a fresh executor');
  });

  it('drives the backend it was constructed with, not a later one passed to a repeat call', () => {
    const backendA = new FakeBackend();
    const exec1 = getKernelExecutor(backendA);
    const backendB = new FakeBackend();
    getKernelExecutor(backendB); // idempotent — same instance as exec1, backendB is ignored

    const outcome = destroyCommand(exec1, wid(1));
    assert.ok('applied' in outcome && outcome.applied, 'DestroyWindow has no unknown-window guard');
    assert.deepStrictEqual(
      backendA.calls,
      [{ name: 'destroyWindow', args: [wid(1)] }],
      'the injected backend from the first call is the one that receives the effect',
    );
    assert.deepStrictEqual(backendB.calls, [], 'the backend passed on the ignored repeat call must see nothing');
  });

  it('resets cleanly: after _resetKernelExecutorForTests, the next call constructs a fresh instance over its own backend', () => {
    const backendA = new FakeBackend();
    const exec1 = getKernelExecutor(backendA);
    destroyCommand(exec1, wid(1));

    _resetKernelExecutorForTests();

    const backendB = new FakeBackend();
    const exec2 = getKernelExecutor(backendB);
    assert.notStrictEqual(exec1, exec2, 'a reset must force a fresh construction');
    destroyCommand(exec2, wid(2));
    assert.deepStrictEqual(backendB.calls, [{ name: 'destroyWindow', args: [wid(2)] }]);
    assert.deepStrictEqual(backendA.calls, [{ name: 'destroyWindow', args: [wid(1)] }], 'the old executor/backend pair is untouched by the new one');
  });
});

// ── Source-drift pin ─────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Compiled test lives at apps/desktop/dist/main/; source lives at apps/desktop/main/.
const MAIN_SRC_DIR = path.resolve(__dirname, '../../main');

function* walkSource(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkSource(full);
    } else if (/\.(ts|cts|js|mjs)$/.test(entry.name)) {
      yield full;
    }
  }
}

describe('source-drift pin — window-kernel-singleton is not wired to production yet', () => {
  /**
   * MECHANICAL CHECK, NOT A PROOF OF BEHAVIOR. This is a text grep over
   * `apps/desktop/main/*.ts`: it proves the import LINE `from
   * './window-kernel-singleton...'` (or a `require`/dynamic-import
   * equivalent naming the module) is absent from source outside this test
   * file and the accessor's own module — nothing more. It cannot see a
   * re-export chain, a computed specifier, or any other indirection that
   * reaches `getKernelExecutor` without the literal string landing in a
   * `.ts` file. The real guardrail is the module doc on
   * `window-kernel-singleton.ts` plus review at the cutover commit that adds
   * the first real call site; this pin only keeps THAT commit from arriving
   * silently via a plain import.
   */
  it('no source file under apps/desktop/main imports window-kernel-singleton, outside its own module and test', () => {
    const offenders: string[] = [];
    for (const file of walkSource(MAIN_SRC_DIR)) {
      const base = path.basename(file);
      if (base.startsWith('window-kernel-singleton.')) continue; // the module itself + this test
      if (/\.test\.(ts|cts|js|mjs)$/.test(base)) continue; // no other test may reference it either, but keep the check on production source

      const text = fs.readFileSync(file, 'utf8');
      if (/window-kernel-singleton/.test(text)) {
        offenders.push(path.relative(MAIN_SRC_DIR, file));
      }
    }
    assert.deepStrictEqual(
      offenders,
      [],
      `window-kernel-singleton.ts must stay unwired until the cutover commit. ` +
        `Found a reference in: ${offenders.join(', ')}`,
    );
  });
});
