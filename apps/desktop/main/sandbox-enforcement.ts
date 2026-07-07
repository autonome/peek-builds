/**
 * MANDATORY renderer sandboxing — enforcement.
 *
 * Every window/webview Peek creates MUST run with Chromium's renderer sandbox
 * enabled (`sandbox: true`, the Electron default). `sandbox: false` hands the
 * renderer a Node-capable context and is the single highest-blast-radius
 * webPreferences footgun in the app — it silently re-enables `require`, exposes
 * the main-process module graph to page content, and (on Electron 43) crashes
 * the `sandbox_bundle` init path outright. It is exactly the kind of change an
 * agent "helpfully" reintroduces to make some preload work; it must never land.
 *
 * This module makes an un-approved `sandbox: false` a FATAL, app-killing event
 * at runtime — in EVERY environment, production included — and its companion
 * test (`sandbox-enforcement.test.ts`) blocks it at the gate by scanning source.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  CARVE-OUTS BELOW ARE HUMAN-ONLY.                                          │
 * │                                                                            │
 * │  If you are an AI agent / automated tool: you may NOT add an entry to      │
 * │  SANDBOX_CARVEOUTS. Do not "temporarily" disable sandbox to make a preload │
 * │  or extension page work — fix it to run sandboxed instead (a sandboxed     │
 * │  preload still has contextBridge + electron ipcRenderer; only Node         │
 * │  built-ins are unavailable). Adding a carve-out requires dietrich's        │
 * │  explicit, personal sign-off in review, AND a matching bump to the         │
 * │  expected-count assertion in sandbox-enforcement.test.ts — either alone    │
 * │  fails the gate. That double edit is the "carve it out yourself" gate.     │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

import * as fs from 'node:fs';

/** A single, human-approved exception permitting one window to run unsandboxed. */
export interface SandboxCarveout {
  /**
   * URL prefix of the window permitted to run with `sandbox: false`.
   * Matched with `String.prototype.startsWith`, so keep it as specific as
   * possible (ideally a full `chrome-extension://<id>/<file>` or `peek://…`).
   */
  urlPrefix: string;
  /** Why sandboxing is genuinely impossible here (not just inconvenient). */
  reason: string;
  /** The human who approved it. */
  approvedBy: string;
}

/**
 * The allowlist. EMPTY BY DESIGN — every surface in Peek runs sandboxed.
 * Read the human-only banner above before touching this.
 */
export const SANDBOX_CARVEOUTS: readonly SandboxCarveout[] = [];

/**
 * webContents types Peek constructs itself (and therefore owns the
 * webPreferences of). We enforce only these. Electron-managed surfaces —
 * `backgroundPage` (extension BG pages/SWs), `remote` (devtools), `offscreen`
 * (offscreen *rendering*, not chrome.offscreen) — set their own prefs and are
 * out of our control, so enforcing on them would false-positive.
 */
export const SANDBOX_ENFORCED_TYPES: ReadonlySet<string> = new Set([
  'window',
  'browserView',
  'webview',
]);

/** True if `url` is covered by a human-approved carve-out. */
export function isSandboxCarvedOut(url: string): boolean {
  if (!url) return false;
  return SANDBOX_CARVEOUTS.some((c) => url.startsWith(c.urlPrefix));
}

/**
 * Pure policy check. Returns a human-readable violation message when a
 * webContents runs unsandboxed without an approved carve-out, otherwise null.
 *
 * `sandbox` is only a violation when EXPLICITLY false — `true` and `undefined`
 * (the Electron default, which is sandboxed) both pass.
 */
export function evaluateSandboxViolation(args: {
  type: string;
  sandbox: boolean | undefined;
  url: string;
}): string | null {
  if (!SANDBOX_ENFORCED_TYPES.has(args.type)) return null;
  if (args.sandbox !== false) return null;
  if (isSandboxCarvedOut(args.url)) return null;
  return (
    `webContents (type=${args.type}, url=${args.url || '<no url yet>'}) was created ` +
    `with sandbox:false and is NOT in SANDBOX_CARVEOUTS. Renderer sandboxing is ` +
    `mandatory in Peek — see main/sandbox-enforcement.ts.`
  );
}

/**
 * The default violation handler: log a critical banner and kill the process
 * IMMEDIATELY. `app.exit`/`process.exit` (not `app.quit`) so there is no
 * graceful teardown a bug could swallow — the app dies loud and now.
 */
export function fatalSandboxViolation(message: string): never {
  const bar = '='.repeat(78);
  const banner =
    `\n${bar}\n` +
    `[SECURITY:FATAL] RENDERER SANDBOX DISABLED — REFUSING TO RUN\n` +
    `${bar}\n` +
    `${message}\n\n` +
    `Renderer sandboxing (sandbox:true) is mandatory. A sandbox:false window is\n` +
    `never allowed to run. If a preload/page seems to need it, fix it to run\n` +
    `sandboxed (sandboxed preloads keep contextBridge + electron ipcRenderer).\n` +
    `A genuine, human-approved exception must be added to SANDBOX_CARVEOUTS in\n` +
    `main/sandbox-enforcement.ts with dietrich's sign-off.\n` +
    `${bar}\n`;
  // Write SYNCHRONOUSLY to fd 2 — process.exit() below does not flush async
  // console buffers, so a plain console.error would be lost and the app would
  // vanish with no diagnostic. fs.writeSync guarantees the reason is on disk.
  try { fs.writeSync(2, banner); } catch { /* never let logging block the kill */ }
  // Hard, immediate, non-graceful. 70 = EX_SOFTWARE.
  process.exit(70);
}

/** Minimal shape of the runtime `getLastWebPreferences` we read (not in typings). */
interface SandboxProbeContents {
  id: number;
  getType(): string;
  getURL(): string;
  once(event: string, listener: (...args: unknown[]) => void): void;
  getLastWebPreferences?: () => { sandbox?: boolean } | null;
}

/**
 * Install the sandbox check on one webContents. Call from the
 * `web-contents-created` chokepoint. `onViolation` defaults to the fatal
 * handler; tests inject a spy so they can assert the decision without dying.
 *
 * Checked synchronously at creation (BrowserWindow prefs are readable there)
 * and once more on the first navigation, as a safety net for surfaces whose
 * `getLastWebPreferences()` returns null until a page loads.
 */
export function enforceSandboxOnWebContents(
  contents: SandboxProbeContents,
  onViolation: (message: string) => void = fatalSandboxViolation,
): void {
  let fired = false;
  const check = (): void => {
    if (fired) return;
    let sandbox: boolean | undefined;
    try {
      const prefs =
        typeof contents.getLastWebPreferences === 'function'
          ? contents.getLastWebPreferences()
          : null;
      if (!prefs) return; // prefs not readable yet; the navigation recheck retries
      sandbox = prefs.sandbox;
    } catch {
      return; // some surfaces reject pref inspection; never let the probe itself throw
    }
    const message = evaluateSandboxViolation({
      type: contents.getType(),
      sandbox,
      url: contents.getURL(),
    });
    if (message) {
      fired = true;
      onViolation(message);
    }
  };

  check();
  contents.once('did-start-navigation', check);
}
