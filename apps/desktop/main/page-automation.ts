/**
 * Page automation — the gate and the operations behind `tile:automation:run`.
 *
 * Lets a feature drive a web page it opened itself (through
 * `tile:window:open`): navigate it, wait for an element, run a script in it,
 * click an element, print it to PDF. The page runs in the profile's normal
 * session, so it carries the user's cookies; that is the point, and it is why
 * the gate is narrow:
 *
 *   1. the grant must carry `capabilities.automation` (any feature may request
 *      it; the manifest's `origins` list is the scope);
 *   2. the target window must have been opened by the calling tile;
 *   3. the page's current origin must be in `origins` (a fresh `about:blank`
 *      window counts as allowed so the first navigation can happen), and a
 *      navigation's destination must be too.
 *
 * The origin check runs before every operation, so a page that redirected off
 * the allowed origins (a login on another host, say) can still be asked for
 * its URL but cannot be scripted until it comes back.
 *
 * Pure module: no Electron import. `tile-ipc.ts` resolves the window and hands
 * its content webContents in as an `AutomationTarget`.
 */

import type { CapabilityGrant } from './tile-manifest.js';

/** The slice of an Electron `WebContents` the operations use. */
export interface AutomationTarget {
  getURL(): string;
  getTitle(): string;
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  printToPDF(options: Record<string, unknown>): Promise<Uint8Array>;
}

export type AutomationOp =
  | { op: 'url' }
  | { op: 'navigate'; url: string; timeoutMs?: number }
  | { op: 'waitFor'; selector: string; timeoutMs?: number }
  | { op: 'eval'; script: string; timeoutMs?: number }
  | { op: 'click'; selector: string; timeoutMs?: number }
  | { op: 'printToPDF'; options?: Record<string, unknown>; timeoutMs?: number };

export type AutomationResult =
  | { ok: true; url: string; title: string; value?: unknown; pdf?: Uint8Array }
  | { ok: false; error: string; url?: string };

export type AutomationCheck = { ok: true } | { ok: false; error: string };

/** Default and ceiling for how long one operation may run. */
export const DEFAULT_OP_TIMEOUT_MS = 10_000;
export const MAX_OP_TIMEOUT_MS = 120_000;

/**
 * The `source` a window opened by `tileId` through `tile:window:open` is
 * registered with. The opener check compares against this.
 */
export function tileWindowSource(tileId: string): string {
  return `peek://${tileId}/background`;
}

function clampTimeout(ms: number | undefined): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return DEFAULT_OP_TIMEOUT_MS;
  return Math.min(ms, MAX_OP_TIMEOUT_MS);
}

/**
 * Whether one manifest origin pattern covers a parsed page URL. Exact patterns
 * compare origins (scheme, host, port). `https://*.host` covers any subdomain
 * of host on the default port, but not host itself.
 */
function originMatches(pattern: string, page: URL): boolean {
  const wildcard = /^https:\/\/\*\.([^/:]+)$/i.exec(pattern);
  if (wildcard) {
    const suffix = `.${wildcard[1].toLowerCase()}`;
    return page.protocol === 'https:' && page.port === '' && page.hostname.endsWith(suffix);
  }
  try {
    return new URL(pattern).origin === page.origin;
  } catch {
    return false;
  }
}

/**
 * Whether `url` is on an origin the grant may automate. Only http(s) URLs can
 * be allowed. Trusted-builtin core renderers bypass the list, like every other
 * capability check.
 */
export function isAutomationOriginAllowed(grant: CapabilityGrant, url: string): boolean {
  let page: URL;
  try {
    page = new URL(url);
  } catch {
    return false;
  }
  if (page.protocol !== 'https:' && page.protocol !== 'http:') return false;
  if (grant.trustedBuiltin) return true;
  const origins = grant.capabilities.automation?.origins;
  if (!Array.isArray(origins)) return false;
  return origins.some(pattern => originMatches(pattern, page));
}

/**
 * Decide whether `grant` may run `op` against a window registered with
 * `windowSource` whose page is currently at `currentUrl`.
 */
export function checkAutomationAllowed(
  grant: CapabilityGrant | null,
  op: AutomationOp,
  target: { windowSource: string | undefined; currentUrl: string },
): AutomationCheck {
  if (!grant) return { ok: false, error: 'Invalid token' };
  if (!grant.trustedBuiltin && !grant.capabilities.automation) {
    return { ok: false, error: 'automation capability not granted' };
  }
  if (!grant.trustedBuiltin && target.windowSource !== tileWindowSource(grant.tileId)) {
    return { ok: false, error: 'window was not opened by this tile' };
  }
  if (op.op === 'url') return { ok: true };

  const blank = target.currentUrl === '' || target.currentUrl === 'about:blank';
  if (op.op === 'navigate') {
    if (!isAutomationOriginAllowed(grant, op.url)) {
      return { ok: false, error: `origin of ${op.url} not in automation.origins` };
    }
    // Navigating away from a page on another origin is allowed: the feature
    // opened the window, and the destination is what gets scripted next.
    return { ok: true };
  }
  if (blank || !isAutomationOriginAllowed(grant, target.currentUrl)) {
    return { ok: false, error: `page origin not in automation.origins: ${blank ? 'about:blank' : originOf(target.currentUrl)}` };
  }
  return { ok: true };
}

function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return url; }
}

/**
 * A page script that resolves `true` once `selector` matches an element, or
 * `false` after `timeoutMs`. Polls rather than observing so it also catches
 * elements a framework swaps in without a DOM mutation the observer would see
 * on the right node.
 */
export function buildWaitForSelectorScript(selector: string, timeoutMs: number): string {
  return `new Promise((resolve) => {
  const sel = ${JSON.stringify(selector)};
  const deadline = Date.now() + ${Math.max(0, Math.floor(timeoutMs))};
  const tick = () => {
    if (document.querySelector(sel)) return resolve(true);
    if (Date.now() >= deadline) return resolve(false);
    setTimeout(tick, 100);
  };
  tick();
})`;
}

/**
 * A page script that scrolls the first element matching `selector` into view
 * and clicks it, resolving `true`, or resolves `false` when nothing matches.
 */
export function buildClickScript(selector: string): string {
  return `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  el.scrollIntoView({ block: 'center' });
  el.click();
  return true;
})()`;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      err => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Run one checked operation against `target`. The caller has already passed
 * `checkAutomationAllowed`; this re-reads nothing about the grant. Errors come
 * back as `{ ok: false }`, never as a rejection.
 */
export async function runAutomationOp(target: AutomationTarget, op: AutomationOp): Promise<AutomationResult> {
  if (target.isDestroyed()) return { ok: false, error: 'window is closed' };
  const done = (extra: { value?: unknown; pdf?: Uint8Array } = {}): AutomationResult => ({
    ok: true,
    url: target.isDestroyed() ? '' : target.getURL(),
    title: target.isDestroyed() ? '' : target.getTitle(),
    ...extra,
  });
  const timeoutMs = clampTimeout((op as { timeoutMs?: number }).timeoutMs);

  try {
    switch (op.op) {
      case 'url':
        return done();
      case 'navigate':
        await withTimeout(target.loadURL(op.url), timeoutMs, 'navigate');
        return done();
      case 'waitFor': {
        const found = await withTimeout(
          target.executeJavaScript(buildWaitForSelectorScript(op.selector, timeoutMs)),
          timeoutMs + 1_000,
          'waitFor',
        );
        if (found !== true) return { ok: false, error: `selector not found within ${timeoutMs} ms: ${op.selector}`, url: target.getURL() };
        return done();
      }
      case 'eval': {
        const value = await withTimeout(target.executeJavaScript(op.script, true), timeoutMs, 'eval');
        return done({ value });
      }
      case 'click': {
        // userGesture so a click that starts a download or opens a popup is
        // treated as user-initiated by the page.
        const clicked = await withTimeout(target.executeJavaScript(buildClickScript(op.selector), true), timeoutMs, 'click');
        if (clicked !== true) return { ok: false, error: `no element matches ${op.selector}`, url: target.getURL() };
        return done();
      }
      case 'printToPDF': {
        const data = await withTimeout(target.printToPDF(op.options ?? { printBackground: true }), timeoutMs, 'printToPDF');
        return done({ pdf: new Uint8Array(data) });
      }
      default: {
        const unknownOp: never = op;
        return { ok: false, error: `unknown automation op: ${String((unknownOp as { op?: unknown }).op)}` };
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      url: target.isDestroyed() ? undefined : target.getURL(),
    };
  }
}

/** Shape-check an op arriving over IPC. Returns null when malformed. */
export function parseAutomationOp(raw: unknown): AutomationOp | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const timeoutMs = typeof o.timeoutMs === 'number' ? o.timeoutMs : undefined;
  switch (o.op) {
    case 'url':
      return { op: 'url' };
    case 'navigate':
      return typeof o.url === 'string' ? { op: 'navigate', url: o.url, timeoutMs } : null;
    case 'waitFor':
      return typeof o.selector === 'string' && o.selector ? { op: 'waitFor', selector: o.selector, timeoutMs } : null;
    case 'click':
      return typeof o.selector === 'string' && o.selector ? { op: 'click', selector: o.selector, timeoutMs } : null;
    case 'eval':
      return typeof o.script === 'string' ? { op: 'eval', script: o.script, timeoutMs } : null;
    case 'printToPDF': {
      const options = o.options && typeof o.options === 'object' ? o.options as Record<string, unknown> : undefined;
      return { op: 'printToPDF', options, timeoutMs };
    }
    default:
      return null;
  }
}
