/**
 * Debug flag — runtime-toggleable verbose logging + devtools state.
 *
 * Two flags, one module:
 *
 *   - `DEBUG`: gates the codebase's many `DEBUG && console.log(...)` lines.
 *     Exported as `let DEBUG` so ESM live-binding semantics carry updates
 *     through to importers without any call-site changes — every read of
 *     `DEBUG` evaluates the current value.
 *
 *   - `_devTools`: whether the Cmd+Alt+I / Ctrl+Shift+I keyboard shortcut
 *     opens devtools on the focused window. Every window is created with
 *     `webPreferences.devTools: true` so the capability is always present;
 *     this flag gates the OPEN action so toggling it takes effect on any
 *     window — including ones already open. Consulted by the
 *     `before-input-event` handler in entry.ts.
 *
 * The module deliberately has no Electron / datastore imports. The caller
 * (boot path in entry.ts / ipc.ts) reads persisted state and calls
 * `initDebugFlags()`; mutations from the IPC handler call `setDebug()` /
 * `setDevTools()`, which fire registered listeners so the IPC layer can
 * broadcast `peek:debug:changed` pubsub and the persistence layer can write
 * to datastore. Keeping all platform integration outside this module makes
 * unit-testing the state machinery trivial and avoids circular deps.
 */

// ─── State ───────────────────────────────────────────────────────────────────

/**
 * Verbose logging flag. Exported as `let` so all importers (including the
 * ~hundreds of `DEBUG && console.log(...)` sites that import it via
 * `config.ts`) see the live value when the binding mutates.
 */
export let DEBUG: boolean = !!process.env.DEBUG;

/** Whether the devtools keyboard shortcut is armed. */
let _devTools: boolean = false;

/** Change listeners — wired by ipc.ts to broadcast + persist on flip. */
export interface DebugFlagsState {
  verbose: boolean;
  devtools: boolean;
}
type ChangeListener = (state: DebugFlagsState) => void;
const _listeners = new Set<ChangeListener>();

// ─── Readers ─────────────────────────────────────────────────────────────────

/** Snapshot of both flags. Use for IPC responses and UI state reads. */
export function getDebugFlags(): DebugFlagsState {
  return { verbose: DEBUG, devtools: _devTools };
}

/** Whether the devtools keyboard shortcut should open devtools when pressed. */
export function isDevToolsEnabled(): boolean {
  return _devTools;
}

// ─── Writers ─────────────────────────────────────────────────────────────────

/**
 * Set the verbose-logging flag. Idempotent: no-op + no notification if the
 * value is unchanged. Listeners fire (synchronously, in registration order)
 * only on a real flip.
 */
export function setDebug(v: boolean): void {
  if (DEBUG === v) return;
  DEBUG = v;
  _notify();
}

/**
 * Set the devtools-shortcut-armed flag. Idempotent. Takes effect immediately
 * on every window — windows are always built with the devTools capability,
 * and this flag only gates whether the keyboard shortcut opens them.
 */
export function setDevTools(v: boolean): void {
  if (_devTools === v) return;
  _devTools = v;
  _notify();
}

// ─── Change subscription ─────────────────────────────────────────────────────

/**
 * Register a listener that fires whenever either flag mutates via
 * `setDebug` / `setDevTools`. Returns an unsubscribe function.
 *
 * Boot-time hydration via `initDebugFlags` does NOT fire listeners — it's
 * a one-shot state seed, not a change.
 */
export function onDebugFlagsChange(fn: ChangeListener): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function _notify(): void {
  const state = getDebugFlags();
  for (const fn of _listeners) {
    try {
      fn(state);
    } catch {
      // Swallow — a listener throwing must not block other listeners or
      // poison the state machinery.
    }
  }
}

// ─── Boot init ───────────────────────────────────────────────────────────────

/**
 * Seed both flags at startup. Called once from the boot path after the
 * caller has read persisted state from the datastore. Does NOT fire
 * listeners — boot hydration is the resumption of prior state, not a change.
 *
 * `verbose` falls back to `!!process.env.DEBUG` when the caller passes
 * `undefined`, so launching with `DEBUG=1 yarn start` still works as a
 * one-shot debug session even if no persisted value exists.
 */
export function initDebugFlags(initial: { verbose?: boolean; devtools?: boolean }): void {
  DEBUG = initial.verbose ?? !!process.env.DEBUG;
  _devTools = initial.devtools ?? false;
}

// ─── Unit-test seam ──────────────────────────────────────────────────────────

/**
 * Reset module state for unit tests. Drops all listeners and resets both
 * flags to their boot defaults. Not used in production code.
 */
export function __resetDebugFlagsForTest(): void {
  DEBUG = false;
  _devTools = false;
  _listeners.clear();
}
