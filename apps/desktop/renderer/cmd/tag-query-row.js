/**
 * The first param suggestion when the text typed after an item-param command is a
 * tag query (`edit #todo #today`): a row that runs the command with the typed text,
 * so the tag query view is reachable by Enter or click and not only by typing past
 * the note suggestions. It carries no `_item`; `runTypedText` is what the state
 * machine's paramRowRunsTypedText guard recognises.
 *
 * Counts items the same way edit.js execute() does. An unknown tag matches nothing.
 *
 * Returns null for any other param type or text that is not a tag query.
 */
import { findTagByName } from './item-suggestions.js';
import { parseTagQuery, intersectItems } from './tag-query.js';

export async function tagQueryRow(paramDef, typedText, datastore) {
  if (!paramDef || paramDef.type !== 'item') return null;
  const names = parseTagQuery(typedText);
  if (!names) return null;

  const tagsResult = await datastore.getTagsByFrecency();
  const allTags = tagsResult?.success ? (tagsResult.data || []) : [];
  const itemLists = [];
  let unknown = false;
  for (const name of names) {
    const tag = findTagByName(allTags, name);
    if (!tag) {
      unknown = true;
      continue;
    }
    const itemsResult = await datastore.getItemsByTag(tag.id);
    itemLists.push(itemsResult?.success ? (itemsResult.data || []) : []);
  }
  const count = unknown ? 0 : intersectItems(itemLists).length;
  const label = names.map(n => '#' + n).join(' ');
  return {
    title: `All items tagged ${label} (${count})`,
    subtitle: unknown ? 'unknown tag' : undefined,
    runTypedText: true,
  };
}
