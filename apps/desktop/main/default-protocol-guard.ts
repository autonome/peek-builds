// Guards the app's default protocol client registration.
//
// Registering as the http/https handler changes the machine's setting and raises
// an OS confirmation prompt that stays up after the process exits. That belongs to
// the Settings button only; a headless run (a test or agent run) must never ask.
// Every call is logged with its caller so an unexpected one can be found, and a
// headless call is refused whatever code makes it.

import { app } from 'electron';
import { isHeadless } from './config.js';
import { wmLog } from './window-diag.js';

let installed = false;

export function installDefaultProtocolGuard(): void {
  if (installed) return;
  installed = true;
  const original = app.setAsDefaultProtocolClient.bind(app);
  app.setAsDefaultProtocolClient = ((protocol: string, ...rest: unknown[]): boolean => {
    const caller = (new Error().stack ?? '').split('\n').slice(2, 6).map((line) => line.trim()).join(' <- ');
    const refused = isHeadless();
    wmLog('default-protocol-client-requested', { protocol, refused, caller });
    if (refused) return false;
    return (original as (p: string, ...r: unknown[]) => boolean)(protocol, ...rest);
  }) as typeof app.setAsDefaultProtocolClient;
}
