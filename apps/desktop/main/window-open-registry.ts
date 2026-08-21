/**
 * window-open-registry.ts — the id → open-payload map for `source` and
 * `params`: the opening address plus the caller-supplied open options
 * (`role`, `address`, `key`, `keepLive`, …) a window carried at open time.
 *
 * Both facts are APP-LEVEL open-time bookkeeping, read only by the reuse and
 * dedup lookups in `main.ts` (`findWindowByKey`, `findWindowByUrl`,
 * `getChildWindows`, `getWindowInfo`) — never by window BEHAVIOR (visibility,
 * focus, layer, geometry, role). The kernel's `WindowRecord`
 * (`window-kernel.ts`) models behavior and is deliberately app- and
 * backend-neutral (`apps/desktop/CLAUDE.md`, "Electron is ONE backend, not
 * the design"); folding an app concept like an opening source address into it
 * would pull app knowledge into a machine that must stay ignorant of it. So
 * the mapping lives here, outside both the kernel and the (deleted in a later
 * step) `window-state.ts` reducer, whose `WindowRecord.source` /
 * `WindowRecord.params` this module is replacing as the read source for the
 * lookups above.
 *
 * Keyed by `WindowId` (the WM id minted at registration), matching every
 * other machine-record read `main.ts`'s lookups already perform. Entries are
 * written at open time (`setWindowOpenPayload`) and removed at window
 * teardown (`removeWindowOpenPayload`), so a dead window's payload never
 * lingers to be matched by a later reuse/dedup scan.
 */

import type { WindowId } from './window-kernel.js';
import { wmLog } from './window-diag.js';

/** The open-time payload one window carries: its opening source address plus its (opaque, mutable-by-reference) open params. */
export interface WindowOpenPayload {
  source: string;
  params: Record<string, unknown>;
}

const registry = new Map<WindowId, WindowOpenPayload>();

/**
 * Record (or replace) `id`'s open payload. `params` is stored BY REFERENCE —
 * legacy consumers mutate it in place (`params.currentUrl`, `params.x`, …),
 * the same live-object contract the old `WindowRecord.params` field carried.
 */
export function setWindowOpenPayload(id: WindowId, source: string, params: Record<string, unknown>): void {
  registry.set(id, { source, params });
  wmLog('open-registry-set', { id, source, key: typeof params.key === 'string' ? params.key : undefined });
}

/** `id`'s open payload, or undefined for a window that never carried one (tile windows, bridge/background infra). */
export function getWindowOpenPayload(id: WindowId): WindowOpenPayload | undefined {
  return registry.get(id);
}

/** Every live entry, `id` paired with its payload — the full-list read the reuse/dedup scans in `main.ts` need. */
export function listWindowOpenPayloads(): Array<{ id: WindowId } & WindowOpenPayload> {
  return Array.from(registry, ([id, payload]) => ({ id, ...payload }));
}

/** Drop `id`'s entry at window teardown. No-op (and no log) for an id that never carried one. */
export function removeWindowOpenPayload(id: WindowId): void {
  const entry = registry.get(id);
  if (!entry) return;
  registry.delete(id);
  wmLog('open-registry-remove', { id, key: typeof entry.params.key === 'string' ? entry.params.key : undefined });
}
