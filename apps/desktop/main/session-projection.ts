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
 *   - `maximized` / pre-maximize rect  → `WindowRecord.maximized` / `.preMaxBounds`
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
 *   - the maximize state a descriptor carries — `serializeSession` writes it,
 *     `readPreMaxBounds` reads it back for the window-open path;
 *   - the saved stacking position — `serializeSession` writes `stackIndex`,
 *     `readStackIndex` + `orderRestoredWindowsBottomToTop` read it back for the
 *     restore path's `STACK_ORDER_IMPORTED`.
 */

import { shouldSkipWindowForSaveEarly } from './session-save-filter.js';
import type { WindowContext, WindowDescriptor } from './window-registry.js';
import type { State, WindowId, WindowRecord } from './window-kernel.js';

/**
 * The persisted session. `version`/`createdAt`/`reason`/`windows` and their
 * order are the on-disk contract — see the module header.
 */
export interface SessionSnapshot {
  version: 1;
  createdAt: number;
  reason: 'before-quit' | 'autosave' | 'manual' | 'window-close' | 'window-lifecycle';
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
 * restorable rect", which the reducer accepts as a `MAXIMIZE_RESTORED` seed.
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

    // The window presenter owns the canonical user-facing URL/title (the
    // page-host's two-layer URL shape lives there, not here).
    const presentation = input.getPresentation(w.nativeId);
    if (!presentation) {
      notices.push({ level: 'debug', message: `[session:save] No presentation for window ${w.nativeId}, skipping` });
      continue;
    }
    const realUrl = presentation.address;

    // Geometry + maximize are machine facts (§5 steps 7B/7C/7D). The
    // presentation's rect survives only as the fallback for a window the
    // machine has no record for — which is exactly the fallback the presenter
    // itself applies, so this is the same value either way.
    const windowBounds = restorableBoundsFromRecord(rec) ?? presentation.bounds;
    const canvasMaximized = rec?.maximized === true;
    const preMaxBounds = canvasMaximized ? (rec?.preMaxBounds ?? null) : null;

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
      message: `[session:save] Window ${w.nativeId} "${presentation.title}" bounds: (${windowBounds.x},${windowBounds.y}) ${windowBounds.width}x${windowBounds.height}${canvasMaximized ? " [maximized]" : ""} url=${realUrl.substring(0, 80)}`,
    });

    // Capture context state for this window
    const windowContext = input.getContext(w.nativeId);

    const sanitized = sanitizeParams(mirrorPlacementIntent(w.params));
    // The pass-through above can carry a STALE `params.maximized` for a
    // hybrid window: it's set once at open time (true only when opened via
    // reopen/session-restore of a maximized window) and never updated by
    // page:maximize/page:unmaximize afterward (those update the hybrid
    // registry, not the general window-registry params). The machine record
    // is always live, so it — not the pass-through — is authoritative here;
    // explicitly set both branches rather than only adding the true case.
    if (canvasMaximized) {
      sanitized.maximized = true;
      // The pre-maximize rect the window unmaximizes back to, written as ONE
      // nested field named as the machine record names it (§5 step 11 task 5 —
      // it used to be four flat numbers, preMaxX/Y/Width/Height). Restore
      // threads it back through the window-open path (`readPreMaxBounds`) to
      // seed the machine, so an unmaximize after restore lands at the original
      // pre-maximize size instead of the maximized work-area rect. Set AFTER
      // `sanitizeParams`, which drops objects.
      if (preMaxBounds) {
        sanitized.preMaxBounds = {
          x: preMaxBounds.x,
          y: preMaxBounds.y,
          width: preMaxBounds.width,
          height: preMaxBounds.height,
        };
      } else {
        delete sanitized.preMaxBounds;
      }
    } else {
      delete sanitized.maximized;
      delete sanitized.preMaxBounds;
    }
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
      // The saved-focused descriptor drives restore's head-start:
      // `topmostContentWindowId`, not `keyWindow` — see `SerializeSessionInput
      // .topmostContentWindowId`.
      focused: w.machineId != null && w.machineId === input.topmostContentWindowId,
      context: windowContext,
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
      windows: filteredDescriptors,
    },
    windowCount: preFilterCount,
    notices,
  };
}

// ============================================================================
// Space-workspace projection (§5 step 11 task 9)
//
// `saveSpaceWorkspaces` is a SECOND, entirely separate save path from the
// session snapshot above — it writes one `workspace:<spaceId>` row per space,
// read by `features/spaces/background.js` (openSpace) and
// `features/groups/home.js` (layout sort) via `api.settings.get`. It had its
// own copy of the same four defects `serializeSession` already fixed for the
// main snapshot: an OS-only liveness guard that drops every hybrid page-host
// (`getLiveWindow` is null for a BaseWindow — since the canvas removal that is
// EVERY web page window), a fabricated z-order, a live `win.isFocused()` read,
// and a presenter-sourced rect instead of the restorable-geometry rule. Same
// fix, same shape: a pure projection over the kernel `State` plus the
// same hybrid-aware read-phase rows `serializeSession` consumes.
// ============================================================================

/**
 * One window entry inside a per-space workspace snapshot. On-disk contract —
 * see the module header. Unchanged by this projection: only where each VALUE
 * comes from changed (machine reads now, not a second OS read).
 */
export interface SpaceWorkspaceWindowEntry {
  url: string;
  bounds: Electron.Rectangle;
  /**
   * TRUE STACK POSITION — the window's index in the kernel's single order
   * (bottom → top), the exact source `serializeSession` reads for
   * `stackIndex` above. Deliberately not focus recency: `features/groups
   * /home.js` sorts its layout on this field, and stack position — not
   * "which window was used most recently" — is what a layout sort means by
   * z-order. 0 for a window the kernel has no position for, mirroring the
   * pre-projection `zOrderMap.get(id) ?? 0` default (this field, unlike
   * `stackIndex`, has always been a required number in the row, never
   * absent).
   */
  zOrder: number;
  focused: boolean;
}

/** The persisted per-space snapshot — on-disk contract, see the module header. */
export interface SpaceWorkspaceSnapshot {
  version: 1;
  spaceId: string;
  spaceName: string;
  createdAt: number;
  windows: SpaceWorkspaceWindowEntry[];
}

export interface SerializeSpaceWorkspacesInput {
  /** The kernel's state — same snapshot `serializeSession` reads. */
  snapshot: State;
  /**
   * Same read-phase rows `serializeSession` consumes (`session.ts
   * buildSessionSaveWindows`) — `destroyed`/`url` already resolved the hybrid
   * fallback, so a hybrid page-host reaches this projection the same way it
   * reaches `serializeSession`, with no second `getLiveWindow`-only guard to
   * drop it.
   */
  windows: readonly SessionSaveWindow[];
  /** `window-presenter.ts getWindowPresentation` for a native id. */
  getPresentation: (nativeId: number) => SessionSavePresentation | null;
  /** The saved per-window context row (`datastore.ts getContextEntry('mode', id)`). */
  getContext: (nativeId: number) => WindowContext | undefined;
  /** Injected clock (`Date.now()` at the call site) — one stamp for the whole call. */
  createdAt: number;
  /** Same kernel order `serializeSession` reads — see `SerializeSessionInput.kernelOrder`. */
  kernelOrder: readonly WindowId[];
  /** Same topmost-content-window fact `serializeSession` reads — see `SerializeSessionInput.topmostContentWindowId`. */
  topmostContentWindowId: WindowId | null;
}

/**
 * Project machine state into per-space workspace snapshots. Pure — see the
 * module header. Groups every SPACE-mode window (per its saved context row)
 * by `spaceId`, a verbatim carry-over of the pre-extraction loop's grouping;
 * only the per-window FACTS changed source:
 *   - liveness   → `w.destroyed` (hybrid-aware, from the shared read phase),
 *                  not a `getLiveWindow`-only guard
 *   - `visible`  → `WindowRecord.visible`, same NO-RECORD FALLBACK = true rule
 *                  as `serializeSession`, not a second OS read
 *   - `bounds`   → `restorableBoundsFromRecord`, not the live presenter rect
 *   - `zOrder`   → TRUE STACK POSITION (position in `kernelOrder`), not a
 *                  `getAllLiveWindows()` enumeration approximation
 *   - `focused`  → `topmostContentWindowId`, not `win.isFocused()`
 */
export function serializeSpaceWorkspaces(input: SerializeSpaceWorkspacesInput): Map<string, SpaceWorkspaceSnapshot> {
  const recordsById = new Map<WindowId, WindowRecord>();
  for (const rec of input.snapshot.order) recordsById.set(rec.id, rec);

  // Same kernel-order lookup `serializeSession` builds for `stackIndex`/`zOrder`.
  const kernelOrderIndexById = new Map<WindowId, number>();
  input.kernelOrder.forEach((id, index) => kernelOrderIndexById.set(id, index));

  const spaceWindows = new Map<string, { spaceName: string; windows: SpaceWorkspaceWindowEntry[] }>();

  for (const w of input.windows) {
    // No live BrowserWindow AND no hybrid entry — nothing to save (mirrors
    // the destroyed branch of the shared read phase).
    if (w.destroyed) continue;

    const rec = w.machineId != null ? recordsById.get(w.machineId) : undefined;
    // Machine-authoritative visibility (same rule as `serializeSession`): no
    // record means the window retired mid-pass, and erring toward saving is
    // the safe direction.
    const visible = rec ? rec.visible : true;
    if (!visible) continue;

    // The background page is never in space mode, but skip it the same way
    // the main snapshot does — cheap and matches the pre-extraction loop.
    if (w.url.includes('peek://app/background.html')) continue;

    const context = input.getContext(w.nativeId);
    if (!context || context.mode !== 'space') continue;

    const metadata = context.modeMetadata as Record<string, unknown> | null;
    const spaceId = metadata?.spaceId as string | undefined;
    const spaceName = metadata?.spaceName as string | undefined;
    if (!spaceId) continue;

    // The window presenter owns the canonical user-facing URL (the
    // page-host's two-layer URL shape lives there, not here) — same call
    // `serializeSession` makes, and it already resolves a hybrid id.
    const presentation = input.getPresentation(w.nativeId);
    if (!presentation) continue;

    if (!spaceWindows.has(spaceId)) {
      spaceWindows.set(spaceId, { spaceName: spaceName || '', windows: [] });
    }
    spaceWindows.get(spaceId)!.windows.push({
      url: presentation.address,
      bounds: restorableBoundsFromRecord(rec) ?? presentation.bounds,
      zOrder: w.machineId != null ? (kernelOrderIndexById.get(w.machineId) ?? 0) : 0,
      focused: w.machineId != null && w.machineId === input.topmostContentWindowId,
    });
  }

  const result = new Map<string, SpaceWorkspaceSnapshot>();
  for (const [spaceId, space] of spaceWindows) {
    result.set(spaceId, {
      version: 1,
      spaceId,
      spaceName: space.spaceName,
      createdAt: input.createdAt,
      windows: space.windows,
    });
  }
  return result;
}
