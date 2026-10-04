/**
 * The command text after the user clicks a suggestion for a single-value
 * argument: the command name followed by the suggestion's value. A click on an
 * item suggestion or a multi-value argument is handled elsewhere, so the typed
 * text is returned unchanged for those, and when there is no suggestion.
 */
export function commandTextWithSuggestion(commandName, typed, paramDef, suggestion) {
  if (!suggestion || suggestion.value == null) return typed;
  if (!paramDef || paramDef.multiple || paramDef.type === 'item') return typed;
  return `${commandName} ${suggestion.value}`;
}
