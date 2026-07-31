/**
 * Unit tests for `window-kernel-shadow.ts` — the shadow kernel's registration
 * feed. Harness conventions follow `window-kernel-executor.test.ts`
 * (`node:test` + `node:assert`, `.js`-suffixed import of the compiled output).
 */

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import {
  _resetShadowKernelForTests,
  getShadowKernelExecutor,
  shadowKernelRegisterWindow,
} from './window-kernel-shadow.js';
import { BASE_LAYER, type WindowId } from './window-kernel.js';

const wid = (n: number): WindowId => `shadow-${n}` as WindowId;

describe('window-kernel-shadow: registration feed', () => {
  beforeEach(() => {
    _resetShadowKernelForTests();
  });

  it('a registration reaches the shadow kernel state (peek 7fffa286)', () => {
    const id = wid(1);
    shadowKernelRegisterWindow({
      id,
      kind: 'browser',
      layer: BASE_LAYER,
      canBecomeKey: true,
      acceptsInput: true,
      class: 'primary',
      role: 'main',
    });

    const record = getShadowKernelExecutor()
      .getState()
      .order.find((w) => w.id === id);
    assert.ok(record !== undefined, 'the registered window must appear in the shadow kernel state');
    assert.strictEqual(record?.kind, 'browser');
    assert.strictEqual(record?.layer, BASE_LAYER);
    assert.strictEqual(record?.canBecomeKey, true);
    assert.strictEqual(record?.acceptsInput, true);
    assert.strictEqual(record?.class, 'primary');
    assert.strictEqual(record?.role, 'main');
  });

  it('never throws and never rejects across a normal registration sequence', () => {
    // Two registrations in a row exercise the version-carrying path — a bug
    // that pins `expectedVersion` to a stale value would surface here as a
    // silently-dropped second registration.
    shadowKernelRegisterWindow({
      id: wid(2),
      kind: 'page-host',
      layer: BASE_LAYER,
      canBecomeKey: true,
      acceptsInput: true,
      class: 'primary',
    });
    shadowKernelRegisterWindow({
      id: wid(3),
      kind: 'page-host',
      layer: BASE_LAYER,
      canBecomeKey: true,
      acceptsInput: true,
      class: 'primary',
    });

    const order = getShadowKernelExecutor().getState().order;
    assert.ok(order.some((w) => w.id === wid(2)));
    assert.ok(order.some((w) => w.id === wid(3)));
  });
});
