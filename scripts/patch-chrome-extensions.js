#!/usr/bin/env node
/**
 * Patch bundled Chrome extensions for Electron compatibility.
 *
 * Applies shims and patches to extension files that are needed because
 * Electron does not implement all Chrome extension APIs. Run this after
 * placing or updating extension files in resources/chrome-extensions/.
 *
 * What it does:
 * - Proton Pass: Prepends chrome.permissions + browser.permissions shim to
 *   background.js (prevents SW crash from missing permissions API)
 *
 * Usage:
 *   node scripts/patch-chrome-extensions.js
 *
 * Safe to run multiple times — checks for existing shim before patching.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'resources', 'chrome-extensions');

const SHIM_MARKER = '/* Peek: chrome.permissions shim';

/**
 * The permissions shim. Electron does not implement chrome.permissions.
 * The webextension-polyfill used by Proton Pass detects globalThis.browser
 * and uses it directly (bypassing its chrome->browser wrapper), so we must
 * shim BOTH chrome.permissions AND browser.permissions. Without this, the
 * service worker crashes at startup on permissions.onAdded.addListener().
 */
const PERMISSIONS_SHIM = `/* Peek: chrome.permissions shim for Electron compatibility */
(function() {
  function NoopEvent() { this._l = []; }
  NoopEvent.prototype.addListener = function(fn) { this._l.push(fn); };
  NoopEvent.prototype.removeListener = function(fn) { this._l = this._l.filter(function(x) { return x !== fn; }); };
  NoopEvent.prototype.hasListener = function(fn) { return this._l.indexOf(fn) !== -1; };
  NoopEvent.prototype.hasListeners = function() { return this._l.length > 0; };

  function makePermissions() {
    return {
      contains: function() { return Promise.resolve(true); },
      getAll: function() {
        try {
          var m = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest() : {};
          return Promise.resolve({ permissions: m.permissions || [], origins: m.host_permissions || [] });
        } catch(e) { return Promise.resolve({ permissions: [], origins: [] }); }
      },
      request: function() { return Promise.resolve(true); },
      remove: function() { return Promise.resolve(true); },
      onAdded: new NoopEvent(),
      onRemoved: new NoopEvent()
    };
  }

  if (typeof chrome !== 'undefined' && !chrome.permissions) chrome.permissions = makePermissions();
  if (typeof browser !== 'undefined' && browser && !browser.permissions) browser.permissions = makePermissions();
})();
`;

function patchProtonPass() {
  const extPath = path.join(EXT_DIR, 'proton-pass');

  if (!fs.existsSync(extPath)) {
    console.log('[patch] Proton Pass not found, skipping');
    return;
  }

  const bgPath = path.join(extPath, 'background.js');
  if (!fs.existsSync(bgPath)) {
    console.warn('[patch] Proton Pass background.js not found');
    return;
  }

  const content = fs.readFileSync(bgPath, 'utf-8');

  if (content.includes(SHIM_MARKER)) {
    console.log('[patch] Proton Pass background.js already patched');
    return;
  }

  fs.writeFileSync(bgPath, PERMISSIONS_SHIM + content);
  console.log('[patch] Proton Pass background.js patched with permissions shim');

  // Verify required files exist
  const required = ['settings.js', 'popup.js', 'polyfills.js', 'settings.html', 'popup.html'];
  const missing = required.filter(f => !fs.existsSync(path.join(extPath, f)));
  if (missing.length > 0) {
    console.warn(`[patch] WARNING: Proton Pass missing files: ${missing.join(', ')}`);
    console.warn('[patch] Re-extract the extension from CRX to get missing files.');
  }
}

// Run patches
console.log('[patch] Patching Chrome extensions for Electron compatibility...');
patchProtonPass();
console.log('[patch] Done');
