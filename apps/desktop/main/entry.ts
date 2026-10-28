/**
 * Electron startup gate.
 *
 * The only code that runs before the startup risk acknowledgment is recorded.
 * The normal runtime lives in runtime-entry.ts and is imported dynamically,
 * and only by the gate's runtime loader, after a valid record exists. Keep
 * every other import here free of runtime, profile and datastore code; that is
 * enforced by startup-consent.test.ts.
 */
// MUST stay first: sets the macOS headless activation policy before anything
// else with side effects runs.
import './headless-policy.js';
import { app } from 'electron';
import { readBuildInfo } from './build-info.js';
import {
  createAcceptanceRecord,
  createStartupConsentGate,
  noticeRequired,
  persistAcceptanceRecord,
  readAcceptanceRecordSync,
  revokeAcceptanceRecord,
} from './startup-consent.js';

// The installation user-data root, captured before the runtime selects a profile.
const consentRoot = app.getPath('userData');
// An unpackaged run skips the notice and never touches the record.
const alreadyAccepted = !noticeRequired({
  packaged: app.isPackaged,
  accepted: app.isPackaged && readAcceptanceRecordSync(consentRoot) !== null,
});
const presenter = alreadyAccepted ? null : await import('./startup-consent-electron.js');
presenter?.prepareNotice();

function buildIdentity(): string {
  const info = readBuildInfo(process.resourcesPath);
  return info ? `${info.shortCommit}${info.dirty ? '+dirty' : ''}` : `v${app.getVersion()}`;
}

const gate = createStartupConsentGate({
  buildIdentity: alreadyAccepted ? undefined : buildIdentity(),
  // Unpackaged: an in-memory stand-in so the gate passes without disk access.
  readRecord: async () => (app.isPackaged ? readAcceptanceRecordSync(consentRoot) : createAcceptanceRecord()),
  present: async context => (await import('./startup-consent-electron.js')).presentNotice(context),
  persist: record => persistAcceptanceRecord(consentRoot, record),
  revoke: () => revokeAcceptanceRecord(consentRoot),
  signal: presenter?.consentSignal,
  loadRuntime: async () => {
    if (alreadyAccepted) {
      // Runs before Electron is ready, as the runtime requires.
      await import('./runtime-entry.js');
    } else {
      // First acceptance happens after ready; the runtime needs a fresh
      // pre-ready process (scheme privileges, early switches).
      (await import('./startup-consent-electron.js')).restartIntoRuntime();
    }
  },
});

if (alreadyAccepted) {
  // Awaited so Electron does not become ready before the runtime has registered
  // its pre-ready configuration. A runtime failure still fails closed.
  const outcome = await gate();
  if (outcome.status !== 'accepted') (await import('./startup-consent-electron.js')).terminateAfter(outcome);
} else {
  // Not awaited: the notice needs a ready app.
  void gate().then(async outcome => {
    if (outcome.status !== 'accepted') (await import('./startup-consent-electron.js')).terminateAfter(outcome);
  });
}
