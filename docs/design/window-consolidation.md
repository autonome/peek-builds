# Window consolidation plan

A plan, not an implementation: which of the desktop app's internal windows can be merged,
dropped, or made lighter, and what each change would cost. Every claim names the file and
symbol that forces today's shape. Nothing here has been built or measured live; costs are
stated in renderer processes and native windows, not megabytes.

## What a window costs

Two separate costs hide behind "one more window":

- **A native window.** Every `BrowserWindow` or `BaseWindow` is an OS window, registered
  with the window-state machine (`window-machine.ts registerWindowWithMachine`) and listed by
  window enumeration. A hidden native window is cheap on its own; its cost is mostly
  bookkeeping and listing noise (the hidden-windows toggle in the Windows switcher lists
  them all).
- **A renderer process.** Every window with a web page in it gets its own renderer
  process. Separate top-level windows are separate browsing instances, so Chromium does not
  put two of them in one process even when they are the same site, and Electron has offered
  no app-side way to pin two windows to one process since the `affinity` web preference was
  removed (long before the `^43` this app uses, `apps/desktop/package.json`). The only way to
  share a renderer is to share one document.

So the useful questions per window are: does it need to be a native window at all, and does
it need its own document. Most of the wins below remove a renderer, not a window.

## Inventory

| Window | Address | Built by | Native window needed? | Own renderer needed? |
|---|---|---|---|---|
| Peek Auth Bridge | `chrome-extension://<id>/peek-bridge.html` | `chrome-extensions.ts _spawnBridgeWindow()` | No | Yes (extension origin) |
| peek:core:background | `peek://app/background.html` | `core-glue.ts initCore()` | No | Yes |
| Peek Page Overlay | `peek://app/page/overlay.html` | `hybrid-overlay.ts ensureOverlay()` | Yes | Yes, in practice |
| space marker (one per visited desktop) | `peek://spaces/signal.html` | `desktop-marker-manager.ts syncMarkers()` | Yes, one per desktop | **No** |
| Space Border | `peek://spaces/border.html` | `features/spaces/background.js showBorder()` | Yes | Can share with Spaces Feature |
| Spaces Feature | `peek://spaces/background.html` | lazy tile, woken by `entry.ts` publishing `spaces:ensure-default` | No | Can share with Space Border |
| Windows Extension | `peek://windows/background.html` | lazy tile | No | **No** — nothing it does needs one |
| Entities, Slides, Peeks backgrounds | `peek://<feature>/background.html` | lazy tiles | No | Yes, per tile |
| Peek HUD | `peek://app/hud/hud.html` | `renderer/index.js` `hud` command | Yes | Yes |
| Spaces | `peek://spaces/home.html` | user window | Yes | Yes |

The HUD and the Spaces home window are user-opened, visible windows; they are not resident
infrastructure and are out of scope. The handoff's pointer to
`features/spaces/background.js raiseSignalWindow()` is stale: per-desktop markers moved to
`main/desktop-marker-manager.ts` and `main/desktop-markers.ts`, and the spaces feature now
only asks for a keyed raise (`switchToSpaceDesktop()`).

## 1. Can the Auth Bridge fold into peek:core:background?

**No for sharing core's page; partly for stopping being a window.**

Why it exists. Electron does not deliver a cross-origin page's
`chrome.runtime.sendMessage(extId, …)` to the extension's service worker
(`chrome-api-polyfills/runtime-external.js`, comment on the bridge registry and
`setBridgeWindowsRegistry()`), and the service worker has no reliable `ipcRenderer` either
(the probe in the SW prelude of `runtime-external.js`, which falls back to a warning; peek
item `42fff0a5`). The workaround is a page that lives at the extension's own origin,
`chrome-extension://<runtimeId>/peek-bridge.html`, because only a same-extension page can
open `chrome.runtime.connect({ name: 'peek-auth-relay' })` to the service worker
(`chrome-api-polyfills/peek-bridge.js connect()`). Main forwards to it by
`webContents.send('peek:auth-ext:forward')`, and it answers through
`peek-bridge-preload.cjs`. The page is copied into each extension by
`scripts/patch-chrome-extensions.js` (the "Copy peek-bridge.html" step). The bridge also
hosts the extension's ISOLATED-world content scripts as singleton listeners, injected on
`did-finish-load` in `_spawnBridgeWindow()` and fed by `peek-relay.js`.

Why it cannot share core's page. Core is `peek://app/background.html`; the bridge must be
`chrome-extension://<runtimeId>/…`. Two origins cannot be one document, and an iframe at the
extension origin inside core would be a cross-site frame, which site isolation puts in its
own process anyway — no renderer saved, and core would gain an extension frame inside the
trusted orchestrator. There is also one bridge per extension that declares
`externally_connectable` (`chrome-extensions.ts`, the spawn condition in the load path), not
one per app.

Can it stop being a window. Yes, likely cheaply: every consumer touches only the bridge's
web contents — `runtime-external.js` calls `bridgeWin.webContents.send(…)` and checks
`isDestroyed()`; `chrome-extensions.ts` uses `win.webContents` for console forwarding,
crash handling, `loadURL` and `executeJavaScript`. A web contents that is never attached to
a window keeps the origin, the preload and the sandbox while dropping the native window and
its window-state-machine record (class `bridge`). Cost: one construction site changes, the
`_bridgeWindows` map and `setBridgeWindowsRegistry()` change type, and
`window-construction-gate.test.ts EXPECTED` gains a row. Saves: one native window and one
machine record per bridged extension; the renderer stays.

Risk to spike first: that Electron's extension runtime (`chrome.runtime.connect` and the
ISOLATED-script injection) works in a web contents with no owning window. Page hosts already
run extension content scripts in window-attached views, which is encouraging but not proof.

Further option, not recommended now: replace the forward relay with a service-worker preload
script (`session.registerPreloadScript` with a service-worker type; nothing in
`apps/desktop/main` uses it, so it is untried here). That
would remove the bridge page for message forwarding, but the ISOLATED content-script host
still needs a document, so the renderer would survive anyway.

What it makes harder later: nothing material. A windowless bridge is easier to keep out of
window listings and session saves than a hidden window.

## 2. Can the page overlay merge into core?

**No.**

Why it is a separate native window. The shared chrome draws outside the page host's frame:
the overlay's bounds are the host's bounds grown by gutters for the navbar, trigger zone,
resize handles and side panels (`overlay-frame.ts expandToOverlayFrame()`,
`OVERLAY_GUTTERS` — 218 px left and right, 44 px top). It must be transparent, click-through
by default, floating above the host, and never eligible for native fullscreen
(`hybrid-overlay.ts ensureOverlay()`, the `fullscreenable: false` note on the black-screen
fix). It also has to become key for typing a URL (`focusable: true`, `wireShowNavbarFocus()`).
None of that can be a view inside the host window, because the chrome would clip at the
host's edge; and core is a hidden window with none of those properties. So the overlay stays
its own native window.

Can its renderer or process be shared. Only by loading core's orchestrator into the
overlay's document (there is no process sharing between windows; see "What a window costs").
That is possible in principle — both are trusted built-ins with
`createTrustedBuiltinGrant`, so no capability boundary is lost — but:

- Identity: each renderer carries one tile id and one token bound to its web contents
  (`tile-launcher.ts registerTrustedBuiltinWindow()` → `setTokenOwner`), and pubsub keys
  subscriptions by `peek://<tileId>/<entryId>`. One document would need two identities or a
  merged one.
- Lifetime: core is `appLifetime: true` and blocks startup on `__coreReady`
  (`core-glue.ts initCore()`). The overlay can be closed and re-minted, and its re-mint
  inside a dispatch is a known hazard (`hybrid-overlay.ts ensureOverlay()`, HAZARD note).
  Merged, an overlay close would take the orchestrator with it.
- Fault and load coupling: a crash or long task in either stops both — session restore and
  pubsub fan-out in the same thread as navbar reveal animations.

Saving: one renderer. Cost: medium-to-large, touching startup order, the overlay's
lifetime and pubsub addressing. Not worth it.

Smaller alternative considered and rejected: creating the overlay lazily on the first page
host. `initHybridOverlay()` creates it at startup on purpose, so its machine registration
lands before any attach decision (the "boot seed" comment there); moving the mint back into
an event path reintroduces the race that comment describes.

## 3. Can the space markers, Space Border and Spaces Feature merge?

**Partly. The Spaces Feature and the Space Border can be one window. The markers cannot join
them, but they can drop their renderers.**

Markers. A marker is how the app moves the user to another desktop: raising a window that
sits on the target desktop is the only app-triggered desktop switch public APIs allow
(`desktop-markers.ts` module comment, `planSpaceMarkerRaise()`), and a window is placed on a
desktop only by being opened while that desktop is current (`desktop-marker-manager.ts`
module comment, "being present at open time is the only placement mechanism"). So one native
window per visited desktop is forced by the platform. The border is the opposite: it is set to
show on every desktop (`features/spaces/background.js showBorder()`,
`setVisibleOnAllWorkspaces`). A window on every desktop cannot also be the one window that
belongs to a single desktop, so markers and border cannot be one window.

What markers do not need is a page. `signal.html` is an empty transparent document; the
marker exists only to be raised. Today it is opened through the generic window-open path
(`desktop-marker-manager.ts syncMarkers()` → `invokeWindowOpen` with `MARKER_URL`), so every
visited desktop costs a renderer for nothing. A contentless native window does the same job:
the machine already accepts a registration with `contentWC: null` (`window-machine.ts
MachineWindowSpec`), and page hosts are already contentless frames before their view is
added. Cost: small — a new construction path for a contentless, non-focusable, transparent
2x2 window (backend-neutral: "open an empty window on the current desktop"; how it is built
is the Electron backend's business), a `window-construction-gate.test.ts EXPECTED` row, and
keeping the `signal` role so session saves still skip it
(`session-projection.ts serializeSession`). Risk: a contentless window must still be
raisable and accept the non-activating show (`MARKER_SHOW`); check on macOS before landing.

Spaces Feature and Space Border. Both are entries of the same `spaces` tile
(`features/spaces/manifest.json`), so they already run under the same capability grant —
putting them in one document crosses no isolation boundary. Today the background is a hidden
renderer woken at boot after a named workspace is restored (`entry.ts`, the
`spaces:ensure-default` publish), and the border is a second renderer opened and closed as
space windows gain and lose focus. The open/close cycle is the source of real complexity: the
`border` state object with `closed`/`opening`/`open` exists because concurrent opens used to
spawn a border every ~100 ms and dismiss the command palette (`features/spaces/background.js`,
the comment above `const border`).

Merged design: the background's window is the border — full primary-display size,
transparent, click-through, non-focusable, on every desktop, hidden while no space is active
or the app is inactive, shown and recolored in place instead of reopened. Requirements:

- It must not be a transient. The border today has role `overlay`, which the kernel dismisses
  when a sibling appears unless its click-through flag has landed
  (`window-kernel.ts selectTransientAutoclose`). A feature background that the kernel can
  dismiss would kill the feature; it needs a non-transient class declared at registration,
  with click-through set before the first show.
- It must follow display changes (today `showBorder()` reads `api.screen.getPrimaryDisplay()`
  on every open, which a resident window would have to redo on display change).
- The lazy-tile path launches a background hidden with default geometry
  (`tile-launcher.ts createTileBrowserWindow()`); the merged entry needs its window shape from
  the manifest entry instead, which the launcher already supports through flat entry fields.

Saving: one renderer while a space is active, and the border open/close churn with its state
machine. Cost: medium. What it makes harder later: the spaces feature's background becomes a
visible-capable window, so any future change to how backgrounds are launched has one more
special case to respect.

## 4. Which tile background pages could share one renderer?

**None across tiles. Entries within one tile can. Some backgrounds can be removed outright.**

Why tiles cannot share. Tile isolation is enforced per renderer:

- The capability token is bound to one web contents: `tile-launcher.ts
  createTileBrowserWindow()` calls `setTokenOwner(token, win.webContents.id)`, and every
  `tile:*` IPC handler cross-checks the sender against it. One document holds one token, so
  two tiles in one renderer means one tile's grant serves both — the union of their
  capabilities, which is exactly what the manifest model forbids.
- Crash and close cleanup is per tile entry: `render-process-gone` and `closed` revoke that
  entry's token and `unsubscribeAll('peek://<tileId>/<entryId>')`. A shared renderer would
  take every co-hosted tile down together and confuse the lazy-tile lifecycle
  (`tile-lazy.ts`, `tile-lifecycle.ts`).
- Each tile is its own origin (`peek://<feature>/`; the scheme is registered `standard` in
  `protocol.ts`), so iframes per tile inside one host page would be cross-site frames and get
  their own processes regardless.

Within a tile the boundary is the manifest, not the entry, so entries of one tile can share a
document without loss (that is question 3's spaces merge).

What actually reduces renderers:

- **Remove backgrounds that only register commands.** `features/windows/background.js` holds
  no state worth a renderer: one command opens the switcher with static options, and five
  call a single window operation on the focused window. `tile-lazy.ts` already short-circuits
  manifest commands with a declarative `window` action (and a `publish` action) without
  loading the tile, so the switcher command can be declarative, and the five window
  operations belong with the other core window commands. Its wake topic
  `cmd:execute:windows` is published by the Escape fallback
  (`window-escape-runtime.ts`) and the manifest shortcut, so in practice this renderer is
  woken in almost every session. The settings it loads would move to the switcher page,
  which is opened anyway.
- **Let idle backgrounds sleep.** Once woken, a lazy background stays for the session —
  `tile-lazy.ts` has a wake path but no idle unload. Entities is the clearest candidate: it
  wakes on page activity (`scripts:execute:entities-extract`) and does bounded work per
  request. Peeks and Slides are poorer candidates: their hotkeys are persisted in main so
  they would survive a sleep, but their open path is already reported slow on wake (peek
  task `9e6e91de`), and a sleep would put that cost on more presses.

## Ranked consolidations

Each is sized to be its own later track.

1. **Markers without pages.** Space markers become contentless native windows. Small. Saves
   one renderer per visited desktop. Mechanism today: `desktop-marker-manager.ts
   syncMarkers()` opens `MARKER_URL` through the window-open path.
2. **Remove the Windows feature background.** Switcher command becomes a declarative window
   action; the five focused-window commands move to core. Small to medium. Saves one renderer
   in nearly every session. Mechanism today: `features/windows/background.js
   commandDefinitions`, woken by `window-escape-runtime.ts` publishing
   `cmd:execute:windows`.
3. **Spaces background and border in one window.** Medium. Saves one renderer while a space
   is active and deletes the border open/close state machine. Mechanism today:
   `features/spaces/background.js showBorder()`/`hideBorder()` opening `border.html` as a
   separate transient overlay.
4. **Bridge without a window.** The auth bridge moves to a web contents with no owning window.
   Small, after a spike confirming the extension runtime works there. Saves one native window
   and machine record per bridged extension, not a renderer. Mechanism today:
   `chrome-extensions.ts _spawnBridgeWindow()` constructs a hidden 1x1 window.
5. **Idle sleep for lazy backgrounds**, starting with Entities. Medium (lifecycle work in
   `tile-lazy.ts` plus a per-tile opt-in). Saves renderers in long sessions; costs wake
   latency.

Not recommended: folding the bridge into core (origin), merging the overlay into core
(lifetime and fault coupling for one renderer), one window for all markers (desktop placement
is per window), and any cross-tile shared renderer (token-per-renderer isolation).

## Unverified

- No live process count or memory measurement was taken; savings are counted in renderers.
- Item 4's spike (extension runtime in a windowless web contents) and item 1's check (a
  contentless window raises and switches desktops on macOS) both need a real macOS session;
  neither can be shown on Linux.
