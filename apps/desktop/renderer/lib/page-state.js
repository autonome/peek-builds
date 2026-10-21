/**
 * page-state.js — every rule about a page's kept/dropped judgement.
 *
 * Pure: no `api`, no window, no DOM. Served as `peek://app/lib/page-state.js` and
 * imported directly by node unit tests.
 *
 * A page's state is a tag on its URL item, `kept` or `dropped`. A page carries at most
 * one of the two; no tag means not yet judged. The note lives in the URL item's
 * `metadata.notes`.
 */

export const PAGE_STATES = ['kept', 'dropped'];

const ACTION_TAGS = { keep: 'kept', drop: 'dropped' };

/**
 * The state a page is in, given the tag names on its URL item.
 *
 * @param {string[]|null|undefined} tagNames
 * @returns {'kept'|'dropped'|null}
 */
export function stateFromTags(tagNames) {
  const names = normaliseTagNames(tagNames);
  // PAGE_STATES order is the tiebreak when a page somehow carries both: `kept` wins,
  // which is the tag a `keep` plan leaves behind.
  return PAGE_STATES.find((state) => names.has(state)) ?? null;
}

/**
 * What applying `action` to a page should change.
 *
 * @param {string[]|null|undefined} currentTagNames tag names currently on the URL item
 * @param {'keep'|'drop'|'clear'} action
 * @param {string|null|undefined} [note] one-line note; blank or absent leaves the note alone
 * @returns {{ addTag: string|null, removeTags: string[], notes?: string }}
 *   `notes` is absent when the note is unchanged.
 */
export function planPageState(currentTagNames, action, note) {
  const names = normaliseTagNames(currentTagNames);

  if (action === 'clear') {
    // Clearing removes both tags and never touches the note.
    return { addTag: null, removeTags: PAGE_STATES.filter((state) => names.has(state)) };
  }

  const wanted = ACTION_TAGS[action];
  if (!wanted) throw new Error(`unknown page-state action: ${String(action)}`);

  const plan = {
    addTag: names.has(wanted) ? null : wanted,
    removeTags: PAGE_STATES.filter((state) => state !== wanted && names.has(state)),
  };

  const trimmed = typeof note === 'string' ? note.trim() : '';
  if (trimmed) plan.notes = trimmed;

  return plan;
}

function normaliseTagNames(tagNames) {
  if (!Array.isArray(tagNames)) return new Set();
  return new Set(
    tagNames
      .filter((name) => typeof name === 'string')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
  );
}
