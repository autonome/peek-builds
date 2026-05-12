/**
 * Unit tests for debug-flag.ts
 *
 * Validates the core promise of the module: ESM live-binding semantics
 * propagate flag mutations to importers without any call-site changes.
 * Also covers idempotency, listener notification, boot-init seeding, and
 * env fallback.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import {
  DEBUG,
  setDebug,
  setDevTools,
  isDevToolsEnabled,
  getDebugFlags,
  onDebugFlagsChange,
  initDebugFlags,
  __resetDebugFlagsForTest,
} from './debug-flag.js';

describe('debug-flag', () => {
  // Snapshot/restore env so tests don't leak DEBUG state into one another
  // when the module's __reset re-honors process.env.
  let originalDebugEnv: string | undefined;

  beforeEach(() => {
    originalDebugEnv = process.env.DEBUG;
    delete process.env.DEBUG;
    __resetDebugFlagsForTest();
  });

  afterEach(() => {
    __resetDebugFlagsForTest();
    if (originalDebugEnv === undefined) {
      delete process.env.DEBUG;
    } else {
      process.env.DEBUG = originalDebugEnv;
    }
  });

  describe('live binding', () => {
    it('importers see updated DEBUG after setDebug(true)', async () => {
      assert.strictEqual(DEBUG, false, 'starts at false after reset');
      setDebug(true);

      // Re-import as a fresh module reference to confirm ESM live binding —
      // this is the same mechanism the ~hundreds of `DEBUG && console.log`
      // call sites rely on.
      const mod = await import('./debug-flag.js');
      assert.strictEqual(mod.DEBUG, true, 'reimport reflects mutation');
    });

    it('setDebug(false) flips back', () => {
      setDebug(true);
      assert.strictEqual(getDebugFlags().verbose, true);
      setDebug(false);
      assert.strictEqual(getDebugFlags().verbose, false);
    });
  });

  describe('idempotency', () => {
    it('setDebug to the same value does not fire listeners', () => {
      setDebug(true);
      let fired = 0;
      onDebugFlagsChange(() => fired++);
      setDebug(true); // same value — no-op
      assert.strictEqual(fired, 0);
      setDebug(false); // real flip
      assert.strictEqual(fired, 1);
    });

    it('setDevTools to the same value does not fire listeners', () => {
      setDevTools(true);
      let fired = 0;
      onDebugFlagsChange(() => fired++);
      setDevTools(true);
      assert.strictEqual(fired, 0);
    });
  });

  describe('change notification', () => {
    it('listeners receive the new state on flip', () => {
      const captured: Array<{ verbose: boolean; devtools: boolean }> = [];
      onDebugFlagsChange((state) => captured.push(state));
      setDebug(true);
      setDevTools(true);
      assert.deepStrictEqual(captured, [
        { verbose: true, devtools: false },
        { verbose: true, devtools: true },
      ]);
    });

    it('unsubscribe stops further notifications', () => {
      let fired = 0;
      const unsub = onDebugFlagsChange(() => fired++);
      setDebug(true);
      assert.strictEqual(fired, 1);
      unsub();
      setDebug(false);
      assert.strictEqual(fired, 1, 'no further calls after unsubscribe');
    });

    it('a throwing listener does not block other listeners', () => {
      let a = 0;
      let b = 0;
      onDebugFlagsChange(() => { a++; throw new Error('boom'); });
      onDebugFlagsChange(() => { b++; });
      setDebug(true);
      assert.strictEqual(a, 1);
      assert.strictEqual(b, 1, 'second listener still fires despite first throwing');
    });
  });

  describe('isDevToolsEnabled', () => {
    it('reflects current devtools state', () => {
      assert.strictEqual(isDevToolsEnabled(), false);
      setDevTools(true);
      assert.strictEqual(isDevToolsEnabled(), true);
    });
  });

  describe('initDebugFlags', () => {
    it('seeds both flags from explicit values', () => {
      initDebugFlags({ verbose: true, devtools: true });
      assert.deepStrictEqual(getDebugFlags(), { verbose: true, devtools: true });
    });

    it('verbose falls back to process.env.DEBUG when undefined', () => {
      process.env.DEBUG = '1';
      initDebugFlags({});
      assert.strictEqual(getDebugFlags().verbose, true);
    });

    it('devtools defaults to false when undefined', () => {
      initDebugFlags({ verbose: true });
      assert.strictEqual(getDebugFlags().devtools, false);
    });

    it('does NOT fire change listeners — boot init is seed not change', () => {
      let fired = 0;
      onDebugFlagsChange(() => fired++);
      initDebugFlags({ verbose: true, devtools: true });
      assert.strictEqual(fired, 0);
    });
  });

  describe('getDebugFlags snapshot', () => {
    it('returns a copy — mutating the returned object does not affect state', () => {
      setDebug(true);
      const snap = getDebugFlags();
      snap.verbose = false;
      assert.strictEqual(getDebugFlags().verbose, true, 'state is unaffected by snapshot mutation');
    });
  });
});
