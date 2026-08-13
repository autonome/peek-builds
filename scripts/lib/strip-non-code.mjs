/**
 * strip-non-code.mjs — blank out comments, string/template contents and
 * regex-literal contents from JS/TS source, so a mechanical check greps CODE
 * and never prose.
 *
 * Shared by `scripts/check-r2-window-ops.mjs` and
 * `scripts/check-platform-leak.mjs`. It lives in its own module with NO
 * side effects at import time, because both callers are scripts that run their
 * check on load — importing one from the other would run that check as an
 * invisible side effect and make either script's exit code ambiguous.
 *
 * Both checks depend on the same distinction: explaining a platform hazard in
 * a comment is correct and must stay legal, while writing its call or argument
 * name in code is the violation. A drifting second copy of this stripper would
 * silently change what either check can see, so there is exactly one.
 *
 * Not a JS lexer, and deliberately so — it preserves offsets (replaced
 * characters become spaces) and keeps code inside `${...}` interpolations.
 */

/**
 * Can a `/` at this point start a regex literal (vs. be a division operator)?
 * Heuristic: after an operator / opening bracket / separator (or at file
 * start) a regex can start; after an identifier char, `)` or `]` it is
 * division. Known residual blind spot: `return /re/` (prev char is a letter)
 * reads as division, leaving the regex body unstripped.
 */
function regexCanStart(prevSig) {
  if (prevSig === '') return true;
  return '([{=,:;!&|?+-*%^~<>'.includes(prevSig);
}

/**
 * Blank out comments, string/template contents and regex-literal contents,
 * preserving offsets (replaced chars become spaces) and code inside `${...}`
 * interpolations.
 */
export function stripNonCode(src) {
  const n = src.length;
  const out = src.split('');
  let state = 'code';
  const braceDepths = []; // one depth counter per nested template interpolation
  let prevSig = ''; // last significant (non-whitespace) code char, for the regex-vs-division call
  let inClass = false; // inside a regex [...] character class
  for (let i = 0; i < n; i++) {
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : '';
    switch (state) {
      case 'code':
        if (c === '/' && d === '/') { state = 'line'; out[i] = ' '; }
        else if (c === '/' && d === '*') { state = 'block'; out[i] = ' '; }
        else if (c === '/' && regexCanStart(prevSig)) { state = 'regex'; inClass = false; out[i] = ' '; }
        else if (c === "'") { state = 'single'; out[i] = ' '; }
        else if (c === '"') { state = 'double'; out[i] = ' '; }
        else if (c === '`') { state = 'template'; out[i] = ' '; }
        else if (c === '{' && braceDepths.length) { braceDepths[braceDepths.length - 1]++; }
        else if (c === '}' && braceDepths.length) {
          if (braceDepths[braceDepths.length - 1] === 0) {
            braceDepths.pop();
            state = 'template';
            out[i] = ' ';
          } else {
            braceDepths[braceDepths.length - 1]--;
          }
        }
        if (state === 'code' && !/\s/.test(c)) prevSig = c;
        break;
      case 'regex':
        if (c === '\\') { out[i] = ' '; if (d) { out[i + 1] = ' '; i++; } }
        else if (c === '[') { inClass = true; out[i] = ' '; }
        else if (c === ']') { inClass = false; out[i] = ' '; }
        else if (c === '/' && !inClass) { state = 'code'; out[i] = ' '; prevSig = ')'; /* regex value ~ operand */ }
        else if (c === '\n') { state = 'code'; /* not a regex after all (unterminated) — resync */ }
        else out[i] = ' ';
        break;
      case 'line':
        if (c === '\n') state = 'code';
        else out[i] = ' ';
        break;
      case 'block':
        if (c === '*' && d === '/') { state = 'code'; out[i] = ' '; out[i + 1] = ' '; i++; }
        else if (c !== '\n') out[i] = ' ';
        break;
      case 'single':
        if (c === '\\') { out[i] = ' '; if (d) { out[i + 1] = ' '; i++; } }
        else if (c === "'") { state = 'code'; out[i] = ' '; }
        else if (c !== '\n') out[i] = ' ';
        break;
      case 'double':
        if (c === '\\') { out[i] = ' '; if (d) { out[i + 1] = ' '; i++; } }
        else if (c === '"') { state = 'code'; out[i] = ' '; }
        else if (c !== '\n') out[i] = ' ';
        break;
      case 'template':
        if (c === '\\') { out[i] = ' '; if (d) { out[i + 1] = ' '; i++; } }
        else if (c === '$' && d === '{') {
          braceDepths.push(0);
          state = 'code';
          out[i] = ' ';
          out[i + 1] = ' ';
          i++;
        }
        else if (c === '`') { state = 'code'; out[i] = ' '; }
        else if (c !== '\n') out[i] = ' ';
        break;
    }
  }
  return out.join('');
}
