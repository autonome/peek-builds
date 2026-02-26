#!/usr/bin/env electron
/**
 * Debug Electron pages by capturing console output, errors, and evaluating JS.
 *
 * Usage:
 *   npx electron scripts/debug-electron-page.mjs [options]
 *
 * Options:
 *   --url <url>            URL to load (required unless --extension provides default)
 *   --extension <path>     Path to Chrome extension to load
 *   --eval <js>            JS expression to evaluate after load (repeatable)
 *   --timeout <ms>         Time to wait before exit (default: 5000)
 *   --session <partition>  Session partition name
 *   --wait-sw <ms>         Extra wait for service worker startup (default: 2000)
 *   --preload <path>       Path to preload script
 *   --show                 Show the BrowserWindow (default: hidden)
 *
 * Output format:
 *   [CONSOLE:error]   Console errors with source location
 *   [CONSOLE:warning] Console warnings
 *   [CONSOLE:log]     Console log messages
 *   [CONSOLE:debug]   Console debug messages
 *   [PAGE:url]        Final page URL after load
 *   [PAGE:title]      Page title
 *   [PAGE:crash]      Renderer process crash info
 *   [PAGE:fail]       Page load failure
 *   [SW:running]      Service worker status
 *   [SW:stopped]      No service workers detected
 *   [SW:console]      Service worker console output
 *   [EXT:loaded]      Extension loaded successfully
 *   [EXT:error]       Extension load failure
 *   [EVAL]            Result of --eval expression
 *   [EVAL:error]      Error from --eval expression
 *   [ERROR]           Uncaught exception / unhandled rejection
 *   [EXIT]            Script exit info
 */

import { app, BrowserWindow, session, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    url:       { type: 'string' },
    extension: { type: 'string' },
    eval:      { type: 'string', multiple: true },
    timeout:   { type: 'string', default: '5000' },
    session:   { type: 'string' },
    'wait-sw': { type: 'string', default: '2000' },
    preload:   { type: 'string' },
    polyfills: { type: 'boolean', default: false },
    show:      { type: 'boolean', default: false },
  },
  strict: false,
  allowPositionals: true,
});

const TIMEOUT     = parseInt(args.timeout || '5000', 10);
const WAIT_SW     = parseInt(args['wait-sw'] || '2000', 10);
const EVALS       = args.eval || [];
const SHOW        = args.show || false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Electron console-message numeric levels: 0=verbose/debug, 1=info/log, 2=warning, 3=error
const LEVEL_NAMES_NUMERIC = ['debug', 'log', 'warning', 'error'];

function levelName(level) {
  if (typeof level === 'number') {
    return LEVEL_NAMES_NUMERIC[level] || `level${level}`;
  }
  // Newer Electron passes string level names; normalize 'info' -> 'log'
  const s = String(level);
  return s === 'info' ? 'log' : s;
}

function emit(tag, message) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${tag}] ${message}  (${ts})`);
}

function emitConsole(level, message, line, sourceId) {
  const name = levelName(level);
  const loc = sourceId ? ` (${path.basename(sourceId)}${line != null ? ':' + line : ''})` : '';
  emit(`CONSOLE:${name}`, `${message}${loc}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  try {
    await run();
  } catch (err) {
    emit('ERROR', `Fatal: ${err.message}`);
    app.exit(1);
  }
});

async function run() {
  // Determine session
  const ses = args.session
    ? session.fromPartition(args.session)
    : session.defaultSession;

  // -------------------------------------------------------------------------
  // Load extension if requested
  // -------------------------------------------------------------------------
  let extensionId = null;

  if (args.extension) {
    const extPath = path.resolve(args.extension);
    try {
      // Use newer API if available (Electron 33+), fall back to deprecated one
      const loader = ses.extensions || ses;
      const ext = await loader.loadExtension(extPath, {
        allowFileAccess: true,
      });
      extensionId = ext.id;
      emit('EXT:loaded', `id=${ext.id} name="${ext.name}" path=${extPath}`);
    } catch (err) {
      emit('EXT:error', `Failed to load extension: ${err.message}`);
      // Continue anyway — user may want to debug why it fails
    }
  }

  // -------------------------------------------------------------------------
  // Register Chrome API polyfills if --polyfills flag is set
  // -------------------------------------------------------------------------
  let polyfillScript = null;

  if (args.polyfills) {
    try {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const polyfillsPath = path.resolve(__dirname, '..', 'backend', 'electron', 'chrome-api-polyfills', 'index.js');
      const polyfills = await import(polyfillsPath);
      const handle = polyfills.registerAll(ses, { ipcMain, app });
      polyfillScript = handle.getPreloadScript();
      emit('POLYFILL', `Registered chrome API polyfills`);

      // Inject polyfill into all chrome-extension:// webContents on dom-ready
      app.on('web-contents-created', (_event, webContents) => {
        webContents.on('dom-ready', () => {
          const url = webContents.getURL();
          if (url.startsWith('chrome-extension://') && polyfillScript) {
            webContents.executeJavaScript(polyfillScript).catch(() => {});
          }
        });
      });
    } catch (err) {
      emit('POLYFILL:error', `Failed to register polyfills: ${err.message}`);
    }
  }

  // -------------------------------------------------------------------------
  // Wait for service worker (extensions often need a moment)
  // -------------------------------------------------------------------------
  if (extensionId) {
    emit('SW:waiting', `Waiting ${WAIT_SW}ms for service worker startup...`);
    await new Promise(r => setTimeout(r, WAIT_SW));

    // Capture service worker console output
    ses.serviceWorkers.on('console-message', (event, details) => {
      emit('SW:console', `[${levelName(details.level)}] ${details.message}`);
    });

    // Report SW status
    const workers = ses.serviceWorkers.getAllRunning();
    const workerEntries = Object.entries(workers);
    if (workerEntries.length === 0) {
      emit('SW:stopped', 'No service workers running');
    } else {
      for (const [versionId, info] of workerEntries) {
        emit('SW:running', `versionId=${versionId} scope=${info.scope}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Resolve URL
  // -------------------------------------------------------------------------
  let targetUrl = args.url;

  // Replace EXTENSION_ID placeholder
  if (targetUrl && extensionId) {
    targetUrl = targetUrl.replace(/EXTENSION_ID/g, extensionId);
  }

  if (!targetUrl) {
    if (extensionId) {
      // Default to extension's popup or settings page
      targetUrl = `chrome-extension://${extensionId}/popup.html`;
      emit('PAGE:url', `No --url specified, defaulting to ${targetUrl}`);
    } else {
      emit('ERROR', 'No --url specified and no extension loaded');
      app.exit(1);
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Create BrowserWindow
  // -------------------------------------------------------------------------
  const winOptions = {
    width: 1280,
    height: 900,
    show: SHOW,
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
    },
  };

  if (args.preload) {
    winOptions.webPreferences.preload = path.resolve(args.preload);
  }

  const win = new BrowserWindow(winOptions);
  const wc = win.webContents;

  // -------------------------------------------------------------------------
  // Wire up event listeners
  // -------------------------------------------------------------------------

  // Console messages (use new Event object API, Electron 33+)
  wc.on('console-message', (event) => {
    const { level, message, line, sourceId } = event;
    emitConsole(level, message, line, sourceId);
  });

  // Renderer crash
  wc.on('render-process-gone', (event, details) => {
    emit('PAGE:crash', `reason=${details.reason} exitCode=${details.exitCode}`);
  });

  // Page load failure
  wc.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    emit('PAGE:fail', `code=${errorCode} desc="${errorDescription}" url=${validatedURL}`);
  });

  // Certificate errors (ignore for debugging)
  wc.on('certificate-error', (event, url, error, certificate, callback) => {
    event.preventDefault();
    callback(true);
  });

  // -------------------------------------------------------------------------
  // Load the URL
  // -------------------------------------------------------------------------
  emit('PAGE:loading', targetUrl);

  try {
    await wc.loadURL(targetUrl);
  } catch (err) {
    emit('PAGE:fail', `loadURL error: ${err.message}`);
  }

  // Report final page state
  emit('PAGE:url', wc.getURL());
  emit('PAGE:title', wc.getTitle());

  // -------------------------------------------------------------------------
  // Run --eval expressions
  // -------------------------------------------------------------------------
  for (const expr of EVALS) {
    try {
      const result = await wc.executeJavaScript(`
        (function() {
          try {
            var __result = (${expr});
            if (__result instanceof Promise) {
              return __result.then(function(v) {
                return { ok: true, value: String(v), type: typeof v };
              }).catch(function(e) {
                return { ok: false, error: String(e) };
              });
            }
            return { ok: true, value: String(__result), type: typeof __result };
          } catch(e) {
            return { ok: false, error: String(e) };
          }
        })()
      `);
      if (result.ok) {
        emit('EVAL', `${expr} = ${result.value} (${result.type})`);
      } else {
        emit('EVAL:error', `${expr} => ${result.error}`);
      }
    } catch (err) {
      emit('EVAL:error', `${expr} => executeJavaScript failed: ${err.message}`);
    }
  }

  // -------------------------------------------------------------------------
  // Collect DOM snapshot info
  // -------------------------------------------------------------------------
  try {
    const domInfo = await wc.executeJavaScript(`
      (function() {
        var info = {};
        info.doctype = document.doctype ? document.doctype.name : 'none';
        info.bodyChildCount = document.body ? document.body.childElementCount : 0;
        info.bodyTextLength = document.body ? document.body.innerText.length : 0;
        info.title = document.title;
        var root = document.querySelector('#root') || document.querySelector('#app');
        if (root) {
          info.rootId = root.id;
          info.rootChildCount = root.childElementCount;
          info.rootInnerHTMLLength = root.innerHTML.length;
        }
        info.scripts = document.querySelectorAll('script').length;
        info.stylesheets = document.querySelectorAll('link[rel="stylesheet"]').length;
        return info;
      })()
    `);
    emit('DOM', `doctype=${domInfo.doctype} bodyChildren=${domInfo.bodyChildCount} bodyText=${domInfo.bodyTextLength}chars scripts=${domInfo.scripts} stylesheets=${domInfo.stylesheets}`);
    if (domInfo.rootId) {
      emit('DOM', `#${domInfo.rootId} children=${domInfo.rootChildCount} innerHTML=${domInfo.rootInnerHTMLLength}chars`);
    }
  } catch (err) {
    emit('DOM:error', `DOM inspection failed: ${err.message}`);
  }

  // -------------------------------------------------------------------------
  // Wait for remaining console output, then exit
  // -------------------------------------------------------------------------
  const remaining = Math.max(1000, TIMEOUT - WAIT_SW);
  emit('EXIT', `Listening for ${remaining}ms more before exit...`);

  await new Promise(r => setTimeout(r, remaining));

  // Final service worker check
  if (extensionId) {
    const workers = ses.serviceWorkers.getAllRunning();
    const workerEntries = Object.entries(workers);
    emit('SW:final', workerEntries.length > 0
      ? `${workerEntries.length} service worker(s) running`
      : 'No service workers running');
  }

  emit('EXIT', `Clean exit after ${TIMEOUT}ms`);
  app.exit(0);
}
