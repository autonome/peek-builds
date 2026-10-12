/**
 * TEMPORARY diagnostic for dropping a browser tab onto a Spaces card.
 *
 * Every line goes straight to a fixed file with a synchronous append, so it
 * does not depend on the renderer console pipeline (`renderer-log.ts`), which
 * produced nothing from the Spaces home window in an earlier attempt.
 *
 * Sources:
 *  - the Spaces home renderer, through `api.log('[space-drop-diag]', ...)`
 *    (routed here by the `tile:log:write` handler in `tile-ipc.ts`);
 *  - main itself: navigation attempts on any webContents (an unhandled drop of
 *    a URL makes Chromium try to navigate to it), and window-level drag-ish
 *    events that main can see.
 *
 * Remove this module and its call sites once the drop works.
 */

import fs from 'node:fs';
import { app } from 'electron';

export const SPACE_DROP_DIAG_PATH = '/tmp/peek-space-drop-diag.log';
export const SPACE_DROP_DIAG_TAG = '[space-drop-diag]';

export function spaceDropDiag(line: string): void {
  try {
    fs.appendFileSync(SPACE_DROP_DIAG_PATH, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* best-effort */
  }
}

let installed = false;

/** Main-side hooks: log every navigation attempt and new-window request. */
export function installSpaceDropDiag(): void {
  if (installed) return;
  installed = true;
  spaceDropDiag(`[main] diag installed pid=${process.pid}`);
  app.on('web-contents-created', (_e, wc) => {
    const label = () => {
      try { return `wc=${wc.id} type=${wc.getType()} url=${wc.getURL().slice(0, 100)}`; } catch { return `wc=${wc.id}`; }
    };
    wc.on('will-navigate', (_ev, url) => {
      spaceDropDiag(`[main] will-navigate ${label()} -> ${String(url).slice(0, 200)}`);
    });
    wc.on('did-start-navigation', (details) => {
      const d = details as unknown as { url?: string; isMainFrame?: boolean; isSameDocument?: boolean };
      if (!d.isMainFrame || d.isSameDocument) return;
      spaceDropDiag(`[main] did-start-navigation ${label()} -> ${String(d.url).slice(0, 200)}`);
    });
  });
}
