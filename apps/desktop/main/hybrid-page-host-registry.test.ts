/**
 * Unit tests for the hybrid page-host registry reverse lookup.
 *
 * Runs via `electron --test` under ELECTRON_RUN_AS_NODE=1, so real Electron
 * classes (BaseWindow / WebContents) are NOT available — we use minimal FAKE
 * objects that implement exactly the methods registerHybridWindow touches
 * (no-op `.on`/`.once`, isDestroyed/isFocused/getURL/getTitle).
 *
 * Focus of these tests: getHybridWindowByContentWC, the reverse lookup the
 * will-download cleanup uses to resolve a BaseWindow-hosted content WC back to
 * its host so a download-trigger page-host can be closed.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { BaseWindow, WebContents } from 'electron';

import {
  registerHybridWindow,
  getHybridWindowByContentWC,
  unregisterHybridWindow,
  _resetForTests,
} from './hybrid-page-host-registry.js';

// ── Fakes ───────────────────────────────────────────────────────────────────

function makeFakeBaseWin(): BaseWindow {
  return {
    on: () => {},
    once: () => {},
    isDestroyed: () => false,
    isFocused: () => false,
  } as unknown as BaseWindow;
}

function makeFakeContentWC(): WebContents {
  return {
    on: () => {},
    once: () => {},
    isDestroyed: () => false,
    getURL: () => '',
    getTitle: () => '',
  } as unknown as WebContents;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('getHybridWindowByContentWC', () => {
  beforeEach(() => {
    _resetForTests();
  });
  afterEach(() => {
    _resetForTests();
  });

  it('resolves each registered content WC back to its host window', () => {
    const winA = makeFakeBaseWin();
    const wcA = makeFakeContentWC();
    const winB = makeFakeBaseWin();
    const wcB = makeFakeContentWC();

    registerHybridWindow(101, { baseWin: winA, contentWC: wcA });
    registerHybridWindow(102, { baseWin: winB, contentWC: wcB });

    assert.equal(getHybridWindowByContentWC(wcA)?.windowId, 101);
    assert.equal(getHybridWindowByContentWC(wcB)?.windowId, 102);
  });

  it('returns null for a content WC that is not registered', () => {
    registerHybridWindow(101, { baseWin: makeFakeBaseWin(), contentWC: makeFakeContentWC() });

    const stranger = makeFakeContentWC();
    assert.equal(getHybridWindowByContentWC(stranger), null);
  });

  it('returns null after the entry is unregistered', () => {
    const wcA = makeFakeContentWC();
    registerHybridWindow(101, { baseWin: makeFakeBaseWin(), contentWC: wcA });
    assert.equal(getHybridWindowByContentWC(wcA)?.windowId, 101);

    unregisterHybridWindow(101);
    assert.equal(getHybridWindowByContentWC(wcA), null);
  });
});
