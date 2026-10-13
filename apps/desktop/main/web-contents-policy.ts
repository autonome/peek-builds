/**
 * New-window policy decisions, as pure functions.
 *
 * Three checks keep a raw window from running with elevated privileges, and
 * all three used to be written inline inside large Electron-bound functions —
 * the `app.on('web-contents-created', ...)` listener in `entry.ts` and the
 * `setWindowOpenHandler` in `chrome-extensions.ts openChromeExtensionPage()`.
 * Inline, their only coverage was a launched-app Playwright spec, and it
 * exercised two of the branches. Dropping `webSecurity` from the violation
 * list, widening the deny default to another webContents type, or letting a
 * non-http scheme through would all have surfaced only in a full app run.
 *
 * So the decisions live here, with no `electron` import (same shape as the
 * pure functions in `sandbox-enforcement.ts`), and `web-contents-policy.test.ts`
 * pins each branch. The callers keep every log line, message format, throw rule
 * and handler shape they had — this module answers what to do, never does it.
 */

/**
 * webContents types whose isolation prefs Peek checks. Extension background
 * pages and offscreen-rendering surfaces are Electron-managed: they set their
 * own webPreferences, so checking them would false-positive.
 * A denylist on purpose: `sandbox-enforcement.ts SANDBOX_ENFORCED_TYPES` is a
 * three-type allowlist and would silently stop checking `remote` and any type
 * Electron adds later.
 */
export function isIsolationCheckedType(type: string): boolean {
  return type !== 'backgroundPage' && type !== 'offscreen';
}

/** The isolation prefs this policy reads, as a plain shape (no Electron typings). */
export interface IsolationPrefs {
  nodeIntegration?: boolean;
  contextIsolation?: boolean;
  webSecurity?: boolean;
}

/**
 * Names every isolation setting a webContents violates, in the order the log
 * line lists them. Each is a violation only when EXPLICITLY wrong —
 * `nodeIntegration: undefined` and `contextIsolation: undefined` carry the safe
 * Electron defaults, and null prefs mean they were not readable yet.
 */
export function evaluateIsolationViolations(prefs: IsolationPrefs | null): string[] {
  if (!prefs) return [];
  const violations: string[] = [];
  if (prefs.nodeIntegration === true) violations.push('nodeIntegration=true');
  if (prefs.contextIsolation === false) violations.push('contextIsolation=false');
  if (prefs.webSecurity === false) violations.push('webSecurity=false');
  return violations;
}

/**
 * Whether a webContents of this type gets the deny-all `window.open` fallback
 * at creation. Only top-level windows and webview guests: per-window code
 * installs its own handler afterwards and replaces this one, so anything that
 * never installs one fails closed rather than spawning a raw BrowserWindow.
 */
export function hasDefaultDenyWindowOpen(type: string): boolean {
  return type === 'window' || type === 'webview';
}

/**
 * What an extension popup's `window.open(url)` should do: `'route'` sends the
 * URL through Peek's normal window pipeline, `'deny'` refuses it outright.
 * Only `http://` and `https://` route; `chrome-extension:`, `data:`, `blob:`,
 * `javascript:` and `about:blank` would otherwise spawn an unregistered window
 * outside Peek's tile and preload system.
 */
export function decideExtensionPopupOpen(url: string): 'route' | 'deny' {
  if (url.startsWith('http://') || url.startsWith('https://')) return 'route';
  return 'deny';
}
