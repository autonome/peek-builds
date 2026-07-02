/**
 * Unit test for the SW-background injection's ipcRenderer probe-miss log level
 * (peek 42fff0a5).
 *
 * Symptom: toggling a slide/peek's keepLive checkbox logged a scary Electron
 * RuntimeError — `electron.ipcRenderer unavailable on all probed paths —
 * cross-origin sendMessage will fail`. That log is emitted at SW cold-wake by
 * the injected background shim (`getBgInjection`) when it probes for the native
 * `electron` global before Electron 40 has wired it into the fresh SW realm.
 *
 * It is benign: `ipcRenderer` (`_ipc`) is used ONLY by the legacy direct-SW
 * fallback dispatch (extensions with no bridge window). Bridge-backed
 * extensions relay via the chrome.runtime bridge port and never touch it, so
 * the "will fail" claim is false for them. Electron surfaces an extension-
 * context `console.error` as a Level-2 RuntimeError in its error UI; the fix
 * downgrades this probe-miss to `console.warn` (Level 1) with truthful text.
 *
 * `getBgInjection()` returns the injected source as a plain string, so we can
 * assert on it deterministically without any Electron/browser context.
 *
 * Co-located at main/ top-level (like runtime-external-quit-guard.test.ts) so
 * the `dist/main/*.test.js` gate glob picks it up.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { getBgInjection } from './chrome-api-polyfills/runtime-external.js';

describe('getBgInjection ipcRenderer probe-miss log level (42fff0a5)', () => {
  const src = getBgInjection();

  it('drops the old misleading error text', () => {
    assert.ok(
      !src.includes('cross-origin sendMessage will fail'),
      'the old "cross-origin sendMessage will fail" error text must be gone',
    );
  });

  it('emits the truthful probe-miss log at warn level', () => {
    assert.ok(
      src.includes(
        "console.warn('[peek:runtime-external:bg] electron.ipcRenderer not resolved at SW init",
      ),
      'the new warn-level probe-miss log must be present',
    );
  });

  it('never logs the probe-miss at error level (would surface as an Electron RuntimeError)', () => {
    assert.ok(
      !src.includes("console.error('[peek:runtime-external:bg] electron.ipcRenderer"),
      'no error-level electron.ipcRenderer probe-miss log may remain',
    );
  });
});
