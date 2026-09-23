// TEMPORARY diagnostic instrumentation for track/cmd-panel-unfocused-open (peek `f46a44ad`).
// Traces the cmd-panel URL-open desktop-membership path to find out why a content window
// opened while Peek isn't frontmost stays visible across every other app until Peek is
// given focus. Remove this file and every `cmdPanelDiag(...)` call site once the bug is
// root-caused — see handoff.md "Next steps" step 4.
import * as fs from 'node:fs';

const DIAG_LOG_PATH = '/tmp/peek-cmd-panel-unfocused-open-diag.log';

export function cmdPanelDiag(line: string): void {
  try {
    fs.appendFileSync(DIAG_LOG_PATH, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* best-effort */
  }
}
