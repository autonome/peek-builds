/**
 * Typed text that is not a command name but a command takes anyway.
 *
 * A command may declare `claimsInput` as either a function `(text) => boolean`
 * (commands that live in the panel) or `{ tokenPattern }` (commands from other
 * tiles, whose declaration has to survive serialization). The object form
 * matches when every whitespace-separated token matches the regular expression
 * source in `tokenPattern`.
 */

export function commandClaimsInput(command, text) {
  const claim = command && command.claimsInput;
  if (!claim) return false;
  if (typeof claim === 'function') {
    try { return claim(text) === true; } catch (e) { return false; }
  }
  if (typeof claim.tokenPattern !== 'string') return false;
  const tokens = String(text || '').split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  let re;
  try { re = new RegExp(claim.tokenPattern); } catch (e) { return false; }
  return tokens.every(t => re.test(t));
}

/** Name of the first command (in object key order) that claims the text, or null. */
export function findClaimingCommand(commands, text) {
  for (const name of Object.keys(commands || {})) {
    if (commandClaimsInput(commands[name], text)) return name;
  }
  return null;
}
