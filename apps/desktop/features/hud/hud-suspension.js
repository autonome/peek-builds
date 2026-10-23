/**
 * Idle-feature unloading, for the HUD. Folds `tile:suspension-changed` messages
 * (main/tile-suspension-shell.ts SuspensionChange) into per-feature rows. Pure, so it
 * runs under node --test.
 *
 * The HUD only sees changes made while it is open, so a feature it has not heard about
 * is simply absent; the Windows section shows which features are loaded right now.
 */

export const SUSPENSION_TOPIC = 'tile:suspension-changed';

/** Plain-words state for a policy name. */
const STATE_LABELS = {
  suspended: 'unloaded',
  waking: 'loading',
  idle: 'loaded, idle',
  active: 'loaded, in use',
  suspending: 'unloading',
};

/** Fold one change message into `state` (a Map of tileId -> { policy, unloads }). */
export function applySuspensionChange(state, change) {
  if (!change || typeof change.tileId !== 'string' || typeof change.to !== 'string') return state;
  const row = state.get(change.tileId) || { policy: change.to, unloads: 0 };
  row.policy = change.to;
  // Count only decisions that were carried out.
  if (change.to === 'suspended' && change.from === 'suspending' && !change.observeOnly) row.unloads += 1;
  state.set(change.tileId, row);
  return state;
}

/** Rows for display: [label, value], unloaded features first, then by name. */
export function suspensionRows(state) {
  const rank = (policy) => (policy === 'suspended' ? 0 : policy === 'suspending' ? 1 : 2);
  return [...state.entries()]
    .sort((a, b) => rank(a[1].policy) - rank(b[1].policy) || a[0].localeCompare(b[0]))
    .map(([tileId, row]) => {
      const label = STATE_LABELS[row.policy] || row.policy;
      return [tileId, row.unloads > 0 ? `${label} (unloaded ${row.unloads}x)` : label];
    });
}
