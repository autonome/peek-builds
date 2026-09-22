/**
 * Which tile entries a DevTools request should attach to.
 *
 * "Is this feature running?" used to be answered twice, independently: the
 * feature-manager card assumed always-yes, and the IPC handler guessed by
 * scanning every webContents for a `peek://<featureId>/` URL. This module
 * derives the answer once, from the tile lifecycle FSM state plus whether a
 * window actually exists, and hands both the card and the handler the same
 * fact.
 *
 * Pure — imports only the FSM's state table, no Electron — so it compiles and
 * runs under the `electron --test dist/main/*.test.js` runner.
 */

import { STATES } from './tile-fsm.js';

/**
 * States in which attaching DevTools to an entry is meaningful.
 *
 * `loading` is deliberately excluded: the window exists but has not signalled
 * ready, so attaching is a race against the renderer's own startup.
 */
export const RUNNING_STATES: readonly string[] = Object.freeze([
  STATES.READY,
  STATES.VISIBLE,
]);

export interface EntryProbeResult {
  state: string;
  hasWindow: boolean;
}

export type EntryProbe = (entryId: string) => EntryProbeResult;

export interface LiveEntriesResult {
  /** Entries in a running state that also have a live window. */
  live: string[];
  /**
   * Entries in a running state with NO live window — the lifecycle state and
   * the window map disagree. Reported rather than folded into "not running",
   * so the disagreement is nameable instead of silently looking like a tile
   * that was never loaded.
   */
  drift: string[];
}

/**
 * Split the given entry ids into the ones DevTools can attach to and the ones
 * whose lifecycle state claims running but have no window behind it.
 */
export function liveDevtoolsEntries(entryIds: string[], probe: EntryProbe): LiveEntriesResult {
  const live: string[] = [];
  const drift: string[] = [];

  for (const entryId of entryIds ?? []) {
    const { state, hasWindow } = probe(entryId) ?? { state: '', hasWindow: false };
    if (!RUNNING_STATES.includes(state)) continue;
    if (hasWindow) live.push(entryId);
    else drift.push(entryId);
  }

  return { live, drift };
}

export type PickDevtoolsEntriesResult =
  | { entries: string[]; error?: undefined }
  | { error: string; entries?: undefined };

const DEFAULT_ENTRY_ID = 'background';

function listOrNone(entries: string[]): string {
  return entries.length ? entries.join(', ') : 'none';
}

/**
 * Choose the entries a devtools-open request resolves to.
 *
 * With no requested entry and several live entries, every live entry is
 * chosen — matching the behaviour of the URL scan this replaces, which opened
 * every matching context.
 */
export function pickDevtoolsEntries(
  requestedEntryId: string | undefined | null,
  live: string[],
  drift: string[],
  featureId: string,
): PickDevtoolsEntriesResult {
  if (requestedEntryId) {
    if (live.includes(requestedEntryId)) {
      return { entries: [requestedEntryId] };
    }
    return {
      error:
        `Entry ${featureId}:${requestedEntryId} is not running. ` +
        `Live entries: ${listOrNone(live)}.`,
    };
  }

  if (live.includes(DEFAULT_ENTRY_ID)) {
    return { entries: [DEFAULT_ENTRY_ID] };
  }

  if (live.length > 0) {
    return { entries: [...live] };
  }

  if (drift.length > 0) {
    return {
      error:
        `No attachable tile window for ${featureId}. ` +
        `Lifecycle state reports ready for ${drift.join(', ')} but no window exists.`,
    };
  }

  return {
    error:
      `No active tile found for ${featureId}:${DEFAULT_ENTRY_ID}. ` +
      `The feature may not be loaded yet. Entries considered: ${listOrNone(drift.concat(live))}.`,
  };
}
