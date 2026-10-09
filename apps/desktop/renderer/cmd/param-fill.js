/**
 * The command text after the user clicks a suggestion for a single-value
 * argument: the command name followed by the suggestion's value. A click on an
 * item suggestion or a multi-value argument is handled elsewhere, so the typed
 * text is returned unchanged for those, and when there is no suggestion.
 */
/**
 * The text a parameter's suggestions are filtered on. Item parameters and
 * single-value parameters (such as a space name, which can contain spaces) use
 * everything typed after the command name; multi-value parameters use only the
 * word being typed. A single-value parameter keeps a trailing space so it
 * separates the words already typed from the rest of the name.
 */
export function paramFilterText(paramDef, completedTokens, partial) {
  if (paramDef && paramDef.type === 'item') {
    return [...completedTokens, partial].filter(Boolean).join(' ');
  }
  if (paramDef && !paramDef.multiple) {
    const text = [...completedTokens, partial].filter(Boolean).join(' ');
    return !partial && completedTokens.length > 0 ? text + ' ' : text;
  }
  return partial;
}

export function commandTextWithSuggestion(commandName, typed, paramDef, suggestion) {
  if (!suggestion || suggestion.value == null) return typed;
  if (!paramDef || paramDef.multiple || paramDef.type === 'item') return typed;
  return `${commandName} ${suggestion.value}`;
}
