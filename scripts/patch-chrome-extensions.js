#!/usr/bin/env node
/**
 * Patch bundled Chrome extensions for Electron compatibility.
 *
 * Applies shims and patches to extension files that are needed because
 * Electron does not implement all Chrome extension APIs. Run this after
 * placing or updating extension files in resources/chrome-extensions/.
 *
 * What it does:
 * - Proton Pass: Prepends chrome.permissions, chrome.storage.session, and
 *   chrome.runtime.getBackgroundPage shims to background.js
 * - Proton Pass: Prepends chrome.permissions shim to polyfills.js
 *   (loaded by popup.html and settings.html before their entry scripts)
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

const SHIM_MARKER = '/* Peek: chrome.permissions';

/**
 * The permissions shim. Electron does not implement chrome.permissions.
 * The webextension-polyfill used by Proton Pass detects globalThis.browser
 * and uses it directly (bypassing its chrome->browser wrapper), so we must
 * shim BOTH chrome.permissions AND browser.permissions. Supports both
 * Promise and callback invocation styles (webextension-polyfill uses
 * Chrome callback convention). Without this, the
 * service worker crashes at startup on permissions.onAdded.addListener().
 */
const PERMISSIONS_SHIM = `/* Peek: chrome.permissions + browser.permissions shim for Electron compatibility.
 * Supports both Promise and callback styles (webextension-polyfill uses Chrome callback convention). */
(function() {
  function NoopEvent() { this._l = []; }
  NoopEvent.prototype.addListener = function(fn) { this._l.push(fn); };
  NoopEvent.prototype.removeListener = function(fn) { this._l = this._l.filter(function(x) { return x !== fn; }); };
  NoopEvent.prototype.hasListener = function(fn) { return this._l.indexOf(fn) !== -1; };
  NoopEvent.prototype.hasListeners = function() { return this._l.length > 0; };

  function makePermissions() {
    return {
      contains: function(perms, callback) {
        if (typeof callback === 'function') callback(true);
        return Promise.resolve(true);
      },
      getAll: function(callback) {
        var result = { permissions: [], origins: [] };
        try {
          if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
            var m = chrome.runtime.getManifest();
            result = { permissions: m.permissions || [], origins: m.host_permissions || [] };
          }
        } catch(e) {}
        if (typeof callback === 'function') callback(result);
        return Promise.resolve(result);
      },
      request: function(perms, callback) {
        if (typeof callback === 'function') callback(true);
        return Promise.resolve(true);
      },
      remove: function(perms, callback) {
        if (typeof callback === 'function') callback(true);
        return Promise.resolve(true);
      },
      onAdded: new NoopEvent(),
      onRemoved: new NoopEvent()
    };
  }

  if (typeof chrome !== 'undefined' && !chrome.permissions) chrome.permissions = makePermissions();
  if (typeof browser !== 'undefined' && browser && !browser.permissions) browser.permissions = makePermissions();
})();
`;

/**
 * chrome.storage.session in-memory shim. Electron does not provide
 * chrome.storage.session. Without this, the background service worker
 * fails to initialize its storage layer and settings pages stay blank.
 */
const STORAGE_SESSION_SHIM = `// --- chrome.storage.session in-memory shim ---
(function() {
  if (typeof chrome !== 'undefined' && chrome.storage) {
    if (!chrome.storage.session) {
      const _data = {};
      const _listeners = new Set();
      chrome.storage.session = {
        get(keys) {
          return new Promise(resolve => {
            if (keys === null || keys === undefined) { resolve({..._data}); return; }
            if (typeof keys === 'string') keys = [keys];
            if (Array.isArray(keys)) {
              const result = {};
              for (const k of keys) { if (k in _data) result[k] = _data[k]; }
              resolve(result); return;
            }
            const result = {};
            for (const [k, def] of Object.entries(keys)) { result[k] = k in _data ? _data[k] : def; }
            resolve(result);
          });
        },
        set(items) {
          return new Promise(resolve => {
            const changes = {};
            for (const [k, v] of Object.entries(items)) {
              const oldValue = _data[k]; _data[k] = v;
              changes[k] = { newValue: v };
              if (oldValue !== undefined) changes[k].oldValue = oldValue;
            }
            if (Object.keys(changes).length > 0) { for (const l of _listeners) { try { l(changes, 'session'); } catch(e) {} } }
            resolve();
          });
        },
        remove(keys) {
          return new Promise(resolve => {
            if (typeof keys === 'string') keys = [keys];
            const changes = {};
            for (const k of keys) { if (k in _data) { changes[k] = { oldValue: _data[k] }; delete _data[k]; } }
            if (Object.keys(changes).length > 0) { for (const l of _listeners) { try { l(changes, 'session'); } catch(e) {} } }
            resolve();
          });
        },
        clear() {
          return new Promise(resolve => {
            const changes = {};
            for (const [k, v] of Object.entries(_data)) { changes[k] = { oldValue: v }; delete _data[k]; }
            if (Object.keys(changes).length > 0) { for (const l of _listeners) { try { l(changes, 'session'); } catch(e) {} } }
            resolve();
          });
        },
        getBytesInUse(keys) {
          return new Promise(resolve => {
            if (keys === null || keys === undefined) { resolve(JSON.stringify(_data).length * 2); return; }
            if (typeof keys === 'string') keys = [keys];
            let total = 0;
            for (const k of keys) { if (k in _data) total += JSON.stringify(k).length * 2 + JSON.stringify(_data[k]).length * 2; }
            resolve(total);
          });
        },
        setAccessLevel() { return Promise.resolve(); },
        onChanged: {
          addListener(cb) { _listeners.add(cb); },
          removeListener(cb) { _listeners.delete(cb); },
          hasListener(cb) { return _listeners.has(cb); },
          hasListeners() { return _listeners.size > 0; },
        },
        QUOTA_BYTES: 10485760,
      };
    }
  }
})();
`;

/**
 * chrome.runtime.getBackgroundPage shim. Electron does not implement this API.
 * Without it, the background page detection fails and storage operations
 * relay via sendMessage back to itself in a circular failure loop.
 */
const GET_BACKGROUND_PAGE_SHIM = `// --- chrome.runtime.getBackgroundPage shim ---
(function() {
  if (typeof chrome !== 'undefined' && chrome.runtime && !chrome.runtime.getBackgroundPage) {
    chrome.runtime.getBackgroundPage = function() {
      return Promise.resolve(typeof self !== 'undefined' ? self : globalThis);
    };
  }
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

  let content = fs.readFileSync(bgPath, 'utf-8');
  let patched = false;

  // Check each shim independently so re-running after adding new shims works
  if (!content.includes(SHIM_MARKER)) {
    content = PERMISSIONS_SHIM + content;
    patched = true;
  }

  if (!content.includes('chrome.storage.session')) {
    // Insert after permissions shim closing })();
    const marker = '})();\n';
    const idx = content.indexOf(marker);
    if (idx !== -1) {
      const insertAt = idx + marker.length;
      content = content.slice(0, insertAt) + STORAGE_SESSION_SHIM + GET_BACKGROUND_PAGE_SHIM + content.slice(insertAt);
    } else {
      content = content + STORAGE_SESSION_SHIM + GET_BACKGROUND_PAGE_SHIM;
    }
    patched = true;
  }

  if (!patched) {
    console.log('[patch] Proton Pass background.js already patched');
    return;
  }

  fs.writeFileSync(bgPath, content);
  console.log('[patch] Proton Pass background.js patched with shims');

  // --- Patch polyfills.js (loaded by popup.html, settings.html before their entry scripts) ---
  const polyfillsPath = path.join(extPath, 'polyfills.js');
  if (fs.existsSync(polyfillsPath)) {
    let polyContent = fs.readFileSync(polyfillsPath, 'utf-8');
    if (polyContent.indexOf(SHIM_MARKER) === -1) {
      polyContent = PERMISSIONS_SHIM + polyContent;
      fs.writeFileSync(polyfillsPath, polyContent);
      console.log('[patch] Proton Pass polyfills.js patched with permissions shim');
    } else {
      console.log('[patch] Proton Pass polyfills.js already patched');
    }
  } else {
    console.warn('[patch] WARNING: Proton Pass polyfills.js not found');
  }

  // Verify required files exist
  const required = ['polyfills.js', 'popup.html', 'settings.html'];
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
