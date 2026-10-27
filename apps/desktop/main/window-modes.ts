/**
 * Window modes: builtin packages (`"type": "window-mode"` in a feature
 * manifest, found the way themes are) that change how every window looks and
 * sizes at once. One mode is active at a time.
 *
 * A mode asks for three things: that windows fill the screen (maximize-all),
 * what frame windows draw (`chrome`), and whether cards are translucent
 * (`transparency`). The first two are applied here; the third is the reason a
 * mode and the app-wide see-through look exclude each other.
 */

import fs from 'node:fs';
import path from 'node:path';
import { screen } from 'electron';
import { getDb } from './datastore.js';
import {
  parseWindowModeManifest,
  planWindowModeChange,
  type WindowModePackage,
} from './window-mode-plan.js';

export { parseWindowModeManifest, planWindowModeChange };
export type { WindowModeAsks, WindowModePackage, WindowModeChangeInput, WindowModeChangePlan } from './window-mode-plan.js';
import { publish } from './pubsub.js';
import { getTopmostContentWindowId, getNativeWindowFor } from './window-machine.js';
import {
  kernelEnterMaximizeAll,
  kernelLeaveMaximizeAll,
  kernelMaximizeAllMode,
  kernelSetEligibleChrome,
} from './window-kernel-dispatch.js';

const registry = new Map<string, WindowModePackage>();

export function registerWindowMode(pkg: WindowModePackage): void {
  registry.set(pkg.id, pkg);
}

export function getWindowModePackage(id: string): WindowModePackage | null {
  return registry.get(id) ?? null;
}

export function getWindowModePackages(): WindowModePackage[] {
  return [...registry.values()];
}

/** Scan a features directory for manifests with `"type": "window-mode"`. */
export function discoverBuiltinWindowModes(featuresDir: string): void {
  if (!fs.existsSync(featuresDir)) return;
  for (const entry of fs.readdirSync(featuresDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(featuresDir, entry.name);
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const pkg = parseWindowModeManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')), dir, entry.name);
      if (pkg) registerWindowMode(pkg);
    } catch (err) {
      console.error('Failed to load window-mode manifest:', entry.name, err);
    }
  }
}

// ── state ────────────────────────────────────────────────────────────

const CORE_FEATURE_ID = 'core';
const MODE_KEY = 'windowMode';
const ENTERED_MAXIMIZE_KEY = 'windowModeEnteredMaximizeAll';

function readCore(key: string): unknown {
  try {
    const row = getDb().prepare(
      'SELECT value FROM feature_settings WHERE featureId = ? AND key = ?'
    ).get(CORE_FEATURE_ID, key) as { value: string } | undefined;
    return row?.value ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
}

function writeCore(key: string, value: unknown): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
    VALUES (?, ?, ?, ?, ?)
  `).run(`${CORE_FEATURE_ID}_${key}`, CORE_FEATURE_ID, key, JSON.stringify(value), Date.now());
}

/** The active mode's id, or null. */
export function getWindowMode(): string | null {
  const v = readCore(MODE_KEY);
  return typeof v === 'string' && registry.has(v) ? v : null;
}

function windowModeEnteredMaximizeAll(): boolean {
  return readCore(ENTERED_MAXIMIZE_KEY) === true;
}

// ── change planning (pure) ───────────────────────────────────────────

// ── applying ─────────────────────────────────────────────────────────

/**
 * Enter maximize-all over the work area of the display the front window is on.
 * Shared by the maximize-all command and the window modes, so there is one
 * maximizer.
 */
export function enterMaximizeAllHere(): void {
  const front = getTopmostContentWindowId();
  const frontWin = front != null ? getNativeWindowFor(front) : null;
  const display = frontWin ? screen.getDisplayMatching(frontWin.getBounds()) : screen.getPrimaryDisplay();
  const { x, y, width, height } = display.workArea;
  kernelEnterMaximizeAll({ x, y, width, height });
}

export interface WindowModeDeps {
  seeThroughEverywhereOn(): boolean;
  /** Turn the app-wide see-through look off across every open window. */
  turnSeeThroughOff(): void;
}

/** Make `id` the active mode (null leaves the current one). Returns the new active id. */
export function setWindowMode(id: string | null, deps: WindowModeDeps): { success: true; mode: string | null } | { success: false; error: string } {
  const to = id === null ? null : getWindowModePackage(id);
  if (id !== null && to === null) return { success: false, error: `Unknown window mode: ${id}` };
  const currentId = getWindowMode();
  const from = currentId === null ? null : getWindowModePackage(currentId);

  const plan = planWindowModeChange({
    from,
    to,
    maximizeAllOn: kernelMaximizeAllMode() !== null,
    fromEnteredMaximizeAll: windowModeEnteredMaximizeAll(),
    seeThroughEverywhereOn: deps.seeThroughEverywhereOn(),
  });

  writeCore(MODE_KEY, to?.id ?? null);
  writeCore(ENTERED_MAXIMIZE_KEY, plan.enteredMaximizeAll);
  if (plan.seeThroughOff) deps.turnSeeThroughOff();
  if (plan.leaveMaximizeAll) kernelLeaveMaximizeAll();
  if (plan.enterMaximizeAll) enterMaximizeAllHere();
  kernelSetEligibleChrome(plan.chrome);

  publish('peek://app/background', 'window:mode', {
    mode: to?.id ?? null,
    bodyClass: to?.bodyClass ?? null,
    css: to?.css ? path.join(to.dir, to.css) : null,
  });
  return { success: true, mode: to?.id ?? null };
}

/**
 * After a restart: the frame comes back from the saved mode, and maximize-all
 * is re-entered if the saved mode wants it and the session did not restore it.
 */
export function restoreWindowMode(): void {
  const id = getWindowMode();
  const pkg = id === null ? null : getWindowModePackage(id);
  if (!pkg) return;
  kernelSetEligibleChrome(pkg.asks.chrome);
  if (pkg.asks.maximize && kernelMaximizeAllMode() === null) {
    enterMaximizeAllHere();
    writeCore(ENTERED_MAXIMIZE_KEY, true);
  }
}
