/**
 * CLI verb dispatcher.
 *
 * Most verbs publish on `cli:<verb>` so feature backgrounds (cmd, peeks,
 * slides, …) can subscribe via their existing dispatch paths — no new IPC,
 * no main-process reaching into renderer guts. A small set of `debug-*`
 * verbs are handled inline because they need to return data to the caller
 * (e.g. evaluating JS in a webContents and shipping the result back).
 *
 * Verbs are sanitised with a strict regex so a malicious socket peer
 * can't inject arbitrary topic names like `cli:foo;internal:bad`.
 */

import { publish } from './pubsub.js';
import { BrowserWindow, webContents as electronWebContents } from 'electron';

const SYSTEM_ADDRESS = 'peek://system/';
const VERB_RE = /^[a-z][a-z0-9-]*$/;

export interface CliMessage {
  verb: string;
  args?: unknown[];
}

export interface CliResult {
  ok: boolean;
  error?: string;
  /** Optional payload for verbs that return data (e.g. debug-eval). */
  data?: unknown;
}

export async function dispatch(msg: CliMessage): Promise<CliResult> {
  if (!msg || typeof msg.verb !== 'string') {
    return { ok: false, error: 'missing verb' };
  }
  if (!VERB_RE.test(msg.verb)) {
    return { ok: false, error: `invalid verb: ${msg.verb}` };
  }
  const args = Array.isArray(msg.args) ? msg.args : [];

  // === Inline (data-returning) verbs ===

  if (msg.verb === 'debug-list-windows') {
    return debugListWindows();
  }
  if (msg.verb === 'debug-eval') {
    return debugEval(args);
  }

  // === Pubsub verbs (fire-and-forget) ===
  publish(SYSTEM_ADDRESS, `cli:${msg.verb}`, { args });
  return { ok: true };
}

/**
 * Enumerate all top-level BrowserWindows (+ their webContents id, title, url).
 * Useful from the CLI to figure out which window/webContents to target with
 * debug-eval.
 */
function debugListWindows(): CliResult {
  const out = BrowserWindow.getAllWindows().map(win => {
    const wc = win.webContents;
    return {
      windowId: win.id,
      webContentsId: wc.id,
      title: (() => { try { return win.getTitle(); } catch { return ''; } })(),
      url: (() => { try { return wc.getURL(); } catch { return ''; } })(),
      destroyed: wc.isDestroyed(),
    };
  });
  return { ok: true, data: out };
}

/**
 * Evaluate a JS expression in a target webContents using
 * webContents.executeJavaScript (Electron's safe path; runs in main world).
 *
 * Args:
 *   [target, expression]
 *   target: number (webContentsId) | string (matched as case-insensitive
 *           substring against title or URL — first hit wins)
 *   expression: string of JS, must evaluate to a value that survives
 *               structured clone (no functions / DOM nodes).
 *
 * Returns: { ok, data: <evaluated value>, error?: <message> }
 */
async function debugEval(args: unknown[]): Promise<CliResult> {
  const [target, expression] = args;
  if (typeof expression !== 'string' || expression.length === 0) {
    return { ok: false, error: 'debug-eval: expression required (arg[1])' };
  }

  // Resolve target to a webContents.
  let wc: Electron.WebContents | null = null;
  if (typeof target === 'number') {
    wc = electronWebContents.fromId(target) ?? null;
  } else if (typeof target === 'string') {
    const needle = target.toLowerCase();
    for (const win of BrowserWindow.getAllWindows()) {
      const t = (() => { try { return win.getTitle(); } catch { return ''; } })().toLowerCase();
      const u = (() => { try { return win.webContents.getURL(); } catch { return ''; } })().toLowerCase();
      if (t.includes(needle) || u.includes(needle)) {
        wc = win.webContents;
        break;
      }
    }
  } else {
    return { ok: false, error: 'debug-eval: target required (arg[0]: webContentsId or title/url substring)' };
  }

  if (!wc) return { ok: false, error: `debug-eval: no webContents matched target ${JSON.stringify(target)}` };
  if (wc.isDestroyed()) return { ok: false, error: 'debug-eval: target webContents is destroyed' };

  try {
    const result = await wc.executeJavaScript(expression, /* userGesture */ false);
    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, error: `debug-eval threw: ${(err as Error)?.message ?? String(err)}` };
  }
}

/**
 * The set of verbs this build advertises. Adding a verb here doesn't
 * register it — the corresponding feature background still has to
 * subscribe to `cli:<verb>` — but it's the canonical list the settings
 * UI renders for users to bind shortcuts to. Keep alphabetical.
 */
export const KNOWN_VERBS: ReadonlyArray<{ verb: string; argHint?: string; description: string }> = [
  { verb: 'cmd-open',   description: 'Open the command panel' },
  { verb: 'peek-open',  argHint: '<n>',    description: 'Open peek N (0–9)' },
  { verb: 'slide-open', argHint: '<edge>', description: 'Open slide on edge (Up|Down|Left|Right)' },
  { verb: 'open-url',   argHint: '<url>',  description: 'Open a URL in a Peek page-host window' },
  { verb: 'debug-list-windows', description: 'List BrowserWindows + their webContents id/title/url' },
  { verb: 'debug-eval', argHint: '<target> <expr>', description: 'Eval JS in a webContents (target = id|title|url substring)' },
];
