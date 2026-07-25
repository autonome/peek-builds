/**
 * Window presenter — canonical user-facing self-description for any window.
 *
 * Consumers (tile:window:list, session.save, undo-close handler, future
 * features) ask for a `WindowPresentation` and never reach into per-type
 * internals — no parsing the page-host's shell URL, no peeking at
 * info.params.currentUrl or .x/.y, no extractRealUrl. That window-type
 * knowledge lives here, in one place.
 *
 * Adding a new window type means extending this module — no edits to
 * any consumer.
 *
 * See peek MCP task `e4ae700e` for design rationale and the catalogue of
 * bugs that motivated this consolidation.
 */

import fs from 'node:fs';
import type { BrowserWindow as BrowserWindowType } from 'electron';
import { getLiveWindow } from './window-registry.js';
import { getWindowInfo } from './main.js';
import { findUrlItem } from './datastore.js';
import { resolveWindowAddress } from './window-address.js';
import { urlToHash, getThumbnailPath } from './thumbnails.js';
import { getHybridWindow } from './hybrid-page-host-registry.js';
import type { HybridWindowEntry } from './hybrid-page-host-registry.js';
import { getWindowIdFor, getMachineWindowRecord } from './window-state-singleton.js';
import { restorableBoundsFromRecord } from './session-projection.js';
import type { WindowId } from './window-state.js';

export { resolveWindowAddress };

/**
 * THE restorable-geometry rule (§5 step 7D) — the ONE answer to "what rect
 * should a consumer persist or restore for this window?". Every read-model
 * consumer (presentation `bounds` → tile:window:list, session-save, the
 * close-capture that feeds undo-close) goes through here; none re-derive it.
 *
 * The rule, in precedence order, all from machine state (never a live
 * Electron query):
 *   1. Fullscreen episode (`fsMode` non-normal): the pre-fullscreen stash
 *      `fsMode.preBounds` — set at enter-initiation, cleared on the settled
 *      leave, so mid-animation reads are covered. Persisting the transient
 *      work-area-sized fullscreen rect instead makes the next boot restore a
 *      plain window at work-area size — a fullscreen LOOKALIKE, visually
 *      indistinguishable from real fullscreen, that breaks the Esc /
 *      fullscreen-toggle interactions after restart (the aa34cb50 trap).
 *   2. Otherwise: the machine's `bounds` mirror (registration-seeded,
 *      BOUNDS_CHANGED-maintained). When the window is maximized this IS the
 *      maximized rect — deliberately: the session format persists it as
 *      `bounds` alongside `maximized` + `preMaxX/Y/Width/Height`, and
 *      restore/reopen rebuild the window AT that rect and re-seed the machine
 *      via MAXIMIZE_RESTORED (§5 step 7C).
 *
 * Returns null when the machine has no record for the window (unregistered —
 * shouldn't exist, the registration tripwire hunts those) or its mirror was
 * never seeded; callers may then fall back to a live read, annotated as such.
 *
 * The rule ITSELF lives in `session-projection.ts restorableBoundsFromRecord`
 * (a record → rect function with no singleton reads), because session save's
 * pure projection has to apply the same rule and a second copy of it is exactly
 * the kind of drift the ONE-rule framing exists to prevent. This function is
 * its id-keyed, singleton-reading face.
 */
export function getRestorableBounds(machineId: WindowId | null): Electron.Rectangle | null {
  if (machineId == null) return null;
  return restorableBoundsFromRecord(getMachineWindowRecord(machineId));
}

export interface WindowPresentation {
  id: number;
  /**
   * The user-facing URL. For page-host windows this resolves to the inner
   * navigated URL (info.params.currentUrl, falling back to the bootstrap
   * `url` search param), NOT the `peek://app/page/index.html?…` shell.
   * For all other windows this is webContents.getURL().
   */
  address: string;
  title: string;
  /** Favicon URL stored on the matching items-table row, or empty string. */
  favicon: string;
  /** Thumbnail hash for `peek://thumbnail/<hash>.jpg`, or empty string. */
  thumbnail: string;
  /**
   * The restorable rect — always the rect a consumer would want to display
   * or persist, read from the window-state machine via the ONE
   * restorable-geometry rule (`getRestorableBounds`): fullscreen →
   * `fsMode.preBounds`; else the machine's bounds mirror (which IS the
   * maximized rect while maximized, persisted alongside `maximized` +
   * `preMaxBounds`). Live Electron reads survive only as the fallback for
   * a window the machine never saw.
   */
  bounds: Electron.Rectangle;
  /** True when the machine record says the window is maximized (§5 step 7B/7C). */
  maximized: boolean;
  /** Pre-maximize bounds for unmaximize, or null if not maximized. */
  preMaxBounds: Electron.Rectangle | null;
  visible: boolean;
  focused: boolean;
}

/**
 * Return the canonical presentation for a window, or null if the window
 * doesn't exist or has been destroyed. Geometry/maximize state is read from
 * the window-state machine (§5 step 7D — `getRestorableBounds` + the record's
 * `maximized`/`preMaxBounds`); identity/params come from the machine's
 * registry payload via `getWindowInfo` (or the hybrid registry for
 * page-hosts); title/visibility/focus stay live reads.
 */
export function getWindowPresentation(windowId: number): WindowPresentation | null {
  // Hybrid page-hosts are BaseWindows, invisible to `getLiveWindow`
  // (BrowserWindow.fromId-backed). Check the hybrid registry FIRST so a
  // hybrid id resolves to its content-webContents presentation rather than
  // falling through to a null lookup. No-op when the flag is off: the
  // registry is empty, so `getHybridWindow` returns null and we fall
  // through to the BrowserWindow path exactly as before.
  const hybrid = getHybridWindow(windowId);
  if (hybrid) return getHybridPresentation(hybrid);

  const win = getLiveWindow(windowId);
  if (!win) return null;
  return getLivePresentation(win);
}

/**
 * Build a presentation for a hybrid page-host window. A hybrid window is a
 * `BaseWindow` hosting a single `WebContentsView`; its user-facing address,
 * title, visibility and focus are read live off that content webContents /
 * host BaseWindow (via the registry entry). Favicon/thumbnail resolution
 * mirrors the Live and Pending paths byte-for-byte so a hybrid window is
 * indistinguishable from a canvas page in the windows feature.
 *
 * Maximize/preMaxBounds are read off the window-state machine record (§5
 * step 7B — window-state.ts WindowRecord), written only by the reducer's
 * maximize transitions, driven by the page:maximize/page:unmaximize
 * dispatches in ipc.ts and by reopen/session-restore's MAXIMIZE_RESTORED
 * seed for a window that was maximized when it was closed or saved. Unlike
 * the old canvas path — where bounds had to be reconstructed from
 * FSM-published webview-rect params because the visible content area was
 * smaller than the outer window — a hybrid window's outer BaseWindow bounds
 * ARE the visible content rect (no surrounding chrome lives in this
 * window), so `bounds` below is the machine's bounds mirror (falling back
 * to the live baseWin.getBounds() read), maximized or not.
 */
function getHybridPresentation(entry: HybridWindowEntry): WindowPresentation {
  const address = entry.url();
  let bounds: Electron.Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  let visible = true;
  let focused = false;
  try {
    if (!entry.baseWin.isDestroyed()) {
      bounds = entry.baseWin.getBounds();
      visible = entry.baseWin.isVisible();
      focused = entry.baseWin.isFocused();
    }
  } catch {
    // best-effort — a destroyed/odd BaseWindow still presents with defaults
  }

  // The hybrid registry entry is Electron-id-keyed; the machine record is
  // WindowId-keyed — convert through the sanctioned mapping.
  const machineId = getWindowIdFor(entry.windowId);
  const machineRec = machineId != null ? getMachineWindowRecord(machineId) : undefined;

  // Machine-owned geometry (§5 steps 7B+7D): the ONE restorable-geometry rule
  // (fullscreen → fsMode.preBounds; else the machine's bounds mirror — see
  // getRestorableBounds above). The live read above stays only as the
  // fallback for a window the machine never saw.
  const restorableBounds = getRestorableBounds(machineId);
  if (restorableBounds) {
    bounds = restorableBounds;
  }

  let favicon = '';
  let thumbnail = '';
  if (address.startsWith('http://') || address.startsWith('https://')) {
    try {
      const item = findUrlItem(address) as { favicon?: string; thumbnail?: string } | null;
      if (item) {
        favicon = item.favicon || '';
        thumbnail = item.thumbnail || '';
      }
    } catch {
      // best-effort — store lookup failures shouldn't break window listings
    }
    if (!favicon) {
      try {
        const host = new URL(address).hostname;
        if (host) favicon = `https://www.google.com/s2/favicons?domain=${host}&sz=32`;
      } catch {
        // unparseable address — leave favicon empty
      }
    }
  } else if (address.startsWith('peek://')) {
    try {
      const hash = urlToHash(address);
      if (fs.existsSync(getThumbnailPath(hash))) {
        thumbnail = hash;
      }
    } catch {
      // best-effort
    }
  }

  return {
    id: entry.windowId,
    address,
    title: entry.title(),
    favicon,
    thumbnail,
    bounds,
    maximized: machineRec?.maximized === true,
    preMaxBounds: machineRec?.maximized === true ? machineRec.preMaxBounds : null,
    visible,
    focused,
  };
}

function getLivePresentation(win: BrowserWindowType): WindowPresentation | null {
  const info = getWindowInfo(win.id);
  const hostUrl = win.webContents.getURL();

  const address = resolveWindowAddress(hostUrl, info?.params);

  // Machine-owned geometry (§5 step 7D): the ONE restorable-geometry rule
  // (fullscreen → fsMode.preBounds; else the machine's bounds mirror — see
  // getRestorableBounds above). The live getBounds() survives only as the
  // annotated fallback for a window the machine never saw (unregistered —
  // the registration tripwire hunts those).
  const machineId = getWindowIdFor(win);
  const machineRec = machineId != null ? getMachineWindowRecord(machineId) : undefined;
  const bounds = getRestorableBounds(machineId) ?? win.getBounds();

  // Maximize is a reducer fact (§5 step 7C): generic BrowserWindows maximize
  // through tile:window:maximize → MAXIMIZE_REQUESTED, so the machine record
  // is the one holder — surfacing it here is what lets tile:window:list and
  // session-save finally see a maximized generic window (the canvas-era
  // hardcoded `false` predates the machine).
  const maximized = machineRec?.maximized === true;
  const preMaxBounds: Electron.Rectangle | null = maximized ? (machineRec?.preMaxBounds ?? null) : null;

  // Favicon + thumbnail. The presenter is the one place that knows the
  // resolution policy — renderers receive a URL string they can drop into
  // an <img src>, with no fallback chain of their own.
  //
  // Favicon priority: stored item.favicon → Google s2 service.
  // (When peek://favicon/<hash> local-cache lands per task 7927ab71, it
  // becomes a third layer here without touching any consumer.)
  //
  // Thumbnail priority:
  //   http(s): stored item.thumbnail (no third-party screenshot service).
  //   peek://: computed hash, if the captured JPEG exists on disk. The
  //            capture is wired in ipc.ts on did-stop-loading; the file
  //            name is deterministic so we don't need an item record.
  let favicon = '';
  let thumbnail = '';
  if (address.startsWith('http://') || address.startsWith('https://')) {
    try {
      const item = findUrlItem(address) as { favicon?: string; thumbnail?: string } | null;
      if (item) {
        favicon = item.favicon || '';
        thumbnail = item.thumbnail || '';
      }
    } catch {
      // best-effort — store lookup failures shouldn't break window listings
    }
    if (!favicon) {
      try {
        const host = new URL(address).hostname;
        if (host) favicon = `https://www.google.com/s2/favicons?domain=${host}&sz=32`;
      } catch {
        // unparseable address — leave favicon empty
      }
    }
  } else if (address.startsWith('peek://')) {
    try {
      const hash = urlToHash(address);
      if (fs.existsSync(getThumbnailPath(hash))) {
        thumbnail = hash;
      }
    } catch {
      // best-effort — thumbnail lookup failures shouldn't break listings
    }
  }

  return {
    id: win.id,
    address,
    title: win.getTitle(),
    favicon,
    thumbnail,
    bounds,
    maximized,
    preMaxBounds,
    visible: win.isVisible(),
    focused: win.isFocused(),
  };
}
