/**
 * live-diag.ts — TEMPORARY file-based diagnostics for a one-shot live-display
 * sitting (peek 7fffa286 fullscreen-owner verification). THIS WHOLE FILE AND
 * EVERY `diag(...)` CALL SITE IS REVERTED once the sitting is done.
 *
 * It exists as a committed file (not a working-copy scratch edit) only because
 * the repo rule says diagnostics must survive a jj working-copy reset.
 *
 * `import * as fs` — NOT `require('node:fs')`: the desktop main package is
 * `"type": "module"`, so a `require` here throws ReferenceError and a
 * surrounding try/catch swallows it, producing an empty log that reads as
 * "the code never ran". See the `peek-fs-diag-bridge` skill.
 */

import * as fs from 'node:fs';

/** Where every live-sitting line lands, interleaved in dispatch order. */
const LIVE_DIAG_PATH = '/tmp/peek-cmd-diag.log';

/** Append one timestamped line. Best-effort: never throws into a caller. */
export function diag(line: string): void {
  try {
    fs.appendFileSync(LIVE_DIAG_PATH, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* best-effort diagnostics — a failed write must never break the app */
  }
}
