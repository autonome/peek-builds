/**
 * Capability Violation Pubsub Publisher
 *
 * Publishes `tile:capability-violation` events on GLOBAL scope from the
 * system address whenever a tile IPC handler rejects a request due to a
 * missing or insufficient capability grant.
 *
 * Consumers (observability features, dev tools) can subscribe to the
 * `tile:capability-violation` topic to react to violations in real time.
 *
 * Payload shape:
 *   { tileId, capability, op, token?, reason, timestamp }
 *
 * Rate limiting: the same (tileId, capability, op) tuple is coalesced to
 * at most one event per 5 seconds to avoid flooding subscribers when a
 * runaway tile retries repeatedly.
 */

import { publish, getSystemAddress } from './pubsub.js';

export interface CapabilityViolationDetails {
  tileId: string | null;
  capability: string;
  op: string;
  token?: string;
  reason: string;
}

export interface CapabilityViolationEvent extends CapabilityViolationDetails {
  timestamp: number;
}

// Rate-limit state: key -> last emit timestamp
const _lastEmit = new Map<string, number>();
const RATE_LIMIT_MS = 5_000;

/**
 * Publish a `tile:capability-violation` event on GLOBAL scope.
 *
 * Rate-limited to one event per (tileId, capability, op) per 5 seconds.
 * The suppressed events are silently dropped (they carry no new info).
 */
export function publishCapabilityViolation(details: CapabilityViolationDetails): void {
  const key = `${details.tileId ?? ''}:${details.capability}:${details.op}`;
  const now = Date.now();
  const last = _lastEmit.get(key) ?? 0;
  if (now - last < RATE_LIMIT_MS) return;
  _lastEmit.set(key, now);

  const event: CapabilityViolationEvent = {
    ...details,
    timestamp: now,
  };

  publish(getSystemAddress(), 'tile:capability-violation', event);
}

/**
 * Clear rate-limit state — for use in tests only.
 */
export function _resetViolationRateLimit(): void {
  _lastEmit.clear();
}
