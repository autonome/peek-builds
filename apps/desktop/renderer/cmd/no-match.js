/**
 * The single row shown when a command's parameter suggestions match nothing
 * the user typed, so a typo and a new name do not look the same as an empty
 * list. A parameter that declares `createCommand` offers to create the typed
 * name by running that command with it; any other parameter gets a row that
 * only says nothing matched (`run: null`, not selectable).
 *
 * Returns null while nothing is typed, or when there is no parameter.
 */
export function noMatchRow(paramDef, typedText) {
  const typed = String(typedText || '').trim();
  if (!paramDef || !typed) return null;
  if (paramDef.createCommand) {
    return {
      title: `Create "${typed}"`,
      subtitle: paramDef.createCommand,
      run: `${paramDef.createCommand} ${typed}`,
    };
  }
  return { title: `No match for "${typed}"`, run: null };
}
