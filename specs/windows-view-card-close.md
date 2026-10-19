---
enabled: true
touches: [apps/desktop/features/windows/windows.js, apps/desktop/features/windows/windows.html, apps/desktop/main/tile-preload.cts, apps/desktop/main/tile-ipc.ts, apps/desktop/main/windows.ts, apps/desktop/tests/desktop/windows-view-card-close.spec.ts]
depends-on: [switcher-search-autofocus]
---

# Each card in the window switcher has a close button

Peek item `9c1c7637`. Hidden windows are listed only while the switcher's hidden-windows toggle
(`peek-button.hidden-toggle`, `state.showHidden`) is pressed; every card, including those the
toggle reveals, gets a close button.

Decision: the card's close button closes the window for good, including a `keepLive` window that
an ordinary close (Cmd+W) would only hide. Picking a window in the switcher and pressing its close
button is an explicit request to end it, and hiding would only move it out of the default list.
With the hidden-windows toggle pressed the list also includes chrome windows (the page-host
overlay, panels, space markers); their cards get no close button, since closing them is not a
user action. Only windows that pass the toggle-off filter (`CHROME_ROLES`, no `background.html`)
get one.

## What the code does now

- `features/windows/windows.js loadWindows()` loads the list once in `init()` via
  `api.window.list({includeInternal:true, includeHidden: state.showHidden})`, re-run when the
  hidden-windows toggle changes; `renderWindows()` builds one `createWindowCard(win)`
  `<peek-card>` per window (`dataset.windowId`, a "Hidden" badge when `win.visible === false`).
  Clicking a card (`card-click`) shows it if hidden, sets it as the overlay focus target, and
  closes the switcher. The empty state is `<div class="empty-state">` 'No windows open.' (or 'No
  windows match your search.' with a query).
- Nothing refreshes the list after load; `window:closed` is not subscribed in `windows.js`.
- `api.window.close(id)` (`tile-preload.cts`, `tile:window:close` in `tile-ipc.ts`, needs
  `window.manage`, which the windows tile has) calls `windows.ts closeOrHideWindow()`, which hides
  `keepLive` windows. There is no force option.

## What changes

- `tile-preload.cts` / `tile-ipc.ts`: `api.window.close(id, { force: true })` closes the target
  even when it is `keepLive`. Route it through `closeOrHideWindow` with a force flag (add one if
  it has none) so hybrid page hosts and BrowserWindows take the same path; the capability check
  is unchanged. Without the option, behaviour is unchanged.
- `windows.js createWindowCard`: a close button in the card header (`<peek-button>` or the
  component library's icon button, per `apps/desktop/CLAUDE.md`'s component rule), labelled for
  accessibility ("Close window"). Its click stops propagation so it never fires `card-click`,
  calls `api.window.close(win.id, { force: true })`, removes the window from `state.windows`, and
  calls `renderWindows()`, so the card goes away and the last close shows the empty state. The
  switcher stays open.
- Keyboard: none added in this spec.

## Tests to change

New `apps/desktop/tests/desktop/windows-view-card-close.spec.ts`, following
`switcher-select-raises-target.spec.ts` (cards are `peek-card[data-window-id="…"]`):

1. With two ordinary windows open, clicking one card's close button closes that window (it is
   gone from main's window list) and removes its card; the other card remains and the switcher
   is still open.
2. Clicking the other card's body still focuses that window and closes the switcher, without
   closing the window.
3. Closing every listed card in turn leaves the switcher showing 'No windows open.' (the test
   app may list windows besides the two it opened; close whatever is listed).
4. A `keepLive` window's card close button destroys the window rather than hiding it.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn workspace @peek/desktop test:grep "switcher|windows-view|keepLive|keeplive"
```

Done when the unit tallies report `fail 0` and the four new tests pass, with no new failure in
the other collected specs compared with `apps/desktop/tests/gate-baseline.md`. Record the
`test:grep` pass/fail count under `**Result**` in the handoff.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app. Read it before editing. Run one command per
Bash call.
