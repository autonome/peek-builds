/**
 * Session projection — the pure half of session SAVE (§5 step 11).
 *
 * `saveSessionSnapshot` used to be one long loop that mixed three jobs: asking
 * the OS/registries for facts, DECIDING what the session is, and writing
 * SQLite. The middle job is the one that has to stop being window-management
 * code living outside the window-state machine, so it moves here as a single
 * pure function: `serializeSession(input) -> SessionSnapshot`. `session.ts` is
 * left with read → project → write.
 *
 * Every window-management fact in the projected snapshot is read off the
 * kernel `State` that arrives as a parameter, except ORDER and FOCUS,
 * which the old machine's `front`/`stackOrder`/`WindowRecord.focusSeq` used to
 * supply and the kernel now does — see `SerializeSessionInput.kernelOrder` /
 * `.topmostContentWindowId`:
 *   - `visible` (the early-skip axis)  → `WindowRecord.visible`
 *   - `bounds`                         → THE restorable-geometry rule
 *                                        (`restorableBoundsFromRecord`, which
 *                                        `window-presenter.ts getRestorableBounds`
 *                                        now delegates to — one implementation,
 *                                        not two)
 *   - pre-maximize rect                → `WindowRecord.maximized` / `.preMaxBounds`
 *                                        (a maximized window is saved at this
 *                                        rect, unmaximized)
 *   - `zOrder`                         → position in `kernelOrder`
 *   - `stackIndex`                     → position in `kernelOrder`
 *   - `focused`                        → `topmostContentWindowId`
 * `zOrder` and `stackIndex` are deliberately the SAME lookup now — the kernel
 * has one order and nothing else orders windows, so there is no second axis
 * for them to diverge over. What genuinely is NOT machine state arrives per
 * window from the caller: the window's URL and title, its saved context row,
 * and the opaque open-params bag.
 *
 * Purity, in the same sense as `display-projection.ts` and
 * `session-save-filter.ts`: no `electron` import, no BrowserWindow/screen, no
 * datastore, no module state, no clock (`createdAt` is a parameter). Outside
 * lookups arrive as injected functions (`getPresentation` / `getContext`),
 * mirroring `ProjectionSources` — that also preserves the original loop's
 * laziness, so a window skipped by the filters costs no DB/fs read, exactly as
 * before.
 *
 * THE CONSTRAINT: the on-disk `SessionSnapshot` shape is frozen. A field
 * rename, a reordered key, or an explicit `undefined` where a key used to be
 * absent silently wipes a user's saved session. `session-projection.test.ts`
 * pins it against a verbatim transcription of the pre-extraction loop and
 * compares the JSON TEXT (which is literally what lands in the
 * `feature_settings` row), not just a deep-equal.
 *
 * This module owns BOTH directions of two pieces of that shape:
 *   - the maximize state older descriptors carry — `serializeSession` no longer
 *     writes it; `readPreMaxBounds` / `unmaximizedRestoreDescriptor` read it
 *     back so such a descriptor restores unmaximized at its pre-maximize rect;
 *   - the saved stacking position — `serializeSession` writes `stackIndex`,
 *     `readStackIndex` + `orderRestoredWindowsBottomToTop` read it back for the
 *     restore path's `STACK_ORDER_IMPORTED`.
 */

import { shouldSkipWindowForSaveEarly } from './session-save-filter.js';
import { savedWindowUrl } from './page-load-error.js';
import type { NavHistorySnapshot } from './nav-history.js';
import type { WindowContext, WindowDescriptor } from './window-registry.js';
import type { State, WindowId, WindowRecord } from './window-kernel.js';

/**
 * The key of the default workspace — the one workspace boot restores and the
 * one whose row keeps the literal legacy names (`snapshot` / `metadata`) in
 * `feature_settings`. Every other workspace is keyed by its own id. Declared
 * here, in the Electron-free half of the session code, so the pure projection,
 * `session.ts`, and the capability-enforcement module
 * (`tile-session-enforcement.ts`) all read the same literal.
 */
export const DEFAULT_WORKSPACE_KEY = 'default';

/**
 * The persisted session. `version`/`createdAt`/`reason`/`windows` and their
 * order are the on-disk contract — see the module header.
 */
export interface SessionSnapshot {
  version: 1;
  createdAt: number;
  reason: 'before-quit' | 'autosave' | 'manual' | 'window-close' | 'window-lifecycle' | 'workspace-switch';
  /**
   * Which workspace this snapshot belongs to — `'default'` for the startup/
   * quit snapshot, or a workspace id for a named workspace's saved-and-closed
   * session (`main/session.ts saveSessionSnapshot`'s `key` option). Entering a
   * workspace and booting the app are the same restore call with a different
   * key; this field is what tells two on-disk snapshots apart.
   */
  workspaceKey: string;
  windows: WindowDescriptor[];
}

/**
 * One entry of the window-manager registry (`main.ts getAllWindows`) joined to
 * its machine id, plus the two facts the machine does not hold: whether the
 * underlying native window is gone, and the raw URL the early-skip filter
 * matches `background.html` against.
 */
export interface SessionSaveWindow {
  /** Electron window id — the key space the registries and context rows use. */
  nativeId: number;
  /** Machine id (`getWindowIdFor`), or null for a window the machine never saw. */
  machineId: WindowId | null;
  /** Registry payload: the opening source address. */
  source: string;
  /** Registry payload: the opaque open-params bag (by reference, as everywhere). */
  params: Record<string, unknown>;
  /** The native window (BrowserWindow, or the hybrid host BaseWindow) is gone/unknown. */
  destroyed: boolean;
  /**
   * The window's raw URL for the early-skip filter: `webContents.getURL()` for
   * a BrowserWindow, the hybrid entry's `url()` for a page-host, `''` when
   * destroyed. NOT the descriptor's URL — that is `presentation.address`.
   */
  url: string;
  /**
   * The window's back/forward trail, or absent when it has none. Read from the
   * per-window cache in `nav-history.ts`, never from a live webContents: a
   * window restored beyond the eager count has not navigated yet and would
   * report no entries at all, so a live read would replace its saved trail with
   * nothing. The pair rides as one field because they only mean anything
   * together — the index indexes the entries.
   */
  navHistory?: NavHistorySnapshot;
}

/**
 * The user-facing self-description of a window (`window-presenter.ts
 * getWindowPresentation`), narrowed to the fields save consumes. `bounds` is
 * used only as the fallback for a window the machine has no record for — the
 * presenter derives it from the same restorable-geometry rule this module
 * applies, so the two can never disagree for a machine-known window.
 */
export interface SessionSavePresentation {
  address: string;
  title: string;
  bounds: Electron.Rectangle;
}

/**
 * A log line the projection decided to emit. The pure function does not own a
 * console; `session.ts` replays these at the level given, preserving the exact
 * message text and interleaving the save path has always logged (the
 * always-on `[session:save] Window …` line is what the 6-window save-set
 * baseline is read off).
 */
export interface SessionSaveNotice {
  /** `debug` = DEBUG-gated `console.log`; `info` = always-on `console.log`; `warn` = `console.warn`. */
  level: 'debug' | 'info' | 'warn';
  message: string;
}

export interface SerializeSessionInput {
  /** The kernel's state — the window-management half of the projection. */
  snapshot: State;
  /** The registry walk, in `getAllWindows()` order. */
  windows: readonly SessionSaveWindow[];
  /** `window-presenter.ts getWindowPresentation` for a native id. */
  getPresentation: (nativeId: number) => SessionSavePresentation | null;
  /** The saved per-window context row (`datastore.ts getContextEntry('mode', id)`). */
  getContext: (nativeId: number) => WindowContext | undefined;
  /** `protocol.ts getRegisteredTileIds()` — stale `peek://ext/<id>` windows are dropped. */
  registeredTileIds: readonly string[];
  reason: SessionSnapshot['reason'];
  /** Injected clock (`Date.now()` at the call site). */
  createdAt: number;
  /** The `_forceForTest` save opt — bypasses the visibility skip. */
  forceForTest?: boolean;
  /**
   * The kernel's single window order (`State.order`), bottom → top, as ids —
   * FILTERED at the call site (`session.ts readKernelOrderFacts`) to the same
   * membership the old `StateSnapshot.stackOrder` carried
   * (`stackingLevel === 'stacked' && visible`, i.e. `isFrontEligibleWindow` in
   * kernel terms), NOT the kernel's raw `State.order` (which is every
   * registered window, including an invisible one or a palette/HUD). This
   * module stays pure and trusts the caller's filter rather than re-deriving
   * it — reproducing it here would need role/class facts this module has no
   * other reason to import.
   * `zOrder` and `stackIndex` are both a position in THIS (already-filtered)
   * list — the kernel has one order and nothing else orders windows, so there
   * is no second order for either field to disagree with.
   */
  kernelOrder: readonly WindowId[];
  /**
   * The kernel's topmost content window (`topmost(state, isContentWindow)`),
   * or null. THE `focused` target — not `keyWindow`: key is nulled the
   * instant the app loses OS focus and a satellite (e.g. the chrome overlay)
   * can hold it, and save runs exactly when the app is losing focus, so a
   * `keyWindow` read here would mark every saved descriptor `focused: false`.
   */
  topmostContentWindowId: WindowId | null;
  /**
   * Which workspace this save is for — see `SessionSnapshot.workspaceKey`.
   * Decides two filters below, both derived from the key alone (no separate
   * flag a caller could get wrong): a NAMED key saves only the windows whose
   * context names that workspace, and never a window pinned across every
   * workspace; the default key saves everything on screen, unfiltered.
   */
  workspaceKey: string;
}

export interface SessionProjection {
  /** Exactly what gets `JSON.stringify`d into the `session/snapshot` row. */
  snapshot: SessionSnapshot;
  /**
   * Descriptor count BEFORE the empty-URL guard. This is what
   * `SessionMetadata.windowCount` has always recorded — deliberately kept
   * distinct from `snapshot.windows.length` so the metadata row does not
   * change meaning under this refactor.
   */
  windowCount: number;
  /** Log lines, in emission order — see `SessionSaveNotice`. */
  notices: SessionSaveNotice[];
}

/**
 * THE restorable-geometry rule (§5 step 7D), expressed over a machine record.
 *
 * `window-presenter.ts getRestorableBounds(machineId)` is the singleton-reading
 * face of this function and delegates to it, so there is exactly one
 * implementation: fullscreen episode → the pre-fullscreen stash
 * (`fsMode.preBounds`); otherwise the machine's `bounds` mirror. Persisting the
 * transient work-area-sized fullscreen rect instead is the aa34cb50
 * fullscreen-lookalike trap.
 *
 * Returns null for an unknown record or one whose mirror was never seeded;
 * callers may then fall back to a live read, annotated as such.
 */
export function restorableBoundsFromRecord(rec: WindowRecord | undefined): Electron.Rectangle | null {
  if (!rec) return null;
  const preFullScreenBounds = rec.fsMode.name === 'normal' ? null : rec.fsMode.preBounds;
  if (preFullScreenBounds) return preFullScreenBounds;
  return rec.bounds ?? null;
}

/**
 * Read a saved descriptor's pre-maximize rect back out of its params bag.
 *
 * The written shape is one nested field, `preMaxBounds`, named exactly as the
 * machine record names it (`WindowRecord.preMaxBounds`). It is present only
 * alongside `maximized: true` and only when a rect was actually stashed.
 *
 * The second branch reads the four flat numbers snapshots carried before that
 * collapse (`preMaxX`/`preMaxY`/`preMaxWidth`/`preMaxHeight`). It exists ONLY
 * to absorb those older snapshots: session save rewrites the whole snapshot row
 * on every autosave, so one save cycle after this shipped every stored snapshot
 * already uses the nested field. Delete the branch once pre-collapse profiles
 * have aged out.
 *
 * Returns null when neither shape is present or complete — "maximized with no
 * restorable rect".
 */
export function readPreMaxBounds(params: Record<string, unknown>): Electron.Rectangle | null {
  const nested = params.preMaxBounds as Partial<Electron.Rectangle> | null | undefined;
  if (
    nested != null && typeof nested === 'object'
    && typeof nested.x === 'number' && typeof nested.y === 'number'
    && typeof nested.width === 'number' && typeof nested.height === 'number'
  ) {
    return { x: nested.x, y: nested.y, width: nested.width, height: nested.height };
  }
  // Pre-collapse snapshots only — see above.
  const x = params.preMaxX, y = params.preMaxY;
  const width = params.preMaxWidth, height = params.preMaxHeight;
  if (
    typeof x === 'number' && typeof y === 'number'
    && typeof width === 'number' && typeof height === 'number'
  ) {
    return { x, y, width, height };
  }
  return null;
}

/**
 * The rect a closed window is saved at for reopen. Maximize is not restored, so
 * a maximized window is saved at its pre-maximize rect when one was stashed;
 * otherwise the presentation's bounds, else the raw bounds captured at close.
 */
export function closedWindowSaveBounds(
  presentation: { bounds: Electron.Rectangle; maximized?: boolean; preMaxBounds?: Electron.Rectangle | null } | null | undefined,
  capturedBounds: Electron.Rectangle | null,
): Electron.Rectangle | null {
  if (presentation?.maximized && presentation.preMaxBounds) return presentation.preMaxBounds;
  return presentation?.bounds ?? capturedBounds;
}

/**
 * A saved descriptor's bounds and params, converted so the window opens
 * unmaximized.
 *
 * Maximize is not restored: a window mapped at full work-area size may be
 * refitted by the window manager, and restoring at the normal size avoids a
 * stale maximized flag. A descriptor from an older build with `maximized: true`
 * therefore opens at its pre-maximize rect (`readPreMaxBounds`) when it has
 * one, else at its saved bounds. The maximize keys (`maximized`, `preMaxBounds`,
 * the flat `preMaxX/Y/Width/Height`) are always dropped so they never reach the
 * window registry. Returns a new object; the input is not mutated.
 */
export function unmaximizedRestoreDescriptor<D extends { bounds: Electron.Rectangle; params: Record<string, unknown> }>(
  descriptor: D,
): D {
  const params = { ...descriptor.params };
  let bounds = descriptor.bounds;
  if (params.maximized === true) {
    const preMax = readPreMaxBounds(params);
    if (preMax) bounds = preMax;
  }
  delete params.maximized;
  delete params.preMaxBounds;
  delete params.preMaxX;
  delete params.preMaxY;
  delete params.preMaxWidth;
  delete params.preMaxHeight;
  return { ...descriptor, bounds, params };
}

/**
 * Read a saved descriptor's stacking position back out.
 *
 * Written by `serializeSession` as `stackIndex` — the window's index in the
 * kernel's bottom→top order at save time. Returns null when the key is
 * absent or not a finite number, which is also what a snapshot written before
 * the field existed produces for every one of its descriptors.
 */
export function readStackIndex(descriptor: WindowDescriptor): number | null {
  const value = (descriptor as { stackIndex?: unknown }).stackIndex;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Where a restored space's windows go and whether the user is taken along.
 *
 * `targets[i]` is the desktop window `i` belongs on: its saved desktop when the
 * layout still lists it, otherwise `activeDesktop` (a window with no saved
 * desktop opens where the user is). `switchTo` is `null` when the active desktop
 * holds any of the windows, otherwise the target of the focused window, else of
 * the first window. With no active desktop known (no layout report yet) nothing
 * can be placed, so every target and `switchTo` are `null`.
 */
export function planDesktopRestore(
  windows: ReadonlyArray<{ desktop?: string; focused?: boolean }>,
  layout: { desktops: ReadonlyArray<{ id: string }> },
  activeDesktop: string | null,
): { targets: Array<string | null>; switchTo: string | null } {
  if (activeDesktop === null) return { targets: windows.map(() => null), switchTo: null };
  const known = new Set(layout.desktops.map((d) => d.id));
  const targets = windows.map((w) => (w.desktop !== undefined && known.has(w.desktop) ? w.desktop : activeDesktop));
  if (targets.length === 0 || targets.includes(activeDesktop)) return { targets, switchTo: null };
  const focusedAt = windows.findIndex((w) => w.focused === true);
  return { targets, switchTo: targets[focusedAt >= 0 ? focusedAt : 0] };
}

/** One restored window, paired with the stacking position its descriptor carried. */
export interface RestoredStackEntry {
  /** The live window id the restore loop got back from the window-open handler. */
  id: number;
  /** `readStackIndex` of the descriptor this window was restored from. */
  stackIndex: number | null;
}

/**
 * The BOTTOM → TOP order session restore hands to `STACK_ORDER_IMPORTED`.
 *
 * `entries` arrive in restore-dispatch order, which is front→back: the saved
 * focused descriptor first, then the rest by focus recency.
 *
 * Windows whose descriptor recorded a stacking position are ordered by it, so
 * the stack comes back exactly as it was on screen — including a window that was
 * shown WITHOUT being focused, which sits above the last-focused window visually
 * but ranks below it by focus recency.
 *
 * A window with no recorded position goes BELOW all recorded ones (keeping its
 * own reverse-dispatch order), so the returned list still names every restored
 * window and the caller's drive count stays the restored count.
 *
 * The all-unrecorded branch is the focus-recency ordering restore used before
 * descriptors carried a stacking position. It exists ONLY to absorb snapshots
 * written before that field shipped: session save rewrites the whole snapshot
 * row on every autosave, so one save cycle after this shipped every stored
 * snapshot already carries positions. Delete the branch once pre-field profiles
 * have aged out.
 */
export function orderRestoredWindowsBottomToTop(entries: readonly RestoredStackEntry[]): number[] {
  const recorded = entries.filter((e) => e.stackIndex !== null);
  if (recorded.length === 0) return [...entries].reverse().map((e) => e.id);
  const unrecorded = entries.filter((e) => e.stackIndex === null);
  const ordered = [...recorded].sort((a, b) => (a.stackIndex as number) - (b.stackIndex as number));
  return [...[...unrecorded].reverse(), ...ordered].map((e) => e.id);
}

/**
 * Mirror a Placement intent into flat primitive fields that survive
 * `sanitizeParams` and the IPC boundary, so the window-open handler can
 * re-derive `Placement` on restore against the current display layout
 * instead of pinning to stale absolute coordinates.
 *
 * Persistence shape (per docs/window-placement.md §"Persistence"):
 *   - placementMode: 'centered' | 'edge' | 'proportional' | 'parent-centered'
 *   - placementEdge: 'top' | 'bottom' | 'left' | 'right'  (mode='edge')
 *   - placementRelX, placementRelY: numbers in [0, 1]    (mode='proportional')
 *
 * Legacy `center: true` / `screenEdge` flags are also written for backward
 * compatibility with snapshots restored by older code; new restores
 * prefer the typed `placementMode` field. `parent-centered` is mirrored as
 * `centered` since `parentId` doesn't survive a restart anyway.
 */
export function mirrorPlacementIntent(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const placement = params.placement as
    | { mode?: string; edge?: string; relX?: number; relY?: number }
    | undefined;
  const out: Record<string, unknown> = { ...params };
  if (!placement?.mode) return out;

  switch (placement.mode) {
    case 'centered':
      out.placementMode = 'centered';
      out.center = true;
      break;
    case 'parent-centered':
      // parentId can't survive restart; degrade to centered.
      out.placementMode = 'centered';
      out.center = true;
      break;
    case 'edge':
      if (typeof placement.edge === 'string') {
        out.placementMode = 'edge';
        out.placementEdge = placement.edge;
        out.screenEdge = placement.edge;
      }
      break;
    case 'proportional':
      out.placementMode = 'proportional';
      if (typeof placement.relX === 'number') out.placementRelX = placement.relX;
      if (typeof placement.relY === 'number') out.placementRelY = placement.relY;
      break;
  }
  return out;
}

/**
 * Sanitize params to only include serializable values.
 * Mirrors the logic in ipc.ts window-list handler.
 *
 * Also strips devtools-open flags (`openDevTools`, `detachedDevTools`) so a
 * window the user happened to have devtools open on at quit time doesn't
 * auto-reopen devtools on restore. Devtools state is intentionally not
 * persisted — it's a transient diagnostic surface.
 */
export function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === 'openDevTools' || key === 'detachedDevTools') continue;
    const type = typeof value;
    if (type === 'string' || type === 'number' || type === 'boolean' || value === null) {
      safe[key] = value;
    } else if (Array.isArray(value)) {
      if (value.every(v => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null)) {
        safe[key] = value;
      }
    }
    // Skip functions, objects, etc. that may not serialize safely
  }
  return safe;
}

/**
 * Project machine state + the per-window payload into the on-disk
 * `SessionSnapshot`. Pure — see the module header.
 *
 * The order of the skip rules, the descriptor field order, the params
 * post-processing and the empty-URL guard are all a verbatim carry-over of the
 * pre-extraction `saveSessionSnapshot` loop; only their INPUTS changed (machine
 * reads instead of OS reads).
 */
/**
 * Add window descriptors to a workspace's saved snapshot, keeping every window
 * it already holds. A keyed descriptor (a tile whose window key allows one
 * window per key) already present with the same url and key is not added
 * again. A keyless window (an ordinary page) is always appended, since two
 * pages at the same address are two windows. With no saved snapshot, the
 * result holds just the additions. Pure: returns a new snapshot, never mutates
 * `existing`.
 */
export function addDescriptorsToSnapshot(
  existing: SessionSnapshot | null,
  additions: readonly WindowDescriptor[],
  workspaceKey: string,
  reason: SessionSnapshot['reason'],
  createdAt: number,
): SessionSnapshot {
  const windows = existing && Array.isArray(existing.windows) ? [...existing.windows] : [];
  const seenKeyed = new Set(windows.filter((d) => d.key).map(descriptorAddress));
  for (const d of additions) {
    if (d.key) {
      if (seenKeyed.has(descriptorAddress(d))) continue;
      seenKeyed.add(descriptorAddress(d));
    }
    windows.push(d);
  }
  return { version: 1, createdAt, reason, workspaceKey, windows };
}

const descriptorAddress = (d: WindowDescriptor) => `${d.url}\u0000${d.key ?? ''}`;

/**
 * Fold one workspace's saved snapshot into another's, as when a space is
 * deleted and its windows move to the default space. The target's windows
 * stay first and keep their focus; each source window is appended (unless the
 * target already holds the same url and window key), unfocused, and made a
 * member of the target space through `targetSpace` — the restore path re-tags
 * a reopened window from its saved `modeMetadata`, so a window left carrying
 * the source's space id would reopen as a member of a space that no longer
 * exists. A workspace pin survives the move. Pure: never mutates its inputs.
 */
export function mergeSnapshotIntoWorkspace(
  target: SessionSnapshot | null,
  source: SessionSnapshot | null,
  targetKey: string,
  targetSpace: Record<string, unknown>,
  createdAt: number,
): SessionSnapshot {
  const moved = (source && Array.isArray(source.windows) ? source.windows : []).map((d): WindowDescriptor => {
    const ctx = d.context;
    const context: WindowContext = {
      mode: 'space',
      modeMetadata: { ...(ctx?.mode === 'space' ? ctx.modeMetadata : {}), ...targetSpace },
      ...(ctx?.pinScope ? { pinScope: ctx.pinScope } : {}),
    };
    return { ...d, focused: false, context };
  });
  // A deleted space's windows collapse into the target's when it already holds the same address.
  const held = new Set((target && Array.isArray(target.windows) ? target.windows : []).map(descriptorAddress));
  const fresh = moved.filter((d) => {
    const address = descriptorAddress(d);
    if (held.has(address)) return false;
    held.add(address);
    return true;
  });
  return addDescriptorsToSnapshot(target, fresh, targetKey, 'workspace-switch', createdAt);
}

export function serializeSession(input: SerializeSessionInput): SessionProjection {
  const notices: SessionSaveNotice[] = [];

  const recordsById = new Map<WindowId, WindowRecord>();
  for (const rec of input.snapshot.order) recordsById.set(rec.id, rec);

  // The kernel's single order, bottom → top, as a lookup. `zOrder` and
  // `stackIndex` both read this same map below — see `SerializeSessionInput
  // .kernelOrder`.
  const kernelOrderIndexById = new Map<WindowId, number>();
  input.kernelOrder.forEach((id, index) => kernelOrderIndexById.set(id, index));

  // (No overlay carve-out on the visibility rule — see
  // `session-save-filter.ts`. The switcher stopped hiding other windows in
  // 9904f113, so `WindowRecord.visible` false always means the window really
  // is hidden, and the `params.overlayHiddenWindows` side channel that used to
  // exempt switcher-hidden windows is retired: §5 step 11 task 6.)
  const windowDescriptors: WindowDescriptor[] = [];

  for (const w of input.windows) {
    const rec = w.machineId != null ? recordsById.get(w.machineId) : undefined;

    // Machine-authoritative visibility (§5 step 11 task 1). NO-RECORD FALLBACK
    // = true (treat as visible → save the window): every id here comes from
    // `getAllWindows()`, itself projected from live machine records, so a
    // missing record means the window retired mid-pass, and dropping a real
    // user window is the unrecoverable direction. The destroyed
    // short-circuit stays: a retired window is skipped regardless of the last
    // mirrored visibility.
    const visible = w.destroyed ? false : (rec ? rec.visible : true);

    if (
      shouldSkipWindowForSaveEarly({
        destroyed: w.destroyed,
        visible,
        url: w.url,
        forceForTest: input.forceForTest,
      })
    ) {
      continue;
    }

    // Skip modal windows
    if (w.params.modal) {
      continue;
    }

    // Skip non-focusable utility windows (e.g. HUD overlays).
    // These are extension-managed and shouldn't be restored by session.
    // User-facing utility windows (settings, diagnostic, etc.) ARE saved.
    if (w.params.role === 'utility' && w.params.focusable === false) {
      continue;
    }

    // Skip feature chrome opened with the explicit `persist: false` option —
    // e.g. the spaces feature's workspace panel and screen border
    // (`features/spaces/background.js` `showPanel()` / `showBorder()`). This
    // is a role-independent, explicit marker (not a URL match) precisely
    // because a role-based rule (like the overlay skip below) can change
    // for reasons that have nothing to do with persistence.
    if (w.params.persist === false) {
      notices.push({ level: 'debug', message: `[session:save] Skipping non-persist window ${w.nativeId}` });
      continue;
    }

    // Skip overlay-role / overlay-flagged windows. Overlays (Windows
    // switcher, find-bar, peek-card, etc.) are transient UI surfaces
    // that should not auto-restore on launch. Restoring an overlay
    // also activates the IZUI coordinator's hide-others behavior, so
    // users see startup with everything marked hidden and the overlay
    // sitting on top — never the intent.
    if (w.params.role === 'overlay' || w.params.overlay === true) {
      notices.push({ level: 'debug', message: `[session:save] Skipping overlay window ${w.nativeId}` });
      continue;
    }

    // Skip signal-role windows: the tiny per-desktop marker left on each
    // visited desktop so space entry can switch there by raising it
    // (`desktop-marker-manager.ts`). It is a desktop
    // anchor, never session content — saved once under the default key
    // (which saves everything on screen), it restored as an ordinary 2x2
    // window on every boot (docs/design/space-desktop-return-plan.md, E5).
    if (w.params.role === 'signal') {
      notices.push({ level: 'debug', message: `[session:save] Skipping signal window ${w.nativeId}` });
      continue;
    }

    // The window presenter owns the canonical user-facing URL/title (the
    // page-host's two-layer URL shape lives there, not here).
    const presentation = input.getPresentation(w.nativeId);
    if (!presentation) {
      notices.push({ level: 'debug', message: `[session:save] No presentation for window ${w.nativeId}, skipping` });
      continue;
    }
    // A window showing the load-error page is saved under the address that
    // failed, so restore reloads it instead of reopening the internal page.
    const realUrl = savedWindowUrl(presentation.address);

    // Geometry is a machine fact (§5 steps 7B/7D). The presentation's rect
    // survives only as the fallback for a window the machine has no record for
    // — which is exactly the fallback the presenter itself applies, so this is
    // the same value either way.
    //
    // Maximize is not restored: a maximized window is saved at the rect it
    // unmaximizes back to (`WindowRecord.preMaxBounds`), falling back to its
    // current bounds when nothing was stashed.
    const currentBounds = restorableBoundsFromRecord(rec) ?? presentation.bounds;
    const windowBounds = rec?.maximized === true ? (rec.preMaxBounds ?? currentBounds) : currentBounds;

    // Skip windows for unknown tiles (stale from renames/removals)
    const extMatch = realUrl.match(/^peek:\/\/ext\/([^/]+)/);
    if (extMatch) {
      const extId = extMatch[1];
      if (!input.registeredTileIds.includes(extId)) {
        notices.push({ level: 'debug', message: `[session:save] Skipping stale tile window ${w.nativeId}: ${extId}` });
        continue;
      }
    }

    notices.push({
      level: 'info',
      message: `[session:save] Window ${w.nativeId} "${presentation.title}" bounds: (${windowBounds.x},${windowBounds.y}) ${windowBounds.width}x${windowBounds.height}${rec?.desktop !== undefined ? ` desktop=${rec.desktop}` : ""} url=${realUrl.substring(0, 80)}`,
    });

    // Capture context state for this window
    const windowContext = input.getContext(w.nativeId);

    // A NAMED workspace's snapshot is scoped to the windows that identify as
    // belonging to it — a window whose saved context row names a DIFFERENT
    // space/group, or none at all (e.g. a baseline window opened before any
    // workspace command ran), is not this workspace's to save. `spaceId` /
    // `groupId` are the two metadata keys `features/spaces/background.js` and
    // `features/groups/home.js` set via `context.setMode('space' | 'group', {
    // metadata })` — the only two callers of a NAMED (non-'default') key
    // today. The `'default'` key stays unfiltered (every ordinary
    // autosave/before-quit/manual save has always captured whatever is on
    // screen, regardless of context) — see the module header.
    //
    // A window pinned across every workspace is likewise never written into a
    // NAMED workspace's row: it is not scoped to that workspace (leaving the
    // workspace does not close it — `features/spaces/background.js
    // closeCurrentWorkspaceWindows()`), and a workspace restore skips such a
    // descriptor anyway (`session.ts restoreSessionSnapshot`). Its home is the
    // default workspace's row, which `session.ts saveSessionSnapshot` keeps
    // current from any save (`docs/design/window-rules.md` "Persistent
    // windows" — "Workspace interaction").
    if (input.workspaceKey !== DEFAULT_WORKSPACE_KEY) {
      if (windowContext?.pinScope === 'global') {
        notices.push({ level: 'debug', message: `[session:save] Excluding cross-workspace pin ${w.nativeId} from workspace "${input.workspaceKey}"` });
        continue;
      }
      const metadata = windowContext?.modeMetadata as Record<string, unknown> | undefined;
      const belongsToWorkspace = metadata?.spaceId === input.workspaceKey || metadata?.groupId === input.workspaceKey;
      if (!belongsToWorkspace) {
        notices.push({ level: 'debug', message: `[session:save] Excluding window ${w.nativeId} not scoped to workspace "${input.workspaceKey}"` });
        continue;
      }
    }

    const sanitized = sanitizeParams(mirrorPlacementIntent(w.params));
    // The pass-through above can carry `maximized` / `preMaxBounds` from a
    // snapshot written by an older build; maximize is not restored, so neither
    // is ever written.
    delete sanitized.maximized;
    delete sanitized.preMaxBounds;
    // A restored window carries its snapshot's params forward, so the flat bag
    // from a pre-collapse snapshot can ride back in through the pass-through.
    // Drop it unconditionally: a newly written snapshot only ever carries the
    // nested field. Delete with the rest of the pre-collapse read support.
    delete sanitized.preMaxX;
    delete sanitized.preMaxY;
    delete sanitized.preMaxWidth;
    delete sanitized.preMaxHeight;

    windowDescriptors.push({
      url: realUrl,
      key: (w.params.key as string) || undefined,
      title: presentation.title,
      bounds: windowBounds,
      source: w.source,
      params: sanitized,
      // Position in the kernel's single order. Unregistered windows rank 0,
      // same as `stackIndex`'s own "no recorded position" answer below — the
      // two fields are deliberately the SAME lookup (see the module header):
      // one order, so nothing here restores a divergence between them.
      zOrder: w.machineId != null ? (kernelOrderIndexById.get(w.machineId) ?? 0) : 0,
      // Where the window actually sat in the kernel's order, bottom → top —
      // the exact same position `zOrder` reads above. Left ABSENT (not null)
      // for a window the kernel has no position for — JSON.stringify drops an
      // undefined value, and restore reads an absent position as "not
      // recorded".
      stackIndex: w.machineId != null ? kernelOrderIndexById.get(w.machineId) : undefined,
      // The desktop the kernel last placed this window on (`WindowRecord.desktop`);
      // the key is omitted when unknown so older readers and the byte shape of
      // desktop-less saves are unchanged.
      ...(rec?.desktop !== undefined ? { desktop: rec.desktop } : {}),
      // The saved-focused descriptor drives restore's head-start:
      // `topmostContentWindowId`, not `keyWindow` — see `SerializeSessionInput
      // .topmostContentWindowId`.
      focused: w.machineId != null && w.machineId === input.topmostContentWindowId,
      context: windowContext,
      // The back/forward trail, written only when there is one. Spread rather
      // than assigned so a window without a trail serializes to exactly the
      // JSON text it always has: `JSON.stringify` drops an undefined value but
      // an explicit `navHistory: undefined` still changes this object's key
      // set, which the on-disk shape sweep in `session-projection.test.ts`
      // compares. Both keys land after `context`, so an existing descriptor's
      // key order is untouched.
      ...(w.navHistory
        ? { navHistory: w.navHistory.navHistory, navHistoryIndex: w.navHistory.navHistoryIndex }
        : {}),
    });
  }

  // Guard: empty-URL filter (belt-and-suspenders).
  // Even when restore is complete, a window may legitimately have an empty URL
  // for a brief moment (e.g., created but not yet navigated). Strip those so
  // they never reach the on-disk snapshot. Log each filtered window so the
  // decision is visible in main.log without re-instrumenting.
  const preFilterCount = windowDescriptors.length;
  const filteredDescriptors = windowDescriptors.filter((d) => {
    const url = d.url;
    if (!url || url.trim() === '' || url === 'about:blank' || url === 'about:newtab') {
      notices.push({
        level: 'warn',
        message: `[session:guard] Filtering window with empty/blank URL from snapshot (reason: ${input.reason})`,
      });
      return false;
    }
    return true;
  });
  if (filteredDescriptors.length < preFilterCount) {
    const dropped = preFilterCount - filteredDescriptors.length;
    notices.push({
      level: 'warn',
      message: `[session:guard] Dropped ${dropped} window(s) with empty/blank URLs from snapshot (reason: ${input.reason})`,
    });
  }

  return {
    snapshot: {
      version: 1,
      createdAt: input.createdAt,
      reason: input.reason,
      workspaceKey: input.workspaceKey,
      windows: filteredDescriptors,
    },
    windowCount: preFilterCount,
    notices,
  };
}
