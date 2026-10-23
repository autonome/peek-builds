// The id -> open-payload map for a window's opening source address and caller-supplied open
// options (role, address, key, keepLive, ...). App-level bookkeeping, read only by the reuse
// and dedup lookups in main.ts — kept out of the kernel's WindowRecord, which models behavior.
import type { WindowId } from './window-kernel.js';
import { wmLog } from './window-diag.js';

export interface WindowOpenPayload {
  source: string;
  params: Record<string, unknown>;
}

const registry = new Map<WindowId, WindowOpenPayload>();

// The tile that opened each window (hybrid page hosts included), kept beside the payload. Set from
// an explicit declaration (a tile's own window) or derived from the opening source address.
const openerTiles = new Map<WindowId, string>();

// `peek://editor/home.html?x=1` -> `editor`; null for anything that is not a peek:// address.
export function tileIdFromSource(source: unknown): string | null {
  if (typeof source !== 'string') return null;
  const m = /^peek:\/\/([^/?#]+)/i.exec(source);
  return m ? m[1] : null;
}

export function setWindowOpenerTile(id: WindowId, tileId: string): void {
  openerTiles.set(id, tileId);
}

export function getWindowOpenerTile(id: WindowId): string | null {
  return openerTiles.get(id) ?? null;
}

// Ids of every window attributed to `tileId`. Includes windows that may have closed since; the
// caller decides liveness.
export function listWindowsOpenedByTile(tileId: string): WindowId[] {
  const out: WindowId[] = [];
  for (const [id, opener] of openerTiles) if (opener === tileId) out.push(id);
  return out;
}

// Read-only: does `tileId` own at least one live keepLive window? Liveness and the keepLive flag
// belong to the window kernel's record, so the caller supplies that check.
export function tileOwnsLiveKeepLiveWindow(
  tileId: string,
  isLiveKeepLive: (id: WindowId) => boolean,
): boolean {
  return listWindowsOpenedByTile(tileId).some(isLiveKeepLive);
}

// params is stored by reference — legacy consumers mutate it in place (params.currentUrl, params.x, ...).
export function setWindowOpenPayload(id: WindowId, source: string, params: Record<string, unknown>): void {
  registry.set(id, { source, params });
  const opener = tileIdFromSource(source);
  if (opener !== null && !openerTiles.has(id)) openerTiles.set(id, opener);
  wmLog('open-registry-set', {
    id,
    source,
    key: typeof params.key === 'string' ? params.key : undefined,
    role: typeof params.role === 'string' ? params.role : undefined,
    // The URL as opened, query string dropped: enough to tell one feature
    // window from another (border vs panel vs home) in a trace.
    address: typeof params.address === 'string' ? params.address.split('?')[0] : undefined,
  });
}

export function getWindowOpenPayload(id: WindowId): WindowOpenPayload | undefined {
  return registry.get(id);
}

export function listWindowOpenPayloads(): Array<{ id: WindowId } & WindowOpenPayload> {
  return Array.from(registry, ([id, payload]) => ({ id, ...payload }));
}

export function removeWindowOpenPayload(id: WindowId): void {
  openerTiles.delete(id);
  const entry = registry.get(id);
  if (!entry) return;
  registry.delete(id);
  wmLog('open-registry-remove', { id, key: typeof entry.params.key === 'string' ? entry.params.key : undefined });
}
