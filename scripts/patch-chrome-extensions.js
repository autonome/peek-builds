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
const EXT_DIR = path.join(ROOT, 'chrome-extensions');

const SHIM_MARKER = '/* Peek: chrome.permissions';
const HTML_SHIM_MARKER = '<!--peek:permissions-->';

/**
 * The permissions shim. Electron does not implement chrome.permissions.
 * The webextension-polyfill used by Proton Pass detects globalThis.browser
 * and uses it directly (bypassing its chrome->browser wrapper), so we must
 * shim BOTH chrome.permissions AND browser.permissions. Supports both
 * Promise and callback invocation styles (webextension-polyfill uses
 * Chrome callback convention). Without this, the
 * service worker crashes at startup on permissions.onAdded.addListener().
 */
const PERMISSIONS_SHIM = `/* Peek: chrome.permissions shim for Electron compatibility.
 * Strategy: replace globalThis.chrome with a Proxy whose target is a plain
 * empty object {}. The Proxy's get trap returns our shim for 'permissions'
 * and delegates everything else to the real native chrome.
 *
 * Why this shape:
 *   1. Electron's native chrome.permissions is a non-configurable, non-writable
 *      property on the native chrome object. We can't redefine it via
 *      defineProperty, and even mutating its methods doesn't help once a
 *      downstream consumer (e.g. Proton Pass) wraps chrome in their own Proxy
 *      that hides 'permissions' — the V8 invariant fires because the target
 *      property is non-configurable but the consumer's get trap returns
 *      undefined.
 *   2. Replacing chrome with a Proxy whose target is {} means the target has
 *      NO own properties — no invariants apply to anything. Downstream Proxies
 *      can wrap us freely without tripping V8's checks.
 *   3. The replacement uses configurable:true / writable:true so other code
 *      (Proton's polyfill) can still wrap us in their own Proxy. */
(function() {
  var DEBUG_PERMISSIONS = false;
  function _log() { if (DEBUG_PERMISSIONS) console.log.apply(console, ['[peek:permissions]'].concat(Array.prototype.slice.call(arguments))); }

  function NoopEvent() { this._l = []; }
  NoopEvent.prototype.addListener = function(fn) { this._l.push(fn); };
  NoopEvent.prototype.removeListener = function(fn) { this._l = this._l.filter(function(x) { return x !== fn; }); };
  NoopEvent.prototype.hasListener = function(fn) { return this._l.indexOf(fn) !== -1; };
  NoopEvent.prototype.hasListeners = function() { return this._l.length > 0; };

  var _chrome = (typeof chrome !== 'undefined') ? chrome : null;
  if (!_chrome) return;

  /* The polyfill methods that always grant. They reference _chrome (via runtime.getManifest) */
  function _request(perms, callback) {
    _log('request called with:', JSON.stringify(perms));
    try { delete _chrome.runtime.lastError; } catch(e) {}
    if (typeof callback === 'function') callback(true);
    return Promise.resolve(true);
  }
  function _contains(perms, callback) {
    _log('contains called with:', JSON.stringify(perms));
    try { delete _chrome.runtime.lastError; } catch(e) {}
    if (typeof callback === 'function') callback(true);
    return Promise.resolve(true);
  }
  function _getAll(callback) {
    var result = { permissions: [], origins: [] };
    try {
      if (_chrome.runtime && _chrome.runtime.getManifest) {
        var m = _chrome.runtime.getManifest();
        result = { permissions: m.permissions || [], origins: m.host_permissions || [] };
      }
    } catch(e) {}
    try { delete _chrome.runtime.lastError; } catch(e) {}
    if (typeof callback === 'function') callback(result);
    return Promise.resolve(result);
  }
  function _remove(perms, callback) {
    try { delete _chrome.runtime.lastError; } catch(e) {}
    if (typeof callback === 'function') callback(true);
    return Promise.resolve(true);
  }

  var _shimPerms = {
    request: _request, contains: _contains, getAll: _getAll, remove: _remove,
    onAdded: new NoopEvent(), onRemoved: new NoopEvent(),
  };

  /* Backup object — accessible from tests to verify the shim is loaded. */
  globalThis.__peekPermissions = _shimPerms;

  /* Build a Proxy wrapper for chrome with {} as target. */
  function wrapWithPermissionsShim(nativeObj, shimPerms) {
    if (!nativeObj || typeof nativeObj !== 'object') return nativeObj;
    return new Proxy({}, {
      get: function(_target, prop) {
        if (prop === 'permissions') return shimPerms;
        var val = nativeObj[prop];
        if (typeof val === 'function') return val.bind(nativeObj);
        return val;
      },
      set: function(_target, prop, value) {
        if (prop === 'permissions') return true; /* swallow attempts to overwrite our shim */
        try { nativeObj[prop] = value; } catch(e) {}
        return true;
      },
      has: function(_target, prop) {
        return prop === 'permissions' || prop in nativeObj;
      },
      ownKeys: function(_target) {
        var keys = [];
        try { keys = Reflect.ownKeys(nativeObj); } catch(e) {}
        if (keys.indexOf('permissions') === -1) keys.push('permissions');
        return keys;
      },
      getOwnPropertyDescriptor: function(_target, prop) {
        if (prop === 'permissions') {
          return { value: shimPerms, writable: true, configurable: true, enumerable: true };
        }
        try { return Object.getOwnPropertyDescriptor(nativeObj, prop); } catch(e) { return undefined; }
      },
    });
  }

  try {
    Object.defineProperty(globalThis, 'chrome', {
      value: wrapWithPermissionsShim(_chrome, _shimPerms),
      writable: true, configurable: true, enumerable: true,
    });
    _log('chrome wrapped with permissions Proxy');
  } catch(e) { _log('chrome wrap failed:', e.message); }
})();
`;

/**
 * Polyfills-only permissions shim. Same method-mutation strategy as the
 * background shim. Method mutation does not interact with browser.permissions
 * (which webextension-polyfill builds during popup.js execution) so the old
 * "black screen on early browser.permissions touch" hazard doesn't apply.
 */
/**
 * Standalone shim file — written as `peek-permissions.js` into the extension
 * directory and referenced from each HTML entry point via <script src=...>
 * BEFORE polyfills.js. Inline scripts are blocked by the extension's
 * Manifest-V3 CSP (script-src 'self'), but external 'self' scripts are
 * allowed. Installs a setter on globalThis.chrome so we patch in
 * chrome.permissions the moment Electron defines chrome — before any
 * extension script can read it or wrap it in a Proxy.
 */
const PEEK_PERMISSIONS_JS = `/* Peek: chrome.permissions early-install shim. See patch-chrome-extensions.js. */
(function() {
  var DEBUG_PERMISSIONS = false;
  function _log() { if (DEBUG_PERMISSIONS) console.log.apply(console, ['[peek:permissions:html]'].concat(Array.prototype.slice.call(arguments))); }

  function NoopEvent() { this._l = []; }
  NoopEvent.prototype.addListener = function(fn) { this._l.push(fn); };
  NoopEvent.prototype.removeListener = function(fn) { this._l = this._l.filter(function(x) { return x !== fn; }); };
  NoopEvent.prototype.hasListener = function(fn) { return this._l.indexOf(fn) !== -1; };
  NoopEvent.prototype.hasListeners = function() { return this._l.length > 0; };

  function _clearLastError(c) { try { delete c.runtime.lastError; } catch(e) {} }

  var _real;
  function _getChrome() { return _real; }

  var _permsObj = {
    request: function(perms, callback) {
      _log('request:', JSON.stringify(perms));
      _clearLastError(_getChrome());
      if (typeof callback === 'function') callback(true);
      return Promise.resolve(true);
    },
    contains: function(perms, callback) {
      _log('contains:', JSON.stringify(perms));
      _clearLastError(_getChrome());
      if (typeof callback === 'function') callback(true);
      return Promise.resolve(true);
    },
    getAll: function(callback) {
      var c = _getChrome();
      var result = { permissions: [], origins: [] };
      try {
        if (c && c.runtime && c.runtime.getManifest) {
          var m = c.runtime.getManifest();
          result = { permissions: m.permissions || [], origins: m.host_permissions || [] };
        }
      } catch(e) {}
      _clearLastError(c);
      if (typeof callback === 'function') callback(result);
      return Promise.resolve(result);
    },
    remove: function(perms, callback) {
      _clearLastError(_getChrome());
      if (typeof callback === 'function') callback(true);
      return Promise.resolve(true);
    },
    onAdded: new NoopEvent(),
    onRemoved: new NoopEvent(),
  };
  globalThis.__peekPermissions = _permsObj;

  function _patchChrome(c) {
    if (!c || typeof c !== 'object') return;
    try {
      Object.defineProperty(c, 'permissions', { value: _permsObj, writable: true, configurable: true, enumerable: true });
      _log('installed chrome.permissions on captured chrome');
    } catch(e) {
      try { c.permissions = _permsObj; _log('installed via assignment'); }
      catch(e2) { _log('install failed:', e.message, '/', e2.message); }
    }
  }

  if (typeof chrome !== 'undefined' && chrome) {
    _real = chrome;
    _patchChrome(_real);
    // Lock globalThis.chrome so downstream code (e.g. webextension-polyfill)
    // can't replace the binding with a Proxy that hides permissions. The
    // underlying object is the same; only the binding is frozen.
    try {
      Object.defineProperty(globalThis, 'chrome', { value: _real, writable: false, configurable: false, enumerable: true });
      _log('locked globalThis.chrome');
    } catch(e) { _log('lock globalThis.chrome failed:', e.message); }
    return;
  }

  // chrome not yet defined. Install setter to capture Electron's assignment.
  try {
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      enumerable: true,
      get: function() { return _real; },
      set: function(v) {
        _real = v;
        _patchChrome(_real);
      },
    });
    _log('chrome setter installed');
  } catch(e) { _log('chrome setter install failed:', e.message); }
})();
`;
const PEEK_PERMISSIONS_SCRIPT_TAG = '<!--peek:permissions--><script src="peek-permissions.js" charset="UTF-8"></script>';

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

  // --- Write peek-permissions.js into the extension directory ---
  // Manifest-V3 CSP blocks inline <script>, so we ship the shim as a real file
  // referenced via <script src> from each HTML entry. CSP allows 'self'.
  const peekJsPath = path.join(extPath, 'peek-permissions.js');
  fs.writeFileSync(peekJsPath, PEEK_PERMISSIONS_JS);
  console.log('[patch] Wrote peek-permissions.js');

  // --- Patch HTML entry points (popup.html, settings.html, etc.) ---
  // Inject <script src="peek-permissions.js"> right after <body>, BEFORE
  // polyfills.js / popup.js script tags. Our shim runs first, installs a
  // setter on globalThis.chrome, and patches in chrome.permissions the moment
  // Electron defines chrome — before any extension script reads it or wraps
  // it in a Proxy.
  const HTML_FILES = [
    'popup.html', 'settings.html', 'onboarding.html',
    'internal.html', 'notification.html', 'dropdown.html',
  ];
  for (const htmlFile of HTML_FILES) {
    const htmlPath = path.join(extPath, htmlFile);
    if (!fs.existsSync(htmlPath)) continue;
    let html = fs.readFileSync(htmlPath, 'utf-8');
    if (html.includes(HTML_SHIM_MARKER)) {
      console.log(`[patch] Proton Pass ${htmlFile} already patched`);
      continue;
    }
    const m = html.match(/<body[^>]*>/i);
    if (!m) {
      console.warn(`[patch] WARNING: ${htmlFile} has no <body> tag`);
      continue;
    }
    const insertAt = m.index + m[0].length;
    html = html.slice(0, insertAt) + '\n' + PEEK_PERMISSIONS_SCRIPT_TAG + '\n' + html.slice(insertAt);
    fs.writeFileSync(htmlPath, html);
    console.log(`[patch] Proton Pass ${htmlFile} patched with peek-permissions script tag`);
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
