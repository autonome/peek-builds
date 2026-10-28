/**
 * Electron presenter for the startup risk notice.
 *
 * Imports only Electron, Node and the neutral consent policy. It must never
 * import the normal runtime, profile initialization, the datastore or any
 * protocol registration: it runs while acceptance is still unrecorded.
 *
 * Responsibilities while the notice is up:
 *  - one sandboxed, offline window that renders the canonical wording;
 *  - a bootstrap lock on the installation user-data root so concurrent
 *    unaccepted launches forward their arguments here instead of opening a
 *    second notice (accepted launches use per-profile locks and never touch it);
 *  - capture of URLs, protocol events and second-instance launches as inert
 *    data, released only after acceptance and discarded otherwise.
 */
import { app, BrowserWindow, ipcMain, Menu, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NOTICE,
  safeRelaunchArgs,
  createPendingWork,
  interactiveDisplayAvailable,
  validatePendingUrl,
  type ConsentDecision,
  type ConsentOutcome,
} from './startup-consent.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOTICE_PAGE = path.resolve(HERE, '../../renderer/startup-consent/index.html');
const PRELOAD = path.join(HERE, 'startup-consent-preload.cjs');
const MAX_FORWARDED_ARGS = 64;

const pending = createPendingWork();
let noticeWindow: BrowserWindow | null = null;
let activeDecision: ((decision: ConsentDecision) => void) | null = null;
let lockHeld = false;
let handlersInstalled = false;
const cancellation = new AbortController();
export const consentSignal = cancellation.signal;

function decline(action: 'decline' | 'close' = 'decline'): void {
  cancellation.abort();
  pending.discard();
  activeDecision?.({ action });
}

function captureArgv(argv: unknown): void {
  if (!Array.isArray(argv)) return;
  for (const item of argv.slice(0, MAX_FORWARDED_ARGS)) {
    if (validatePendingUrl(item)) pending.capture(item);
  }
}

/**
 * A second launch or OS activation while the notice is up changes nothing: the
 * notice stays as it is. The window is deliberately not raised here, because
 * window operations belong to the window-state machine and the notice exists
 * before it does (scripts/check-r2-window-ops.mjs).
 */
function keepNotice(): void {
  // Intentionally empty.
}

function installCaptureHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  app.on('open-url', (event, url) => { event.preventDefault(); pending.capture(url); });
  app.on('open-file', (event) => { event.preventDefault(); /* file paths are never replayed */ });
  app.on('second-instance', (_event, argv, _cwd, additionalData) => {
    const data = additionalData as { url?: unknown } | null | undefined;
    if (data && typeof data === 'object') pending.capture(data.url);
    captureArgv(argv);
    keepNotice();
  });
  app.on('activate', keepNotice);
}

function hardenSession(): Electron.Session {
  const ses = session.fromPartition('startup-consent-notice');
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith('file://') });
  });
  return ses;
}

function failure(message: string): Error {
  return new Error(message);
}

async function ensureWindow(): Promise<BrowserWindow> {
  if (noticeWindow && !noticeWindow.isDestroyed()) return noticeWindow;

  const ses = hardenSession();
  const win = new BrowserWindow({
    width: 640,
    height: 720,
    minWidth: 320,
    minHeight: 320,
    backgroundColor: '#1b1b1d',
    title: NOTICE.title,
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      session: ses,
      devTools: false,
    },
  });
  noticeWindow = win;
  const wc = win.webContents;

  wc.on('will-navigate', event => event.preventDefault());
  wc.on('will-attach-webview', event => event.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault();
      decline();
    }
  });
  win.on('closed', () => {
    noticeWindow = null;
    decline('close');
  });

  const loaded = new Promise<void>((resolve, reject) => {
    wc.once('did-finish-load', () => resolve());
    wc.once('did-fail-load', (_e, code, description) => reject(failure(`notice failed to load: ${description} (${code})`)));
    wc.once('render-process-gone', (_e, details) => reject(failure(`notice renderer exited: ${details.reason}`)));
    wc.once('preload-error', (_e, file, error) => reject(failure(`notice preload failed: ${file}: ${error.message}`)));
  });
  await win.loadFile(NOTICE_PAGE);
  await loaded;
  return win;
}

function installIpc(): void {
  ipcMain.handle('startup-consent:get-notice', event => {
    if (!noticeWindow || event.senderFrame !== noticeWindow.webContents.mainFrame) return null;
    return NOTICE;
  });
  ipcMain.on('startup-consent:decision', (event, payload: unknown) => {
    if (!noticeWindow || event.senderFrame !== noticeWindow.webContents.mainFrame) return;
    const data = (payload ?? {}) as { action?: unknown; acknowledgments?: unknown };
    if (data.action === 'decline') decline();
    else if (data.action === 'accept') {
      activeDecision?.({ action: 'accept', acknowledgments: data.acknowledgments });
    }
  });
}

function installMenu(): void {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }
}

let prepared = false;

/** Called by entry before yielding to readiness. Accepted launches never call it. */
export function prepareNotice(): void {
  installCaptureHandlers();
  captureArgv(process.argv.slice(1));
  if (!app.requestSingleInstanceLock({ url: process.argv.find(arg => validatePendingUrl(arg)) ?? null })) {
    app.exit(0);
    return;
  }
  lockHeld = true;
  // Keep the process alive until an in-flight write has settled and, if needed,
  // been revoked. terminateAfter uses exit, not quit, after that cleanup.
  app.on('window-all-closed', () => decline('close'));
  app.on('before-quit', event => { event.preventDefault(); decline(); });
}

/**
 * Presenter for createStartupConsentGate. Rejects (so the gate fails closed)
 * when no interactive display exists, when launched headless, or when the notice
 * cannot be rendered.
 */
export async function presentNotice(context: { persistenceError?: unknown }): Promise<ConsentDecision> {
  if (!prepared) {
    prepared = true;
    if (process.env.PEEK_HEADLESS) {
      throw failure('headless launch is blocked: no startup risk acknowledgment is recorded; launch with a display and accept the notice');
    }
    if (!interactiveDisplayAvailable(process.platform, process.env)) {
      throw failure('no display is available and no startup risk acknowledgment is recorded; start Peek in a graphical session to accept the notice');
    }
    await app.whenReady();
    installIpc();
    installMenu();
  }
  if (consentSignal.aborted) return { action: 'decline' };
  const win = await ensureWindow();
  if (consentSignal.aborted) return { action: 'decline' };
  if (context.persistenceError !== undefined) {
    const detail = context.persistenceError instanceof Error ? context.persistenceError.message : String(context.persistenceError);
    win.webContents.send('startup-consent:error', `Your acknowledgment could not be saved (${detail}). Try again or quit.`);
  }
  return new Promise<ConsentDecision>(resolve => {
    activeDecision = decision => {
      // The decline handlers and abort signal stay live through persistence.
      resolve(decision);
    };
  });
}

function releaseBootstrapLock(): void {
  if (lockHeld) {
    lockHeld = false;
    app.releaseSingleInstanceLock();
  }
}

/**
 * Runtime start after a first acceptance. Scheme privileges and early
 * command-line switches must be set before Electron is ready, so a fresh
 * process starts the runtime. The one validated pending URL, when the new
 * command line carries none, rides along as an argument.
 */
export function restartIntoRuntime(): void {
  if (consentSignal.aborted) throw failure('startup was cancelled');
  const args = safeRelaunchArgs(process.argv.slice(process.defaultApp ? 2 : 1),
    process.defaultApp ? process.argv[1] : null, pending.release());
  releaseBootstrapLock();
  app.relaunch({ args });
  app.exit(0);
}

/** Terminates after decline, close or failure. Pending work is dropped. */
export function terminateAfter(outcome: ConsentOutcome): void {
  pending.discard();
  releaseBootstrapLock();
  if (outcome.status === 'failed') {
    const error = outcome.error;
    console.error(`[startup-consent] startup blocked: ${error instanceof Error ? error.message : String(error)}`);
    app.exit(1);
    return;
  }
  app.exit(0);
}
