// Canonical user-facing presentation for any window. Consumers (tile:window:list, session.save,
// the undo-close handler) ask for a WindowPresentation instead of reaching into per-type
// internals; adding a new window type means extending this module, not its consumers.
// Restorable-geometry rule: docs/design/window-manager.md §5 step 7D.
import fs from 'node:fs';
import type { BrowserWindow as BrowserWindowType } from 'electron';
import { getLiveWindow } from './window-registry.js';
import { getWindowInfo } from './main.js';
import { findUrlItem } from './datastore.js';
import { resolveWindowAddress } from './window-address.js';
import { failedUrlFromErrorPage } from './page-load-error.js';
import { urlToHash, getThumbnailPath } from './thumbnails.js';
import { getHybridWindow } from './hybrid-page-host-registry.js';
import type { HybridWindowEntry } from './hybrid-page-host-registry.js';
import { getWindowIdFor, getMachineWindowRecord, getRetiredWindowPresentation } from './window-machine.js';
import { restorableBoundsFromRecord } from './session-projection.js';
import { getKernelExecutor } from './window-kernel-dispatch.js';
import type { WindowId } from './window-kernel.js';

export { resolveWindowAddress };

// THE restorable-geometry rule (§5 step 7D): fullscreen episode → `fsMode.preBounds`, else the
// machine's `bounds` mirror (which IS the maximized rect while maximized). The rule itself lives
// in session-projection.ts restorableBoundsFromRecord, so session-save's pure projection applies
// the identical rule; this is its id-keyed, singleton-reading face. Null when the machine has no
// record for the window, or its mirror was never seeded — callers then fall back to a live read.
export function getRestorableBounds(machineId: WindowId | null): Electron.Rectangle | null {
  if (machineId == null) return null;
  // The kernel's state, not `getMachineWindowRecord`'s old-machine record, is this rule's source.
  const rec = getKernelExecutor().getState().order.find((w) => w.id === machineId);
  return restorableBoundsFromRecord(rec);
}

export interface WindowPresentation {
  id: number;
  // For page-host windows, the inner navigated URL (see window-address.ts), not the
  // peek://app/page/index.html?… shell. For all other windows, webContents.getURL().
  address: string;
  title: string;
  // Favicon URL stored on the matching items-table row, or empty string.
  favicon: string;
  // Thumbnail hash for `peek://thumbnail/<hash>.jpg`, or empty string.
  thumbnail: string;
  // Read via getRestorableBounds above.
  bounds: Electron.Rectangle;
  maximized: boolean;
  // Meaningful only when maximized is true; null otherwise.
  preMaxBounds: Electron.Rectangle | null;
  visible: boolean;
  focused: boolean;
}

export function getWindowPresentation(windowId: number): WindowPresentation | null {
  // Hybrid page-hosts are BaseWindows, invisible to getLiveWindow (BrowserWindow.fromId-backed) —
  // check the hybrid registry first so a hybrid id resolves to its content presentation rather
  // than falling through to a null lookup.
  const hybrid = getHybridWindow(windowId);
  if (hybrid) return getHybridPresentation(hybrid);

  const win = getLiveWindow(windowId);
  if (!win) return null;
  return getLivePresentation(win);
}

function getHybridPresentation(entry: HybridWindowEntry): WindowPresentation {
  // A host showing the load-error page presents the address that failed.
  const hostUrl = entry.url();
  const address = failedUrlFromErrorPage(hostUrl) ?? hostUrl;
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

  // The hybrid registry entry is Electron-id-keyed; the machine record is WindowId-keyed.
  const machineId = getWindowIdFor(entry.windowId);
  const machineRec = machineId != null ? getMachineWindowRecord(machineId) : undefined;
  // Mid-close (ipc.ts captureHybridClose, run off the kernel's own CloseWindow effect), the
  // record is already retired from state.order — getRetiredWindowPresentation supplies the same
  // facts from that effect instead.
  const retiredPresentation = machineRec === undefined && machineId != null ? getRetiredWindowPresentation(machineId) : undefined;
  const presentationFacts = machineRec ?? retiredPresentation;

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
    maximized: presentationFacts?.maximized === true,
    preMaxBounds: presentationFacts?.maximized === true ? presentationFacts.preMaxBounds : null,
    visible,
    focused,
  };
}

function getLivePresentation(win: BrowserWindowType): WindowPresentation | null {
  const info = getWindowInfo(win.id);
  const hostUrl = win.webContents.getURL();

  const address = resolveWindowAddress(hostUrl, info?.params);

  const machineId = getWindowIdFor(win);
  const machineRec = machineId != null ? getMachineWindowRecord(machineId) : undefined;
  const bounds = getRestorableBounds(machineId) ?? win.getBounds();
  const maximized = machineRec?.maximized === true;
  const preMaxBounds: Electron.Rectangle | null = maximized ? (machineRec?.preMaxBounds ?? null) : null;

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
