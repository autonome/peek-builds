/**
 * Page-host chrome-extension compat installers (shared between the legacy
 * `<webview>` path and the hybrid `WebContentsView` content path).
 *
 * Background — the timing trap (P1.2):
 *   entry.ts's `web-contents-created` handler gates the MAIN-world content-
 *   script injection + the runtime-external CDP page polyfill on
 *   `isPageHostContent(contents)`. For a `<webview>` guest that gate is true
 *   at `web-contents-created` time (`getType() === 'webview'`).
 *
 *   For the hybrid path the content webContents is created by
 *   `new WebContentsView({...})`, and `web-contents-created` fires
 *   SYNCHRONOUSLY inside that constructor — BEFORE the ipc.ts hybrid branch
 *   has a chance to call `markPageHostContent(view.webContents)`. So at
 *   gate-eval time `isPageHostContent` is still false for the hybrid content,
 *   and the dom-ready + did-navigate hooks would never attach.
 *
 *   Fix: extract the attach logic into the installers below so the ipc.ts
 *   hybrid branch can call them EXPLICITLY right after `markPageHostContent`,
 *   making attachment independent of `web-contents-created` timing for the
 *   hybrid path. The legacy webview path keeps calling the same installers
 *   from entry.ts under its existing `isPageHostContent` gate, so its
 *   behavior is unchanged.
 *
 * This is a leaf module: it only imports from chrome-extensions.ts and the
 * runtime-external polyfill (themselves leaf modules), so importing it from
 * both entry.ts and ipc.ts introduces no cycle.
 */

import fs from 'node:fs';
import path from 'node:path';
import { type WebContents } from 'electron';
import {
  findExtensionByExternallyConnectableUrl,
  getMatchingMainWorldContentScripts,
  getMatchingIsolatedContentScripts,
} from './chrome-extensions.js';
import {
  getPreloadPath as getRuntimeExternalPreloadPath,
  getPagePolyfillSource as getRuntimeExternalPagePolyfillSource,
} from './chrome-api-polyfills/runtime-external.js';
import { DEBUG } from './config.js';

/**
 * webPreferences fragment for the runtime-external / content-script compat
 * preload, keyed on the target URL. `undefined` means "this URL needs no
 * runtime-external preload" (peek:// URLs, non-http(s), or no matching
 * extension) — callers leave webPreferences untouched in that case.
 *
 * preload is construction-fixed for both `<webview>` (set in
 * `will-attach-webview`) and `WebContentsView` (set in its constructor), so
 * this selection MUST run before the content webContents exists.
 */
export interface RuntimeExternalWebPrefs {
  preload: string;
  additionalArguments: string[];
  // GLOBAL sandbox:true (peek 06d363fc). This preload matches Proton Pass's
  // <all_urls> content scripts, so it applies to EVERY http(s) page — meaning
  // ALL web content now renders SANDBOXED. Previously sandbox:false, which
  // routed a hybrid window.open popup's defensive handle.close() through
  // guest-window-manager IPC and threw "IPC method called after context was
  // released" once the popup self-closed (breaking real popup OAuth). A
  // sandboxed renderer uses Chromium's native close → the double-close is a
  // silent no-op. Enabled only after the Electron 40→43 upgrade, which resolves
  // the sandbox_bundle renderer-init crash that originally forced sandbox:false.
  sandbox: true;
  contextIsolation: true;
}

/**
 * Decide whether `url` needs the runtime-external compat preload, and if so
 * return the webPreferences fragment to apply.
 *
 * Mirrors the selection logic that previously lived inline in entry.ts's
 * `will-attach-webview` handler:
 *   1. http(s) URL matching a loaded extension's externally_connectable →
 *      runtime-external preload + `--peek-runtime-external-ext-id`
 *      (+ `--peek-cs-relay-enabled` if it also matches ISOLATED content
 *      scripts).
 *   2. else http(s) URL matching ISOLATED content scripts of a loaded
 *      extension → runtime-external preload + `--peek-runtime-external-ext-id`
 *      keyed on the first matching content-script extension.
 *   3. else → null.
 *
 * Honors `PEEK_DISABLE_RUNTIME_EXTERNAL_POLYFILL=1` (returns null).
 *
 * `logChannel` only affects the diagnostic log prefix so the two call sites
 * ('webview' vs 'hybrid') are distinguishable in the console.
 */
export function getRuntimeExternalWebPrefsForUrl(
  url: string,
  logChannel: 'webview' | 'hybrid' = 'webview'
): RuntimeExternalWebPrefs | null {
  if (!url || !(url.startsWith('http://') || url.startsWith('https://'))) {
    // Non-http(s) (peek:// tiles, about:blank, etc.) get no preload — they run
    // their own tile-preload and never need the editable-focus signal.
    return null;
  }

  // UNIVERSAL preload (peek 51798bae): every http(s) page-host content WC loads
  // runtime-external-preload.cjs so the main process gets a deterministic
  // "editable focused?" signal (focusin/focusout → page:editable-focus), used
  // by the hybrid ESC handler to blur/dismiss the field instead of stealing ESC
  // to open the Windows switcher. The chrome-extension messaging polyfill inside
  // that preload is GATED on the --peek-runtime-external-ext-id arg, so a page
  // with no matching extension (or with the compat polyfill disabled via env)
  // loads ONLY the focus-tracking half — the messaging bridge stays dormant.
  const additionalArguments: string[] = [];

  if (process.env.PEEK_DISABLE_RUNTIME_EXTERNAL_POLYFILL === '1') {
    // Env disables only the chrome-compat half (no ext-id arg → dormant bridge);
    // the focus-tracking preload is still applied so ESC-in-editable stays fixed.
    if (DEBUG && (url.includes('proton.me') || url.includes('proton.dev'))) {
      console.log(`[peek:runtime-external:${logChannel}] compat polyfill disabled via env for ${url} (focus-tracking preload still applied)`);
    }
  } else {
    const matchedExtId = findExtensionByExternallyConnectableUrl(url);
    if (matchedExtId) {
      additionalArguments.push(`--peek-runtime-external-ext-id=${matchedExtId}`);
      if (getMatchingIsolatedContentScripts(url).length > 0) {
        additionalArguments.push('--peek-cs-relay-enabled');
      }
      console.log(`[peek:runtime-external:${logChannel}] Injecting runtime-external preload for ${url} (ext=${matchedExtId}, sandbox=true)`);
    } else {
      // Fallback: ISOLATED-world content-script match (no externally_connectable).
      const csMatches = getMatchingIsolatedContentScripts(url);
      if (csMatches.length > 0) {
        const csExtId = csMatches[0].runtimeExtId;
        additionalArguments.push(`--peek-runtime-external-ext-id=${csExtId}`);
        console.log(`[peek:runtime-external:${logChannel}] Injecting runtime-external preload for content-script URL ${url} (ext=${csExtId})`);
      } else if (DEBUG && (url.includes('proton.me') || url.includes('proton.dev'))) {
        console.log(`[peek:runtime-external:${logChannel}] No extension matched ${url} — focus-tracking preload only`);
      }
    }
  }

  return {
    preload: getRuntimeExternalPreloadPath(),
    additionalArguments,
    sandbox: true,
    contextIsolation: true,
  };
}

/**
 * Install MAIN-world content-script auto-injection on `wc`.
 *
 * Electron's `session.loadExtension` does NOT auto-inject `world: "MAIN"`
 * content_scripts (ISOLATED ones it handles natively). On every `dom-ready`,
 * read the matching MAIN-world scripts for the current URL and run them via
 * `executeJavaScript` (which runs in the main world).
 *
 * Extracted verbatim from entry.ts's inline `dom-ready` closure so the SAME
 * code runs for both a `<webview>` guest and a hybrid `WebContentsView`.
 */
export function installMainWorldContentScriptInjection(wc: WebContents): void {
  const wcId = wc.id;
  wc.on('dom-ready', () => {
    const url = wc.getURL();
    // Probe (P1.2 timing-fix proof): fires regardless of extension match so we
    // can confirm the dom-ready installer attached to the hybrid content wc.
    if (process.env.PEEK_PAGEHOST_HYBRID_PROBE === '1') {
      console.log(`[page-host-compat:probe] dom-ready FIRED for wc ${wcId} url=${url.slice(0, 80)}`);
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) return;

    const injections = getMatchingMainWorldContentScripts(url);
    for (const inj of injections) {
      let src: string;
      try {
        src = fs.readFileSync(inj.scriptPath, 'utf-8');
      } catch (err) {
        console.error(`[content-script-inject] Failed to read ${inj.scriptPath}:`, err);
        continue;
      }
      wc.executeJavaScript(src).catch(() => {
        // Ignore injection errors (webContents may be destroyed)
      });
      DEBUG && console.log(`[content-script-inject] ${inj.extId}: injected ${path.basename(inj.scriptPath)} (run_at=${inj.runAt}, world=MAIN) into ${url}`);
    }
  });
}

/**
 * Install the chrome.runtime.sendMessage page polyfill via CDP
 * `Page.addScriptToEvaluateOnNewDocument` on `wc`.
 *
 * CDP guarantees main-world execution BEFORE any page script on every
 * navigation, with no IPC round-trip — critical because Proton's SPA reads
 * Electron's broken native chrome.runtime essentially synchronously after a
 * route change, faster than a `did-navigate` → `executeJavaScript` round-trip
 * could win.
 *
 * Registers once (on the first matching `did-navigate`); the script then runs
 * on every subsequent document creation. The very first document is covered
 * by the runtime-external preload's webFrame.executeJavaScript path.
 *
 * Extracted verbatim from entry.ts's inline `did-navigate` closure.
 */
export function installRuntimeExternalCdpPolyfill(wc: WebContents): void {
  const wcId = wc.id;
  let polyfillScriptRegistered = false;
  const tryRegisterCDPPolyfill = async (url: string) => {
    // Probe (P1.2 timing-fix proof): fires regardless of extension match.
    if (process.env.PEEK_PAGEHOST_HYBRID_PROBE === '1') {
      console.log(`[page-host-compat:probe] did-navigate FIRED for wc ${wcId} url=${url.slice(0, 80)}`);
    }
    if (polyfillScriptRegistered) return;
    if (process.env.PEEK_DISABLE_RUNTIME_EXTERNAL_POLYFILL === '1') return;
    if (!url.startsWith('http://') && !url.startsWith('https://')) return;
    const matchedExtId = findExtensionByExternallyConnectableUrl(url);
    if (!matchedExtId) return;
    try {
      if (!wc.debugger.isAttached()) {
        wc.debugger.attach('1.3');
      }
      await wc.debugger.sendCommand('Page.enable');
      await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: getRuntimeExternalPagePolyfillSource(matchedExtId),
      });
      polyfillScriptRegistered = true;
      DEBUG && console.log(`[peek:runtime-external] CDP addScriptToEvaluateOnNewDocument registered (ext=${matchedExtId})`);
    } catch (err) {
      console.error('[peek:runtime-external] CDP install failed:', (err as Error)?.message ?? err);
    }
  };
  wc.on('did-navigate', (_e, url) => { void tryRegisterCDPPolyfill(url); });
}
