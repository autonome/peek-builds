/**
 * Extra rows a command's param definition can put above the normal suggestions.
 *
 * A param def may carry `extraRows(typedText, ctx)`, returning an array of rows (or null),
 * possibly async. The panel knows nothing about what the rows are; commands that don't
 * declare the function get no extra rows.
 */

export async function extraParamRows(paramDef, typedText, ctx) {
  if (!paramDef || typeof paramDef.extraRows !== 'function') return [];
  const rows = await paramDef.extraRows(typedText, ctx);
  return Array.isArray(rows) ? rows : [];
}

export function prependRows(extraRows, suggestions) {
  return extraRows.length > 0 ? [...extraRows, ...suggestions] : suggestions;
}
