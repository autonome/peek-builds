/**
 * Standing regression test for computeUiEntries — the pure helper that
 * produces Settings → Extensions popup/options buttons.
 *
 * This function has regressed THREE times (2026-04-17, 2026-04-23,
 * 2026-04-29) because it lives inside chrome-extensions.ts which depends on
 * module-level Maps that only populate after loadEnabledChromeExtensions()
 * completes. Extracting it as a pure helper lets us assert the logic without
 * an Electron session.
 *
 * Key invariant: a loaded extension with action.default_popup AND options_ui
 * MUST produce exactly two openable entries (popup + options) plus any
 * non-openable background entries. If this test fails, the buttons are
 * missing from Settings → Extensions.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  computeUiEntries,
  type UiEntryLoaded,
  type UiEntryDiscovered,
} from './chrome-extensions-helpers.js';

// ── Fixture: proton-pass-like manifest (MV3) ────────────────────────────────

const PROTON_PASS_DISCOVERED: UiEntryDiscovered = {
  name: 'Proton Pass',
  manifest: {
    action: { default_popup: 'popup.html', default_title: 'Proton Pass' },
    options_ui: { page: 'settings.html' },
    background: { service_worker: 'background.js' },
  },
};

const PROTON_PASS_LOADED: UiEntryLoaded = {
  extensionUrl: 'chrome-extension://abc123hash/',
};

// ── Fixture: MV2 extension with browser_action ──────────────────────────────

const MV2_EXT_DISCOVERED: UiEntryDiscovered = {
  name: 'MV2 AdBlock',
  manifest: {
    browser_action: { default_popup: 'popup.html' },
    options_page: 'options.html',
    background: { page: 'background.html' },
  },
};

const MV2_EXT_LOADED: UiEntryLoaded = {
  extensionUrl: 'chrome-extension://mv2hash/',
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe('computeUiEntries — empty state', () => {
  it('returns [] when loadedExtensions is empty', () => {
    const result = computeUiEntries(new Map(), new Map());
    assert.deepStrictEqual(result, []);
  });

  it('returns [] when extension is discovered but not loaded', () => {
    const discovered = new Map([['proton-pass', PROTON_PASS_DISCOVERED]]);
    const result = computeUiEntries(new Map(), discovered);
    assert.deepStrictEqual(result, []);
  });

  it('returns [] when extension is loaded but not discovered', () => {
    const loaded = new Map([['proton-pass', PROTON_PASS_LOADED]]);
    const result = computeUiEntries(loaded, new Map());
    assert.deepStrictEqual(result, []);
  });
});

describe('computeUiEntries — proton-pass fixture (MV3 with action + options_ui)', () => {
  const loaded = new Map([['proton-pass', PROTON_PASS_LOADED]]);
  const discovered = new Map([['proton-pass', PROTON_PASS_DISCOVERED]]);
  const result = computeUiEntries(loaded, discovered);

  it('produces exactly 3 entries (popup + options + background)', () => {
    assert.strictEqual(result.length, 3);
  });

  it('popup entry is openable and has correct extensionId', () => {
    const popup = result.find(e => e.type === 'popup');
    assert.ok(popup, 'popup entry must exist');
    assert.strictEqual(popup.extensionId, 'proton-pass');
    assert.strictEqual(popup.openable, true);
    assert.strictEqual(popup.url, 'chrome-extension://abc123hash/popup.html');
  });

  it('options entry is openable and has correct URL', () => {
    const options = result.find(e => e.type === 'options');
    assert.ok(options, 'options entry must exist');
    assert.strictEqual(options.extensionId, 'proton-pass');
    assert.strictEqual(options.openable, true);
    assert.strictEqual(options.url, 'chrome-extension://abc123hash/settings.html');
  });

  it('background (service worker) entry is NOT openable', () => {
    const bg = result.find(e => e.type === 'background');
    assert.ok(bg, 'background entry must exist');
    assert.strictEqual(bg.openable, false);
  });

  it('exactly 2 openable entries (the ones that produce buttons in Settings → Extensions)', () => {
    const openable = result.filter(e => e.openable);
    assert.strictEqual(openable.length, 2,
      'Regression guard: Settings → Extensions shows one button per openable entry. ' +
      'If this count drops to 0, the buttons are missing.');
  });
});

describe('computeUiEntries — MV2 extension (browser_action + options_page + background page)', () => {
  const loaded = new Map([['mv2-adblock', MV2_EXT_LOADED]]);
  const discovered = new Map([['mv2-adblock', MV2_EXT_DISCOVERED]]);
  const result = computeUiEntries(loaded, discovered);

  it('produces popup from browser_action.default_popup', () => {
    const popup = result.find(e => e.type === 'popup');
    assert.ok(popup, 'popup entry must exist for MV2 extension');
    assert.strictEqual(popup.url, 'chrome-extension://mv2hash/popup.html');
  });

  it('produces options from options_page fallback', () => {
    const options = result.find(e => e.type === 'options');
    assert.ok(options, 'options entry must exist from options_page');
    assert.strictEqual(options.url, 'chrome-extension://mv2hash/options.html');
  });

  it('background page IS openable (unlike service workers)', () => {
    const bg = result.find(e => e.type === 'background');
    assert.ok(bg, 'background entry must exist');
    assert.strictEqual(bg.openable, true);
  });
});

describe('computeUiEntries — extensionId matching (Settings renderer uses ext.id === e.extensionId)', () => {
  it('extensionId in entries equals the Map key (directory name)', () => {
    const loaded = new Map([['consent-o-matic', { extensionUrl: 'chrome-extension://xhash/' }]]);
    const discovered = new Map([['consent-o-matic', {
      name: 'Consent-O-Matic',
      manifest: { action: { default_popup: 'popup.html' } },
    }]]);
    const result = computeUiEntries(loaded, discovered);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].extensionId, 'consent-o-matic',
      'extensionId must match the directory-name key used by getChromeExtensions() ' +
      'so the filter e.extensionId === ext.id in settings.js finds the entries');
  });
});
