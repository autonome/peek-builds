/**
 * Reminder job logic — pure, no `api`, no window, no DOM, so a peeklet can run
 * it somewhere other than the desktop.
 *
 * A `remind:<n><unit>` tag asks for an item back after that duration. The clock
 * starts when this logic first sees the tag, not when the tag was added: tiles
 * cannot read `item_tags.createdAt`, and a tag synced from another device was
 * not added here. The due time lives on the item as
 * `metadata.reminder = { tag, dueAt }`, so the next run can tell a reminder it
 * has already started from one it has not.
 *
 * When a reminder comes due the duration tag is replaced by `remind:due` and
 * `metadata.reminder` is kept, so `dueAt` stays visible. Removing `remind:due`
 * dismisses the reminder and the next run drops the metadata.
 */

/** Tag prefix, following the `space:` convention in `features/spaces/config.js`. */
export const REMIND_TAG_PREFIX = 'remind:';

/** The tag an item carries once its reminder has come due. */
export const REMIND_DUE_TAG = 'remind:due';

/** The query `reminders` opens the search window on. */
export const REMIND_DUE_QUERY = '#remind:due';

const MS_PER_MINUTE = 60 * 1000;

const UNIT_MS = {
  m: MS_PER_MINUTE,
  h: 60 * MS_PER_MINUTE,
  d: 24 * 60 * MS_PER_MINUTE,
  w: 7 * 24 * 60 * MS_PER_MINUTE,
};

/** One whole number ≥ 1 and one unit — `remind:90m`, `remind:3d`, never `remind:1h30m`. */
const DURATION_RE = /^remind:(\d+)([mhdw])$/;

/**
 * Read a tag name as a reminder.
 *
 * Returns `{ ms }` for a duration tag, `{ due: true }` for `remind:due`, and
 * `null` for anything else — including a `remind:` tag that does not parse,
 * which is left alone and never comes due.
 */
export function parseRemindTag(name) {
  if (typeof name !== 'string') return null;
  if (name === REMIND_DUE_TAG) return { due: true };
  const match = DURATION_RE.exec(name);
  if (!match) return null;
  const count = Number(match[1]);
  if (!Number.isInteger(count) || count < 1) return null;
  return { ms: count * UNIT_MS[match[2]] };
}

/** Tag names off whatever shape the caller holds them in. */
function tagNames(tags) {
  if (!Array.isArray(tags)) return [];
  const names = [];
  for (const tag of tags) {
    if (typeof tag === 'string') names.push(tag);
    else if (tag && typeof tag.name === 'string') names.push(tag.name);
  }
  return names;
}

function storedReminder(item) {
  const reminder = item?.metadata?.reminder;
  if (!reminder || typeof reminder !== 'object') return null;
  if (typeof reminder.tag !== 'string') return null;
  if (typeof reminder.dueAt !== 'number') return null;
  return reminder;
}

/**
 * Decide what each item's reminder needs.
 *
 * `itemTags` maps an item id to its tags (names, or `{ name }` records);
 * `itemsById` maps an item id to the item, read for `metadata.reminder`; `now`
 * is the time of the check. Items appearing in either map are considered, so an
 * item whose reminder tag was removed is still reached for its clear.
 *
 * Actions, at most one per item:
 * - `{ itemId, kind: 'start', reminder: { tag, dueAt } }` — a duration tag with
 *   no stored reminder, or one whose stored reminder names a different tag, so
 *   a changed tag restarts the clock.
 * - `{ itemId, kind: 'due', fromTag }` — a stored reminder whose `dueAt` has
 *   passed. The caller swaps `fromTag` for `remind:due` and keeps the metadata,
 *   which is what makes this fire once.
 * - `{ itemId, kind: 'clear' }` — stored metadata with no reminder tag left.
 *
 * When several duration tags sit on one item the first in the given order wins,
 * so the result is a function of the input rather than of map iteration luck.
 */
export function planReminders(itemTags, itemsById, now) {
  const tagsFor = asMap(itemTags);
  const items = asMap(itemsById);

  const ids = new Set();
  for (const id of tagsFor.keys()) ids.add(id);
  for (const id of items.keys()) ids.add(id);

  const actions = [];
  for (const itemId of ids) {
    const names = tagNames(tagsFor.get(itemId));
    const reminder = storedReminder(items.get(itemId));

    let durationTag = null;
    let durationMs = 0;
    let hasDueTag = false;
    for (const name of names) {
      const parsed = parseRemindTag(name);
      if (!parsed) continue;
      if (parsed.due) {
        hasDueTag = true;
      } else if (durationTag === null) {
        durationTag = name;
        durationMs = parsed.ms;
      }
    }

    if (durationTag !== null) {
      if (!reminder || reminder.tag !== durationTag) {
        actions.push({
          itemId,
          kind: 'start',
          reminder: { tag: durationTag, dueAt: now + durationMs },
        });
      } else if (reminder.dueAt <= now) {
        actions.push({ itemId, kind: 'due', fromTag: durationTag });
      }
      continue;
    }

    // No duration tag left. `remind:due` is the waiting state and keeps its
    // metadata; without either tag the metadata has nothing left to describe.
    if (!hasDueTag && reminder) actions.push({ itemId, kind: 'clear' });
  }

  return actions;
}

function asMap(source) {
  if (source instanceof Map) return source;
  const map = new Map();
  if (source && typeof source === 'object') {
    for (const [key, value] of Object.entries(source)) map.set(key, value);
  }
  return map;
}

/**
 * Item ids worth reading before a check: everything carrying a `remind:` tag.
 * The ids whose metadata must be cleared come from the caller's own record of
 * what it has started, since a removed tag leaves nothing to find them by.
 */
export function itemIdsWithRemindTags(itemTags) {
  const tagsFor = asMap(itemTags);
  const ids = [];
  for (const [itemId, tags] of tagsFor) {
    if (tagNames(tags).some(name => name.startsWith(REMIND_TAG_PREFIX))) ids.push(itemId);
  }
  return ids;
}
