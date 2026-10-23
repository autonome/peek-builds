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
 * pins each branch. The callers keep every log line, message format and handler
 * shape they had — this module answers what to do, never does it.
 *
 * Two more decisions joined the original three once an isolation violation
 * became a refusal rather than a log line: the verdict for a created
 * webContents (`decideWebContentsIsolation`, with `isolationRefusalMessage` for
 * what it logs) and the input check that refuses a window-open request before a
 * window exists (`unsafeWebPreferenceOverrides`).
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
 * What to do with a webContents whose isolation prefs have just been read.
 *
 * `recheck-on-navigation` is the null-prefs answer: some surfaces do not expose
 * `getLastWebPreferences()` until a page loads, so no verdict can be reached at
 * creation and the caller asks again on the first navigation (the shape
 * `sandbox-enforcement.ts` already uses). A null-prefs surface is never
 * silently allowed.
 */
export type IsolationVerdict =
  | { decision: 'allow' }
  | { decision: 'recheck-on-navigation' }
  | { decision: 'refuse'; violations: string[] };

/**
 * The refusal decision for one webContents, in every build. A violation is
 * refused outright rather than logged: the webContents loads no content and its
 * owning window is torn down. There is no environment branch — a release build
 * that let the window run was the unsafe case this replaces.
 */
export function decideWebContentsIsolation(args: {
  type: string;
  prefs: IsolationPrefs | null;
}): IsolationVerdict {
  if (!isIsolationCheckedType(args.type)) return { decision: 'allow' };
  if (!args.prefs) return { decision: 'recheck-on-navigation' };
  const violations = evaluateIsolationViolations(args.prefs);
  if (violations.length > 0) return { decision: 'refuse', violations };
  return { decision: 'allow' };
}

/** The single `[SECURITY]` line a refusal logs, pinned here so a test owns its shape. */
export function isolationRefusalMessage(args: {
  id: number;
  type: string;
  url: string;
  violations: string[];
}): string {
  const url = args.url || '<no url yet>';
  return (
    `[SECURITY] webContents ${args.id} (type=${args.type}, url=${url}) violates isolation ` +
    `policy: ${args.violations.join(', ')} — refused: no content will load in it and its ` +
    `window is being torn down`
  );
}

/**
 * The webPreferences a caller is never allowed to ask a new window for. Wider
 * than `IsolationPrefs` by one setting: `sandbox` belongs here because a
 * window-open request can be refused before anything is built, whereas a
 * created webContents running unsandboxed is already fatal
 * (`sandbox-enforcement.ts`), so the isolation check has no use for it.
 */
export interface WebPreferenceOverrides extends IsolationPrefs {
  sandbox?: boolean;
}

/**
 * Names every unsafe override a window-open request carries, so the request can
 * be refused before a window exists. As with `evaluateIsolationViolations`,
 * only an EXPLICITLY unsafe value counts — an absent key means the caller
 * expressed no opinion and Peek's own defaults apply.
 */
export function unsafeWebPreferenceOverrides(
  prefs: WebPreferenceOverrides | null | undefined,
): string[] {
  if (!prefs || typeof prefs !== 'object') return [];
  const unsafe: string[] = [];
  if (prefs.nodeIntegration === true) unsafe.push('nodeIntegration=true');
  if (prefs.contextIsolation === false) unsafe.push('contextIsolation=false');
  if (prefs.webSecurity === false) unsafe.push('webSecurity=false');
  if (prefs.sandbox === false) unsafe.push('sandbox=false');
  return unsafe;
}

/**
 * Whether a tile's window may embed `<webview>` elements. Decided only by the
 * `webview` capability the opened tile's manifest was granted (builtin features
 * only, see `resolveCapabilities`); a caller's own `webPreferences.webviewTag`
 * is never consulted, so no tile can switch embedding on for a window by
 * asking.
 */
export function webviewTagForGrant(
  capabilities: Record<string, unknown> | null | undefined,
): boolean {
  return !!capabilities && capabilities.webview === true;
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

/**
 * Runs the teardown of a refused window without letting a throw escape (the
 * window may already be destroyed, or closing it may fail). Returns what
 * `attempt` returns; if it throws, logs once with `label` and the error message
 * and returns `true`. `true` after a throw is deliberate: the caller records
 * the result as "torn down" so the teardown is not retried on every later
 * navigation. The refusal still blocks navigation and `window.open`, so the
 * webContents stays inert whether or not the window closed.
 */
export function runRefusedTeardown(
  attempt: () => boolean,
  label: string,
  log: (message: string) => void,
): boolean {
  try {
    return attempt();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`[isolation] teardown of refused ${label} failed: ${reason}`);
    return true;
  }
}
