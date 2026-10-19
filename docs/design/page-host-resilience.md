# Page host resilience

A page host stays usable whatever its page does: the user can always stop, reload, go back,
change the address, close, or switch windows.

## Mechanism

- **Open call is bounded.** `ipc.ts` window-open handler, hybrid page-host branch: the wait on
  the first load is capped at `HYBRID_OPEN_LOAD_WAIT_MS` (2 s). The load continues in the
  background, so the registration, the `window:opened` publish and the open result are not held
  by a server that never answers.
- **Stop.** `page:stop` calls `wc.stop()` (`ipc.ts installHybridNavbarActionRouting`). The
  navbar (`peek-navbar.js`) shows a stop button in place of reload while loading.
- **Hung load becomes an error page.** `wireHybridContentEvents` advances an explicit load phase
  (`idle | loading | failed`, `page-load-error.ts nextLoadPhase`). After `HYBRID_LOAD_TIMEOUT_MS`
  (20 s, test override `PEEK_PAGE_LOAD_TIMEOUT_MS`) the host loads
  `peek://app/page-error/index.html` with the reason, address and a Retry button.
  `page-load-error.ts describeLoadError` holds the reason text per case. Reload and Retry retry
  the failed address; Back skips the failed history entry; an address that is not an absolute
  URL is never navigated, only edited.
- **Failed address stays the page's address.** The navbar, the session snapshot
  (`session-projection.ts`, `page-load-error.ts savedWindowUrl`) and window listings
  (`window-presenter.ts getHybridPresentation`, via `failedUrlFromErrorPage`) report the
  failed address while the error page shows, so tag commands and restore act on the page the
  user meant.
- **Chrome attaches without a painted frame.** A host whose first load fails, hangs past the
  open-call wait, or is an internal `peek://` page becomes orderable at load stop instead of
  at first frame (`ipc.ts markUnpaintedHostOrderable`,
  `page-load-error.ts contentReportsFirstFrame`). Restored hosts (deferred and skipTracking)
  go through the same `loadWithOutcome` path.
- **Stuck renderer.** A user navigation (`page:navigate`, reload, back) that has not committed
  after 2.5 s probes the renderer with a trivial script; no answer within 1.5 s kills the
  renderer and re-issues the navigation once `render-process-gone` fires
  (`ipc.ts driveUserNavigation`, `restartRendererThen`, `watchForHungRenderer`). `page:stop`
  cancels a pending recovery. Chromium's `unresponsive` event is a second trigger, since it
  fires only while input waits on the renderer.

## Trade-offs

- A heavy but alive page that stays busy for over 4 s after the user navigates away is killed
  and the navigation re-issued.
- The 20 s timeout also fires on a legitimately slow page; the previous page is one Back away
  and Retry reloads.
- A host made orderable without a frame can get its relative raise issued while the window
  server cannot yet order it (a no-op on macOS), and the later first frame does not re-drive
  stacking. A slow page that paints after the flip, and `peek://` hosts restored at cold start,
  may sit at the wrong stack position until the next restack. Narrow the `peek://` rule in
  `wireHybridContentEvents` only if a wrong stack order is seen after a restart.

## Known gaps

- A window whose first load is still pending at save time reports an empty URL and is dropped
  by the session save filter.
- A `window.open` with a garbage string and no `pageHost: true` is not a page host.
- A same-key open made while the first is inside its 2 s wait returns
  `{ success: true, id: null, reused: true }` (pending-key guard in `ipc.ts`).
- Not checked live: stop, reload and back while a native dialog is up; a loop page with a real
  click on it; whether a leave-page dialog shows when navigating away from a beforeunload page
  (the navigation itself was observed to proceed).
- While a native alert is up, the address bar is reachable only by hovering; cmd+W closes the
  alert and the window together.

## Specs

`page-host-hung-load`, `page-host-load-error`, `page-host-restore-hung`,
`page-host-internal-page-chrome`, `page-host-blocked-renderer` under
`apps/desktop/tests/desktop/`; unit tests in `apps/desktop/main/page-load-error.test.ts`.
`hybrid-close-two-hosts-hang.spec.ts` allows up to 16 transitions: a normal close is about
10, with run-to-run jitter up to 12 (also on `main`), and a runaway is 25 or more.
