// TEMPORARY live-trace diagnostics for the cmd-palette URL-open-while-unfocused
// bug (see handoff.md). Appends one timestamped (ms precision) line per event to
// a file, because the interaction under test is real OS focus/activation, which
// a headless run cannot observe and console output does not reliably capture.
// Main process only. Revert this file and every call site importing it before
// the fix lands.
import * as fs from 'node:fs';
import * as path from 'node:path';

const LOG_PATH = path.join(process.cwd(), '.tmp', 'cmd-url-diag.log');

export function diag(line: string): void {
  try {
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* best-effort */
  }
}
