# Global Hotkeys on Wayland

## Why this doc exists

On Linux/Wayland, Electron's `globalShortcut.register()` returns `false` silently for every accelerator we register (cmd's `Option+Space`, peeks' `Option+0..9`, slides' `Option+Up/Down/Left/Right`). The Wayland security model forbids apps from grabbing keys directly. This isn't a bug in our code; it's the platform.

This doc records what we tried, what we shipped, and what would have to be true for us to revisit a "real fix."

## What we ship today

Two layers in `backend/electron/shortcuts.ts`:

1. **Global path** — call Electron's `globalShortcut.register()` anyway. On macOS / Windows / X11-session Linux it works. On Wayland it returns `false`; we surface a single startup hint on the first Wayland failure (not one error per shortcut) and move on.
2. **Local fallback** — every feature that registers a global shortcut also registers the same accelerator as a *local* shortcut (`api.shortcuts.register(key, cb)` with no `{global:true}`). When a Peek window is focused, the shortcut fires regardless of platform.

So on Wayland: shortcuts work when any Peek window is focused, and don't fire when Peek is in the background. The Settings UI surfaces this in the Keyboard Shortcuts group when `api.platform.isWayland` is true.

Implementation files:
- `backend/electron/shortcuts.ts` — `isWaylandSession()`, one-time `logWaylandHintOnce()`, `registerGlobalShortcut()` dispatcher
- `backend/electron/tile-ipc.ts` — IPC entry point; suppresses per-tile error logging on Wayland
- `backend/electron/tile-preload.cts` — `api.platform = { os, isWayland }` exposed to renderers
- `app/cmd/background.js`, `features/peeks/background.js`, `features/slides/background.js` — double-register pattern (global + local fallback)
- `app/settings/settings.js` — Wayland note in core-settings Keyboard Shortcuts group

## Things we tried that don't work

### Forcing XWayland (`ozone-platform=x11`)

Tried 2026-05-05. **Doesn't help.** XWayland is not a real X11 server — it's an X11 protocol shim implemented on top of Wayland. XWayland clients still run *inside* the Wayland compositor and inherit its restrictions. `XGrabKey` can grab keys when an XWayland window is focused, but it cannot grab system-wide because there's no X server with global authority — the Wayland compositor still owns input dispatch. Side effects on Asahi: GPU process crashes (exit 139) and GTK assertion failures.

### XDG GlobalShortcuts portal (`org.freedesktop.portal.GlobalShortcuts`)

Researched 2026-05-06. **Right answer in principle, blocked by ecosystem state.** See "Implementation plan" below for the full work breakdown — kept on file for the eventual revisit. Three blockers:

1. **GNOME backend not shipping yet on the LTSes that matter.** `xdg-desktop-portal-gnome` only added GlobalShortcuts in v48 (early 2026). Fedora 42 has it; **Ubuntu 24.04 LTS ships v46** — no support. First Ubuntu LTS to ship it will be 26.04. Debian stable is far older. KDE Plasma 6 is fine. wlroots compositors (sway, river) have **no implementation at all** ([open issue since 2023](https://github.com/emersion/xdg-desktop-portal-wlr/issues/240)).
2. **`app_id` is empty for non-Flatpak apps in many launch paths.** The portal keys persistent permission grants on `app_id`. For non-Flatpak Electron, the portal infers app_id from the systemd scope name — which is `app-…` only when launched from GNOME Activities/Files. **Terminal launch, Albert, rofi, AppImage double-click → empty app_id**, which means the consent prompt re-fires every launch. ([GNOME developer post on this exact problem](https://blogs.gnome.org/ignapk/2025/06/04/using-portals-with-unsandboxed-apps/) — 2025-06.) The proposed fix ("host app registry") needs Electron upstream to adopt it; [Electron #38288 is closed as not planned](https://github.com/electron/electron/issues/38288).
3. **Library side is fine** — `@homebridge/dbus-native` is pure-JS, actively maintained, no native rebuild. Not the bottleneck.

## When to revisit

Two conditions both need to be true:

- **Ubuntu 26.04 LTS** lands with `xdg-desktop-portal-gnome ≥ 48` as the floor (~April 2026)
- **Electron upstream** adopts the host app registry handshake so app_id is stable regardless of launch method (no current ETA)

Until then, the local-fallback Peek already has is a better experience than a portal that re-prompts on every launch.

---

## Implementation plan (for the eventual revisit)

Keep this section in sync with `backend/electron/shortcuts.ts` if any of the file paths shift.

### A. Feasibility verification — what to re-check first

- Portal version availability on the **then-current** Ubuntu/Fedora/Debian LTS. The doc above is dated 2026-05; numbers shift. `busctl --user introspect org.freedesktop.portal.Desktop /org/freedesktop/portal/desktop` will show whether `org.freedesktop.portal.GlobalShortcuts` is implemented.
- Compositor support: mutter (when paired with portal-gnome 48+) and kwin both genuinely grab keys. Hyprland's portal supports it. Confirm wlroots situation (sway/river) hasn't moved — last checked, no.
- App identification: this is the deal-breaker. The portal infers app_id from the systemd scope name. Test before committing to the work — see step 1 of the implementation order.

### B. Library choice

**`@homebridge/dbus-native`** over `dbus-next`:
- `dbus-next` last released Oct 2021. Stale.
- `@homebridge/dbus-native` actively released, 100% JS, no native build, MIT, supports signal subscription via EventEmitter, ARM-aware, used in Homebridge production.

### C. Integration design

#### Module layout

New file `backend/electron/portal-shortcuts.ts` exporting:

```ts
async function initPortalShortcuts(): Promise<PortalClient | null>
class PortalClient {
  async register(shortcut: string, callback: () => void): Promise<Error | undefined>
  async unregister(shortcut: string): Promise<void>
}
```

`shortcuts.ts` `registerGlobalShortcut` becomes a dispatcher: on Wayland, prefer the portal client if `initPortalShortcuts()` returned non-null; else fall through to current `globalShortcut.register` (which silently returns false on Wayland — fine, callers already handle this via local fallback).

#### Activation flow

Portal `Activated(o session_handle, s shortcut_id, t timestamp, a{sv} options)` signal arrives on the D-Bus connection. Maintain a `Map<shortcut_id, callback>` in the portal client. The callback is the same JS closure that was passed in from the renderer via IPC at `tile-ipc.ts` — already in the main process, so no extra plumbing.

#### Session lifecycle

One session for the whole app lifetime. Create lazily on first `register` call so we don't pay D-Bus startup cost or trigger consent for users who never set a global hotkey. Persist `session_handle` in memory only — the portal handles persistence across launches via app_id.

If the bus connection drops mid-session: queue registrations, attempt reconnect with exponential backoff capped at 30s, log once. Don't crash. (`@homebridge/dbus-native` exposes `connection.on('error')` and `'end'`.)

#### Shortcut ID mapping

Portal works with stable string IDs and "preferred trigger" suggestions in `org.freedesktop.GlobalShortcuts.Trigger` form (e.g. `LOGO+space`). Translate Peek's accelerator strings (`Option+Space`, `CommandOrControl+1`) at the boundary. Use the accelerator string itself as the shortcut_id for stability — the user's stored grant survives across launches because the ID is stable.

#### First-launch consent UX

Don't trigger eagerly. Trigger on the first user action that requires it (opening the cmd panel via tray click) and surface a one-time toast: "Peek wants to use a global hotkey — your desktop will ask permission once." This avoids a hostile dialog appearing during first launch with no context.

#### Fallback layering

Current code in `app/cmd/background.js`, `features/peeks/background.js`, and `features/slides/background.js` already registers the same shortcut as both global and local. **Keep this.** On Wayland-without-portal-backend: global call no-ops, local call works when a Peek window is focused. The new portal path slots in cleanly above this.

### D. Risks (sorted by severity)

1. **app_id is empty/unstable for terminal-launched and many launcher-launched cases** → consent re-prompt per launch. **Test:** instrument the portal client to log the parsed app_id on every CreateSession call across (a) `.desktop` double-click in GNOME Files, (b) Activities search launch, (c) Albert launch, (d) `electron .` from terminal, (e) AppImage double-click. If any common path yields empty, abandon.
2. **Older LTSes still in support window** → silent failure on the largest single Linux desktop deployment. **Test:** `busctl --user introspect org.freedesktop.portal.Desktop /org/freedesktop/portal/desktop | grep GlobalShortcuts` on the target distro. If absent, fall back without nagging.
3. **wlroots compositors (sway/river) may still have no portal at all.** **Test:** same `busctl introspect`. Detect and route to the local-only path.
4. **`@homebridge/dbus-native` consumed in an Electron main process — D-Bus socket path discovery via `$DBUS_SESSION_BUS_ADDRESS` may differ inside electron-builder AppImage / snap / deb packaging.** **Test:** package each format and verify the bus connects.
5. **Compositor consent dialog chains for many shortcuts** — peeks and slides each register N shortcuts. **Test:** register 10 shortcuts at once, count user clicks required.

### E. Step-by-step implementation order

Only proceed past step 1 if risks D.1 and D.2 prove benign for the target distro mix.

1. **Probe-only spike** (no code changes to Peek). Standalone Node script using `@homebridge/dbus-native` that calls `CreateSession`, registers `Option+Space`, listens for `Activated`. Run on the then-current Fedora / Kubuntu / Ubuntu / Hyprland. Log app_id from each environment via the 5 launch methods listed in risk D.1. **This is a kill-or-proceed gate.**
2. Add `@homebridge/dbus-native` to `dependencies` in `package.json`. Verify it survives `electron-rebuild` (it shouldn't need rebuilding — pure JS).
3. New module `backend/electron/portal-shortcuts.ts`. Implement `PortalClient` with just CreateSession + BindShortcuts + Activated subscription. No unregister yet.
4. Wire into `shortcuts.ts` `registerGlobalShortcut`: when `isWaylandSession()` and `portalClient` is initialized, route to portal; on portal failure, fall through to existing path. **Vertical slice — only `Option+Space` for the cmd panel.** Ship behind an env flag (`PEEK_WAYLAND_PORTAL=1`) for opt-in dogfooding.
5. Add Activated signal handling and the in-memory `shortcut_id → callback` map.
6. Implement unregister via the portal's session-close semantics (the portal lacks a per-shortcut unregister; in v2 you re-call BindShortcuts with the new full set). Add a debounced "rebind" pass so churn from peeks/slides reinit doesn't spam the portal.
7. Reconnect/error handling for D-Bus drops.
8. Remove the env flag, make portal the default on Wayland when introspection confirms backend availability.
9. Update `app/cmd/background.js`, `features/peeks/background.js`, `features/slides/background.js` to drop the duplicate local-fallback registration in the portal-available case (still keep it as the no-portal fallback).

### F. Bail-out criteria

Abandon if any of these is true after step 1:
- App_id is empty in any of: GNOME Activities launch, terminal launch, Albert/rofi launch.
- Consent dialog re-fires on second launch from the same launch method.
- KDE and GNOME disagree on shortcut_id syntax such that one accelerator string can't satisfy both.
- `@homebridge/dbus-native` fails to connect inside an electron-builder AppImage.

Abandon long-term if the host app registry remains the only path and Electron upstream still won't adopt it.

## Sources

- [Global Shortcuts portal docs](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.GlobalShortcuts.html)
- [xdg-desktop-portal-gnome NEWS](https://github.com/GNOME/xdg-desktop-portal-gnome/blob/main/NEWS)
- [xdg-desktop-portal-kde GitLab](https://invent.kde.org/plasma/xdg-desktop-portal-kde)
- [Using Portals with unsandboxed apps — Ignacy Kuchciński, GNOME blog 2025-06](https://blogs.gnome.org/ignapk/2025/06/04/using-portals-with-unsandboxed-apps/)
- [Electron #38288 — host app registry, closed as not planned](https://github.com/electron/electron/issues/38288)
- [xdg-desktop-portal #579 — empty app_id for host apps](https://github.com/flatpak/xdg-desktop-portal/issues/579)
- [xdg-desktop-portal-wlr #240 — no GlobalShortcuts](https://github.com/emersion/xdg-desktop-portal-wlr/issues/240)
- [@homebridge/dbus-native](https://github.com/homebridge/dbus-native)
