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

// params is stored by reference — legacy consumers mutate it in place (params.currentUrl, params.x, ...).
export function setWindowOpenPayload(id: WindowId, source: string, params: Record<string, unknown>): void {
  registry.set(id, { source, params });
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
  const entry = registry.get(id);
  if (!entry) return;
  registry.delete(id);
  wmLog('open-registry-remove', { id, key: typeof entry.params.key === 'string' ? entry.params.key : undefined });
}
