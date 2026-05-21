# Click-through investigation

## Current state

### `setIgnoreMouseEvents` call sites

**Only two call sites exist in the working tree:**

1. `apps/desktop/main/tile-ipc.ts:2866` — the IPC handler for `tile:window:set-ignore-mouse`. Registered at line 2845. Gated by `window.manage` capability (enforced in `apps/desktop/main/tile-window-enforcement.ts:164`).

2. `features/spaces/background.js:76` — sole renderer-side caller. Sets the Spaces border decoration window to permanent click-through (`ignore=true`, `forward=true`). Not a canvas page host.

**No call site in `app/`.** The page canvas (`app/page/page.js`), HUD (`app/hud/hud.js`), and any other overlay never call `setIgnoreMouseEvents`. There is no hit-test loop. Greenfield problem for every canvas window.

### Transparent `BrowserWindow` constructions

`apps/desktop/main/ipc.ts`:

| Line | Window | `transparent` | `frame` | Click-through? |
|------|--------|--------------|---------|----------------|
| 750 | Canvas page host (`useCanvas=true`, `http/https`/`peek://app/new-tab`) | `true` | `false` | No |
| 1328 | Webview popup | `true` | `false` | No |

`app/hud/background.js:88-95` — HUD window: `transparent: true`, `frame: false`, `alwaysOnTop: true`, `focusable: false`. `setIgnoreMouseEvents` never called.

### Candidate windows

1. **Canvas page host** — fullscreen transparent BrowserWindow. Gutters, trigger zone, drag overlay, resize handles eat clicks even when visually empty. Webview consumes its own clicks.
2. **HUD overlay** — area outside `#hud-container` is empty canvas eating clicks.
3. **Cmd panel** — transparent but click-to-dismiss. **Out of scope** — click-through breaks dismiss.
4. **Windows view / peek-card** — no dedicated overlay window; IZUI hides/shows existing windows. `peek-card` is a custom element inside other canvases. Nothing new to wire.
5. **Page widgets** — DOM elements inside the canvas with `pointer-events: auto`; the surrounding canvas window itself still eats clicks.

### Renderer-side hit-testing

Doesn't exist. No `elementFromPoint` call, no `mousemove`-driven `setIgnoreMouseEvents` toggle anywhere in `app/`.

## What we want (UX-level)

Clicks in visually-empty regions of overlay/canvas windows reach the OS app behind Peek. Specifically: gutters and margins of the page canvas, area outside `#hud-container` in the HUD, and any page-widget-absent region of a canvas page host.

## Approach

### IPC channel

`tile:window:set-ignore-mouse` already exists (`apps/desktop/main/tile-ipc.ts:2845`) and supports `{ forward: true }`. `api.window.setIgnoreMouseEvents(id, ignore, { forward: true })` is already in `apps/desktop/main/tile-api.d.ts:172`. No new IPC.

### Per-window hit-test loop

Each transparent canvas renderer adds a `mousemove` listener:

1. `document.elementFromPoint(e.clientX, e.clientY)`.
2. Check `el.closest('<whitelist>')`.
3. Empty canvas → `api.window.setIgnoreMouseEvents(undefined, true, { forward: true })`.
4. Real widget → `api.window.setIgnoreMouseEvents(undefined, false)`.

`forward: true` keeps `mousemove` flowing while ignoring clicks, which keeps the hit-test loop alive on the next frame. Track `lastIgnore` and only send on transitions — IPC is async but fire-and-forget.

### Selector whitelists

**Page canvas (`app/page/page.js`):**

```
webview, peek-navbar.visible, .resize-handle, .trigger-zone,
.widget.visible, .page-info-panel.visible, .tags-panel.visible,
.entities-panel.visible, .notes-panel.visible, .extensions-panel.visible,
.find-bar.visible, .drag-overlay.active
```

**HUD (`app/hud/hud.js`):**

```
#hud-container
```

The hit-test does not have to handle visibility class details perfectly; if the renderer keeps an in-memory `inDragging() || inResizing()` flag (already maintained in `page.js` as FSM states `DRAGGING`, `DRAGGING_OUT_OF_MAXIMIZED`, `RESIZING`), it should hold `ignore=false` while any of those are active to avoid breaking pointer capture mid-drag.

## Files to touch

| File | Change |
|------|--------|
| `app/page/page.js` | Add `mousemove` hit-test loop after DOM ready; call `api.window.setIgnoreMouseEvents` |
| `app/hud/hud.js` | Same pattern with `#hud-container` whitelist |
| `apps/desktop/main/tile-ipc.ts` | No change — handler exists |
| `apps/desktop/main/tile-api.d.ts` | No change — surface declared |

## Cross-platform notes

- **macOS**: fully supported. `forward: true` is required; without it `mousemove` stops delivering to the renderer and the hit-test loop goes blind.
- **Linux X11**: works. X11 compositors honour the `_NET_WM_STATE` hints Electron sets.
- **Linux Wayland**: fragile. Many compositors (sway, some gnome-shell configurations) do not honour the input-region protocol Electron uses. Expect click-through to silently not work. No Electron-layer mitigation; document as known limitation.
- **Windows**: works when `transparent: true` is set on the BrowserWindow. All canvas page hosts already do; no extra work.

## Risks and edge cases

1. **Drag operations**: starting a drag in a real widget then moving cursor into an empty region would fire `setIgnoreMouseEvents(true)` mid-drag and break pointer capture. Guard with the FSM state — while `inDragging() || inResizing()` (page.js), hold `ignore=false`.
2. **Trigger zone**: must remain a real-widget region even when visually empty, so hovering there still reveals the navbar. Include `.trigger-zone` unconditionally.
3. **Webview focus**: `setIgnoreMouseEvents(false)` when over the webview is correct — guest process handles the click, host renderer just doesn't discard.
4. **DevTools**: may interfere if DevTools is docked. Canvas page hosts use detach mode by default; low risk, but verify.
5. **IPC latency**: `setIgnoreMouseEvents` is async. There may be a 1–2 frame gap between entering an empty region and click-through activating. Acceptable.
6. **`forward: true` on Windows**: requires `transparent: true`. Already set everywhere we'd touch.

## Out of scope

- **Cmd panel**: transparent but click-to-dismiss; click-through would break it.
- **Settings, diagnostic, datastore-viewer**: not overlay windows; backgrounds aren't meaningfully transparent.
- **Windows view**: no separate overlay window in this codebase.
- **Wayland fix**: no Electron-level workaround exists today.
- **`-webkit-app-region` on HUD**: existing macOS drag-region CSS isn't a substitute; both can coexist.
