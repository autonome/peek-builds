/**
 * chrome.scripting Polyfill for Electron
 *
 * Implements the Chrome Scripting API (chrome.scripting.executeScript and
 * chrome.scripting.insertCSS) for extension background service workers.
 *
 * Architecture:
 * - BG SW calls chrome.scripting.executeScript({target, files?, func?, args?})
 * - IPC invoke → main process handler
 * - Main resolves tabId (== webContents.id) → webContents
 * - Validates file paths against extension root (path traversal guard)
 * - Validates target URL against extension host_permissions
 * - Executes via webContents.executeJavaScript or per-frame WebFrameMain
 *
 * tabId namespace: tabId === webContents.id (same convention as web-navigation.js).
 * Electron's native chrome.tabs.query() in BG SW context returns objects where
 * tab.id === webContents.id — no synthetic mapping needed.
 *
 * @module scripting
 * @see https://developer.chrome.com/docs/extensions/reference/api/scripting
 */

import { createRequire } from 'node:module';
import { channel, registerHandler, removeHandler } from './_ipc-bridge.js';
import fs from 'node:fs';
import path from 'node:path';

// Lazy/optional Electron import so this module can be loaded by build-time
// tools (e.g. scripts/patch-chrome-extensions.js) that run in plain Node.
const _require = createRequire(import.meta.url);
let _wc = null;
try { _wc = _require('electron')?.webContents ?? null; } catch (_) { /* not in Electron */ }

const API = 'scripting';
const DEBUG = !!process.env.DEBUG;

/** @type {import('electron').Session|null} */
let _session = null;

/**
 * Loaded-extension info map: extId → { path, manifest }
 * Populated by setupMainProcess via the getExtensionInfo callback.
 * @type {Map<string, { path: string, manifest: { host_permissions?: string[], permissions?: string[] } }>}
 */
const _extInfoCache = new Map();

/**
 * Get the extension ID from an IPC event.
 * @param {import('electron').IpcMainInvokeEvent} event
 * @returns {string}
 */
function getExtensionId(event) {
  const url = event.sender.getURL();
  const match = url.match(/^chrome-extension:\/\/([^/]+)/);
  return match ? match[1] : 'unknown';
}

/**
 * Resolve a tabId to a webContents in the bound session.
 * tabId == webContents.id (Electron convention used throughout this codebase).
 *
 * @param {number} tabId
 * @returns {import('electron').WebContents|null}
 */
function resolveTab(tabId) {
  let wc;
  try {
    wc = _wc.fromId(tabId);
  } catch {
    return null;
  }
  if (!wc || wc.isDestroyed()) return null;
  // Only allow targeting webContents in our session
  if (_session && wc.session !== _session) return null;
  return wc;
}

/**
 * Minimal Chrome match-pattern tester.
 * Mirrors the logic in chrome-extensions.ts (matchPatternToTester).
 *
 * @param {string} pattern
 * @returns {((url: URL) => boolean)|null}
 */
function matchPatternToTester(pattern) {
  if (pattern === '<all_urls>') return () => true;
  const m = pattern.match(/^(\*|https?|file|ftp):\/\/([^/]+)(\/.*)?$/);
  if (!m) return null;
  const [, scheme, host, pathGlob = '/*'] = m;
  const schemeMatcher = scheme === '*'
    ? (s) => s === 'http:' || s === 'https:'
    : (s) => s === `${scheme}:`;
  let hostMatcher;
  if (host === '*') hostMatcher = () => true;
  else if (host.startsWith('*.')) {
    const suffix = host.slice(2);
    hostMatcher = (h) => h === suffix || h.endsWith('.' + suffix);
  } else {
    hostMatcher = (h) => h === host;
  }
  const pathRe = new RegExp('^' + pathGlob.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return (url) => schemeMatcher(url.protocol) && hostMatcher(url.hostname) && pathRe.test(url.pathname + url.search);
}

/**
 * Check whether a target URL is permitted by an extension's host_permissions.
 *
 * @param {string} targetUrl
 * @param {string[]} hostPermissions
 * @returns {boolean}
 */
function isUrlPermitted(targetUrl, hostPermissions) {
  if (!Array.isArray(hostPermissions) || hostPermissions.length === 0) return false;
  let parsed;
  try { parsed = new URL(targetUrl); } catch { return false; }
  for (const pattern of hostPermissions) {
    const tester = matchPatternToTester(pattern);
    if (tester && tester(parsed)) return true;
  }
  return false;
}

/**
 * Resolve a relative file path from the extension and return its source.
 * Guards against path traversal (/../ outside ext root).
 *
 * @param {string} extRoot — Absolute path to extension root directory
 * @param {string} relPath — Relative file path from the extension manifest
 * @returns {string} File contents
 * @throws {Error} If path is invalid or traverses outside the extension root
 */
function readExtensionFile(extRoot, relPath) {
  // Normalize to remove any .. segments
  const normalized = path.normalize(relPath);
  // Reject absolute paths or traversals that escape the extension root
  if (path.isAbsolute(normalized)) {
    throw new Error(`[scripting] Rejected absolute path: ${relPath}`);
  }
  const resolved = path.resolve(extRoot, normalized);
  // Ensure the resolved path is inside the extension root
  if (!resolved.startsWith(path.resolve(extRoot) + path.sep) && resolved !== path.resolve(extRoot)) {
    throw new Error(`[scripting] Path traversal rejected: ${relPath}`);
  }
  return fs.readFileSync(resolved, 'utf-8');
}

/**
 * Execute a script injection on a single WebFrameMain or WebContents.
 *
 * @param {import('electron').WebFrameMain | import('electron').WebContents} target
 * @param {string} code
 * @returns {Promise<unknown>}
 */
async function execInFrame(target, code) {
  try {
    return await target.executeJavaScript(code, true);
  } catch (err) {
    DEBUG && console.warn('[scripting] Frame execution failed:', err);
    return undefined;
  }
}

/**
 * Build the JS code string for a func+args injection.
 *
 * @param {Function|string} func
 * @param {unknown[]} args
 * @returns {string}
 */
function buildFuncCode(func, args) {
  const fnStr = typeof func === 'function' ? func.toString() : String(func);
  const argsStr = JSON.stringify(Array.isArray(args) ? args : []);
  return `(${fnStr}).apply(null, ${argsStr})`;
}

/**
 * Main implementation of executeScript.
 *
 * @param {string} extId
 * @param {object} params
 * @param {object} params.target — {tabId, allFrames?, frameIds?}
 * @param {string[]} [params.files]
 * @param {Function|string} [params.func]
 * @param {unknown[]} [params.args]
 * @param {{ path: string, manifest: object }} extInfo
 * @returns {Promise<Array<{frameId: number, result: unknown}>>}
 */
async function doExecuteScript(extId, params, extInfo) {
  const { target, files, func, args } = params;
  if (!target || typeof target.tabId !== 'number') {
    throw new Error('[scripting] executeScript: target.tabId is required');
  }

  const wc = resolveTab(target.tabId);
  if (!wc) {
    throw new Error(`[scripting] executeScript: no webContents for tabId ${target.tabId}`);
  }

  // Validate host_permissions
  const currentUrl = wc.getURL();
  const hostPerms = extInfo.manifest.host_permissions || [];
  if (!isUrlPermitted(currentUrl, hostPerms)) {
    throw new Error(`[scripting] executeScript: URL not permitted by host_permissions: ${currentUrl}`);
  }

  // Collect frames to inject into
  const frames = [];
  if (target.allFrames) {
    try {
      const allFrames = wc.mainFrame.framesInSubtree;
      frames.push(...allFrames);
    } catch {
      // framesInSubtree not available — fall back to main frame only
      frames.push(wc.mainFrame);
    }
  } else if (Array.isArray(target.frameIds) && target.frameIds.length > 0) {
    try {
      const allFrames = wc.mainFrame.framesInSubtree;
      for (const frame of allFrames) {
        if (target.frameIds.includes(frame.frameTreeNodeId || 0)) {
          frames.push(frame);
        }
      }
    } catch {
      frames.push(wc.mainFrame);
    }
  } else {
    frames.push(wc.mainFrame);
  }

  // Build the code to inject
  let codes = [];
  if (Array.isArray(files) && files.length > 0) {
    for (const filePath of files) {
      const src = readExtensionFile(extInfo.path, filePath);
      codes.push(src);
    }
  } else if (func !== undefined) {
    codes.push(buildFuncCode(func, args));
  } else {
    throw new Error('[scripting] executeScript: must provide files or func');
  }

  const results = [];
  for (const frame of frames) {
    const frameId = typeof frame.frameTreeNodeId === 'number' ? frame.frameTreeNodeId : 0;
    for (const code of codes) {
      const result = await execInFrame(frame, code);
      results.push({ frameId, result });
    }
  }
  return results;
}

/**
 * Main implementation of insertCSS.
 *
 * @param {string} extId
 * @param {object} params
 * @param {object} params.target — {tabId}
 * @param {string} [params.css]
 * @param {string[]} [params.files]
 * @param {{ path: string, manifest: object }} extInfo
 * @returns {Promise<void>}
 */
async function doInsertCSS(extId, params, extInfo) {
  const { target, css, files } = params;
  if (!target || typeof target.tabId !== 'number') {
    throw new Error('[scripting] insertCSS: target.tabId is required');
  }

  const wc = resolveTab(target.tabId);
  if (!wc) {
    throw new Error(`[scripting] insertCSS: no webContents for tabId ${target.tabId}`);
  }

  const currentUrl = wc.getURL();
  const hostPerms = extInfo.manifest.host_permissions || [];
  if (!isUrlPermitted(currentUrl, hostPerms)) {
    throw new Error(`[scripting] insertCSS: URL not permitted by host_permissions: ${currentUrl}`);
  }

  let cssTexts = [];
  if (typeof css === 'string') {
    cssTexts.push(css);
  } else if (Array.isArray(files) && files.length > 0) {
    for (const filePath of files) {
      cssTexts.push(readExtensionFile(extInfo.path, filePath));
    }
  } else {
    throw new Error('[scripting] insertCSS: must provide css or files');
  }

  for (const cssText of cssTexts) {
    // Electron doesn't expose per-frame insertCSS; use main frame only.
    // For per-frame needs, inject a <style> element via JS.
    try {
      await wc.insertCSS(cssText);
    } catch (err) {
      DEBUG && console.warn('[scripting] insertCSS failed:', err);
    }
  }
}

/**
 * Look up extension info by Electron extension ID (the hash string).
 * Tries the session's loaded extensions.
 *
 * @param {string} extId — Electron runtime extension ID (hash)
 * @param {import('electron').Session} sess
 * @returns {{ path: string, manifest: object }|null}
 */
function getExtInfo(extId, sess) {
  if (_extInfoCache.has(extId)) return _extInfoCache.get(extId);

  // Try to find via session getAllExtensions
  try {
    // session.getAllExtensions() returns Extension objects
    const exts = sess.getAllExtensions ? sess.getAllExtensions() : [];
    for (const ext of exts) {
      if (ext.id === extId) {
        // Load the manifest from disk
        const manifestPath = path.join(ext.path, 'manifest.json');
        let manifest = {};
        try {
          manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        } catch { /* use empty manifest */ }
        const info = { path: ext.path, manifest };
        _extInfoCache.set(extId, info);
        return info;
      }
    }
  } catch {
    return null;
  }
  return null;
}

// --- Public API ---

/**
 * Set up main-process IPC handlers for chrome.scripting.
 *
 * @param {import('electron').Session} session
 * @param {object} options
 * @param {import('electron').IpcMain} options.ipcMain
 * @returns {{ cleanup: () => void }}
 */
export function setupMainProcess(session, { ipcMain }) {
  _session = session;

  registerHandler(ipcMain, API, 'executeScript', async (event, params) => {
    const extId = getExtensionId(event);
    DEBUG && console.log(`[scripting] executeScript from ext ${extId}:`, JSON.stringify(params));

    const extInfo = getExtInfo(extId, session);
    if (!extInfo) {
      throw new Error(`[scripting] executeScript: cannot find extension info for ${extId}`);
    }

    return doExecuteScript(extId, params, extInfo);
  });

  registerHandler(ipcMain, API, 'insertCSS', async (event, params) => {
    const extId = getExtensionId(event);
    DEBUG && console.log(`[scripting] insertCSS from ext ${extId}:`, JSON.stringify(params));

    const extInfo = getExtInfo(extId, session);
    if (!extInfo) {
      throw new Error(`[scripting] insertCSS: cannot find extension info for ${extId}`);
    }

    return doInsertCSS(extId, params, extInfo);
  });

  return {
    cleanup() {
      removeHandler(ipcMain, API, 'executeScript');
      removeHandler(ipcMain, API, 'insertCSS');
      _extInfoCache.clear();
      _session = null;
    },
  };
}

/**
 * Get the JavaScript source to inject into BG SW / extension page contexts.
 *
 * Installs chrome.scripting using Object.defineProperty with configurable:true
 * (same pattern as permissions.js) to survive Proxy wraps. If a native
 * chrome.scripting stub already exists, this replaces it with the IPC-backed
 * implementation.
 *
 * @returns {string}
 */
export function getPreloadScript() {
  const chExec = channel(API, 'executeScript');
  const chCSS = channel(API, 'insertCSS');

  return `
(function() {
  var _reqId = 0;
  var _pending = {};

  var _ipc = null;
  try {
    if (typeof electron !== 'undefined' && electron.ipcRenderer) _ipc = electron.ipcRenderer;
  } catch(_) {}
  try {
    if (!_ipc && typeof globalThis !== 'undefined' && globalThis.electron && globalThis.electron.ipcRenderer) _ipc = globalThis.electron.ipcRenderer;
  } catch(_) {}
  try {
    if (!_ipc && typeof require === 'function') {
      var _e = require('electron');
      if (_e && _e.ipcRenderer) _ipc = _e.ipcRenderer;
    }
  } catch(_) {}

  function _invoke(ch, params) {
    if (_ipc) return _ipc.invoke(ch, params);
    var port = globalThis.__peekBridgePort || null;
    if (!port) {
      return new Promise(function(resolve, reject) {
        var attempts = 0;
        var timer = setInterval(function() {
          attempts++;
          port = globalThis.__peekBridgePort || null;
          if (port) {
            clearInterval(timer);
            _doPortInvoke(port, ch, params).then(resolve, reject);
          } else if (attempts > 50) {
            clearInterval(timer);
            reject(new Error('[scripting] bridge port not available'));
          }
        }, 100);
      });
    }
    return _doPortInvoke(port, ch, params);
  }

  function _doPortInvoke(port, ch, params) {
    var id = 'scripting:' + (++_reqId);
    return new Promise(function(resolve, reject) {
      _pending[id] = { resolve: resolve, reject: reject };
      try {
        port.postMessage({ type: 'peek:scripting', reqId: id, channel: ch, params: params });
      } catch(e) {
        delete _pending[id];
        reject(e);
      }
      setTimeout(function() {
        if (_pending[id]) { delete _pending[id]; reject(new Error('[scripting] timeout')); }
      }, 30000);
    });
  }

  function _attachPortListener(port) {
    port.onMessage.addListener(function(msg) {
      if (!msg || msg.type !== 'peek:scripting:response') return;
      var p = _pending[msg.reqId];
      if (!p) return;
      delete _pending[msg.reqId];
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    });
  }

  if (globalThis.__peekBridgePort) {
    _attachPortListener(globalThis.__peekBridgePort);
  } else if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onConnect) {
    try {
      chrome.runtime.onConnect.addListener(function() {
        if (globalThis.__peekBridgePort && !globalThis.__peekScriptingListenerAttached) {
          globalThis.__peekScriptingListenerAttached = true;
          _attachPortListener(globalThis.__peekBridgePort);
        }
      });
    } catch(_) {}
  }

  var _scripting = {
    executeScript: function(params, callback) {
      var p = _invoke('${chExec}', params);
      if (typeof callback === 'function') {
        p.then(function(r) { try { callback(r); } catch(e) {} })
         .catch(function(e) {
           try {
             if (typeof chrome !== 'undefined' && chrome.runtime) {
               chrome.runtime.lastError = { message: String(e && e.message || e) };
             }
             callback([]);
           } catch(_) {}
         });
        return undefined;
      }
      return p;
    },

    insertCSS: function(params, callback) {
      var p = _invoke('${chCSS}', params);
      if (typeof callback === 'function') {
        p.then(function() { try { callback(); } catch(e) {} })
         .catch(function(e) {
           try {
             if (typeof chrome !== 'undefined' && chrome.runtime) {
               chrome.runtime.lastError = { message: String(e && e.message || e) };
             }
             callback();
           } catch(_) {}
         });
        return undefined;
      }
      return p;
    },
  };

  function _installScripting(root) {
    if (!root || typeof root !== 'object') return false;
    try {
      root.scripting = _scripting;
      if (root.scripting === _scripting) return true;
    } catch(_) {}
    try {
      Object.defineProperty(root, 'scripting', {
        value: _scripting, writable: true, configurable: true, enumerable: true,
      });
      return true;
    } catch(_) { return false; }
  }

  if (typeof chrome !== 'undefined' && chrome) {
    _installScripting(chrome);
  } else if (typeof globalThis !== 'undefined') {
    globalThis.chrome = globalThis.chrome || {};
    _installScripting(globalThis.chrome);
  }
})();
`;
}
