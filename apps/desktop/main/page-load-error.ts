/**
 * Load failure handling for the hybrid page host.
 *
 * A main-frame load that fails (DNS, refused, invalid address, ...) or never
 * finishes leaves the content area blank. The host shows a `peek://` error page
 * instead, carrying the failed address and a plain-language reason.
 *
 * Everything here is pure: the load phase is an explicit state advanced by
 * events, and each transition names the effect the caller must perform (arm or
 * clear the timeout, show the error page). The timer itself lives in
 * `ipc.ts wireHybridContentEvents`; it only ever fires the `timeout` event.
 */

/** A load still pending after this long is treated as hung and the error page is shown. */
export const HYBRID_LOAD_TIMEOUT_MS = 20000;

/** Chromium's code for a navigation superseded or stopped on purpose; not an error. */
export const LOAD_ABORTED_CODE = -3;
/** Synthetic code for a load that was still pending when the timeout fired. */
export const LOAD_TIMED_OUT_CODE = -7;

export const ERROR_PAGE_BASE = 'peek://app/page-error/index.html';

export type LoadPhase = 'idle' | 'loading' | 'failed';

export type LoadEvent =
  | { type: 'started' }
  | { type: 'stopped' }
  | { type: 'failed'; code: number }
  | { type: 'timeout' }
  | { type: 'error-page-started' };

export type LoadEffect = 'arm-timer' | 'clear-timer' | 'show-error' | null;

export function nextLoadPhase(phase: LoadPhase, ev: LoadEvent): { phase: LoadPhase; effect: LoadEffect } {
  switch (ev.type) {
    case 'started':
      return { phase: 'loading', effect: 'arm-timer' };
    case 'stopped':
      // A stop after a failure keeps the failed state: the error page is what is shown.
      return phase === 'loading' ? { phase: 'idle', effect: 'clear-timer' } : { phase, effect: null };
    case 'failed':
      // An aborted load (user stop, or superseded by a newer navigation) changes
      // nothing here: the stop event that follows settles the phase, and a
      // superseding navigation has already armed its own timer.
      if (ev.code === LOAD_ABORTED_CODE) return { phase, effect: null };
      return { phase: 'failed', effect: 'show-error' };
    case 'timeout':
      return phase === 'loading' ? { phase: 'failed', effect: 'show-error' } : { phase, effect: null };
    case 'error-page-started':
      return { phase: 'failed', effect: 'clear-timer' };
  }
}

/** Chromium net error codes mapped to the plain-language reason shown to the user. */
export function describeLoadError(code: number): { title: string; reason: string } {
  switch (code) {
    case LOAD_TIMED_OUT_CODE:
      return {
        title: 'The server is not answering',
        reason: 'The server is not answering, so the load was stopped. It may be down or too slow.',
      };
    case -102: // ERR_CONNECTION_REFUSED
      return {
        title: 'Connection refused',
        reason: 'The server refused the connection. Nothing may be listening at that address, or it is blocking requests.',
      };
    case -105: // ERR_NAME_NOT_RESOLVED
    case -137: // ERR_NAME_RESOLUTION_FAILED
      return {
        title: 'Address not found',
        reason: 'No server was found with that name. Check the address for typos.',
      };
    case -300: // ERR_INVALID_URL
    case -301: // ERR_DISALLOWED_URL_SCHEME
    case -302: // ERR_UNKNOWN_URL_SCHEME
      return {
        title: 'Not a valid address',
        reason: 'The page is not a valid address.',
      };
    case -118: // ERR_CONNECTION_TIMED_OUT
      return {
        title: 'The server is not answering',
        reason: 'The server is not answering, so the load was stopped. It may be down or too slow.',
      };
    case -106: // ERR_INTERNET_DISCONNECTED
    case -109: // ERR_ADDRESS_UNREACHABLE
    case -101: // ERR_CONNECTION_RESET
    case -100: // ERR_CONNECTION_CLOSED
    case -2: // ERR_FAILED
    default:
      return {
        title: 'Cannot reach the server',
        reason: 'Cannot reach the server. Check your connection and the address.',
      };
  }
}

export function buildErrorPageUrl(failedUrl: string, code: number, description: string): string {
  const { title, reason } = describeLoadError(code);
  const q = new URLSearchParams({
    url: failedUrl,
    code: String(code),
    desc: description || '',
    title,
    reason,
  });
  return `${ERROR_PAGE_BASE}?${q.toString()}`;
}

export function isErrorPageUrl(url: string | null | undefined): boolean {
  return !!url && url.startsWith(ERROR_PAGE_BASE);
}

/**
 * Whether a page host's content will report its first composited frame, the
 * fact that makes the host orderable (`session.ts installFirstFrameOrderableProducer`).
 * Only a page that has the runtime-external preload can report one, and an
 * internal `peek://` page is excluded even with it: a real window can be
 * inactive or occluded, so such a page may never composite a frame to report.
 * A host whose content will not report waits for the main-process terminal load
 * outcome instead. Hosts that do report keep waiting for the frame.
 */
export function contentReportsFirstFrame(preloadAttached: boolean, url: string | null | undefined): boolean {
  return preloadAttached && !(url ?? '').startsWith('peek://');
}

/**
 * The address a session snapshot records for a window: the address the user
 * asked for. A window showing the load-error page is saved under the failed
 * address, so restore reloads it and goes through the normal error path.
 */
export function savedWindowUrl(url: string): string {
  return failedUrlFromErrorPage(url) || url;
}

/** The failed address carried by an error page URL, or null for any other URL. */
export function failedUrlFromErrorPage(url: string | null | undefined): string | null {
  if (!isErrorPageUrl(url)) return null;
  try {
    return new URL(url as string).searchParams.get('url');
  } catch {
    return null;
  }
}
