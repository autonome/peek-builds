/**
 * Sort options for lists of items in the editor's top toolbar. Pure functions,
 * no DOM.
 */

import { blockTitle } from './query-surface-dom.js';

export const DEFAULT_SORT_OPTION = 'updated-desc';

/** Options in dropdown order. */
export const SORT_OPTIONS = [
  { id: 'updated-desc', label: 'Date edited, newest first' },
  { id: 'updated-asc', label: 'Date edited, oldest first' },
  { id: 'created-desc', label: 'Date created, newest first' },
  { id: 'created-asc', label: 'Date created, oldest first' },
  { id: 'title-asc', label: 'Title, A to Z' },
];

/** Timestamp in ms; missing or unparseable values count as 0 (oldest). */
function time(value) {
  if (!value) return 0;
  const t = typeof value === 'number' ? value : new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

const COMPARATORS = {
  'updated-desc': (a, b) => time(b.updatedAt) - time(a.updatedAt),
  'updated-asc': (a, b) => time(a.updatedAt) - time(b.updatedAt),
  'created-desc': (a, b) => time(b.createdAt) - time(a.createdAt),
  'created-asc': (a, b) => time(a.createdAt) - time(b.createdAt),
  'title-asc': (a, b) => blockTitle(a).localeCompare(blockTitle(b), undefined, { sensitivity: 'base' }),
};

/**
 * Sorted copy of `items`. Ties keep input order. An unknown option id sorts
 * like the default.
 * @param {Array<object>} items
 * @param {string} optionId
 */
export function sortItems(items, optionId) {
  const compare = COMPARATORS[optionId] || COMPARATORS[DEFAULT_SORT_OPTION];
  return items
    .map((item, index) => ({ item, index }))
    .sort((x, y) => compare(x.item, y.item) || x.index - y.index)
    .map(({ item }) => item);
}
