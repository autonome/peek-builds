# Global Hotkeys on Wayland

## Why this doc exists

On Linux/Wayland, Electron's `globalShortcut.register()` returns `false` silently for every accelerator we register (cmd's `Option+Space`, peeks' `Option+0..9`, slides' `Option+Up/Down/Left/Right`). The Wayland security model forbids apps from grabbing keys directly. This isn't a bug in our code; it's the platform.

This doc records what we tried, what we shipped, and what would have to be true for us to revisit a "real fix."

## Quick start: bind a global hotkey on Wayland

1. Make sure Peek is running (the daemon must be up — the helper doesn't cold-start it).
2. Open your DE's keyboard-shortcut UI:
   - **GNOME**: Settings → Keyboard → View and Customize Shortcuts → Custom Shortcuts → Add (or `gnome-control-center keyboard`)
   - **KDE**: System Settings → Shortcuts → Custom Shortcuts → Edit → New → Global Shortcut → Command/URL
   - **Hyprland**: `bind = SUPER, SPACE, exec, node /path/to/peek-cli.mjs cmd-open` in `hyprland.conf`
3. Set the **Command** to the verb invocation. Peek's Settings → Keyboard Shortcuts panel has copy buttons for the exact strings, or pick one from the table below.
4. Set the **Shortcut** to whatever key you want — `Super+Space` is a good default since GNOME doesn't reserve it.

### Supported verbs

Canonical list lives in [`apps/desktop/main/cli-router.ts`](../apps/desktop/main/cli-router.ts) (`KNOWN_VERBS`). Keep this table in sync.

| Verb           | Args                       | Effect                                       |
|----------------|----------------------------|----------------------------------------------|
| `cmd-open`     | —                          | Open the command panel                        |
| `peek-open`    | `<n>` — keyNum (0–9)       | Open the peek bound to that keyNum           |
| `slide-open`   | `<edge>` — Up/Down/Left/Right (case-insensitive) | Open the slide bound to that edge |

Invocation shape:

```
node /path/to/peek-cli.mjs <verb> [args...]
```

### What goes in the "Command" field

We don't assume users have a system `node` installed (Peek's audience isn't all developers), so the helper is invoked via the bundled Electron binary in Node mode:

```
ELECTRON_RUN_AS_NODE=1 <electron-binary> <peek-cli.mjs> <verb> [args...]
```

GNOME's custom-shortcut runner doesn't expand env-var prefixes, so the actual bind is wrapped in `sh -c '…'`. **The Settings UI renders the full ready-to-paste string per verb with a copy button — use that.**

If you want to construct it by hand, the executor + helper paths vary by packaging:

| Packaging  | Electron binary                                                 | Helper path                                                              |
|------------|-----------------------------------------------------------------|--------------------------------------------------------------------------|
| Source build (`yarn start`) | `<repo>/node_modules/electron/dist/electron`     | `<repo>/scripts/peek-cli.mjs`                                            |
| `.deb` / `.rpm` install     | `/opt/Peek/peek` (i.e. `process.execPath`)        | `/opt/Peek/resources/app.asar.unpacked/scripts/peek-cli.mjs`             |
| AppImage                    | the AppImage path itself (e.g. `~/Applications/Peek.AppImage`) | `~/.local/share/peek/peek-cli.mjs` (shadow refreshed at daemon start)    |

Hand-built example (AppImage):

```
sh -c 'ELECTRON_RUN_AS_NODE=1 "/home/me/Applications/Peek.AppImage" "/home/me/.local/share/peek/peek-cli.mjs" cmd-open'
```

**Latency:** invoking Electron-as-Node is slower than vanilla Node — typically ~200–500ms per invocation, with another ~100–300ms on top for AppImage's FUSE-mount overhead. Still under the "feels bad" threshold for a key press, but if it ever does, the upgrade path is a tiny precompiled CLI binary (~150 lines of Rust).

### Disabling the socket

The socket is on by default. Toggle it off in Settings → Keyboard Shortcuts → "Enable CLI dispatch socket" — the daemon closes the socket immediately and `peek-cli` invocations start failing with exit 2. Toggle back on, the socket re-opens, no restart needed. The pref is `cliSocketEnabled` in core prefs.

### Behaviour notes

- **Profile auto-discovery**: the helper scans `${XDG_RUNTIME_DIR or ~/.cache}/peek/*/ipc.sock` and uses the first live one. Set `$PEEK_PROFILE` to pick a specific profile when multiple Peek instances run side by side.
- **Item not found**: `peek-open 7` when no peek is bound to keyNum 7 logs a warning in the daemon and silently does nothing on the user side. Same for `slide-open <edge>` when no slide is on that edge.
- **Daemon not running**: helper exits 2 with `peek-cli: no running Peek daemon found ...`. Start Peek the normal way and try again.
- **Bad verb**: helper exits 3 with `peek-cli: daemon rejected verb: invalid verb: ...`. Verbs must match `[a-z][a-z0-9-]*`.
- **Latency**: ~5–20ms total per invocation when the daemon is up. The helper is plain Node + `node:net`, no Electron startup.

## What we ship today

Three layers, all live:

1. **Global path** — call Electron's `globalShortcut.register()` anyway. On macOS / Windows / X11-session Linux it works. On Wayland it returns `false`; we surface a single startup hint on the first Wayland failure (not one error per shortcut) and move on.
2. **Local fallback** — every feature that registers a global shortcut also registers the same accelerator as a *local* shortcut. When a Peek window is focused, it fires regardless of platform.
3. **CLI verb dispatch** — the daemon listens on a Unix socket; a bundled `peek-cli` helper writes `{verb, args}` lines into it. Users on Wayland (or anyone) bind `node /path/to/peek-cli.mjs cmd-open` to a system-level keyboard shortcut in their DE settings. The OS owns the keygrab, sidestepping every Wayland restriction.

The Settings UI on Wayland surfaces the `peek-cli` invocations with copy-to-clipboard.

Implementation files:
- `apps/desktop/main/shortcuts.ts` — `isWaylandSession()`, one-time `logWaylandHintOnce()`, `registerGlobalShortcut()` dispatcher (layer 1+2)
- `apps/desktop/main/cli-socket.ts` — Unix socket server at `${XDG_RUNTIME_DIR or ~/.cache}/peek/<profile>/ipc.sock`, line-delimited JSON, stale-socket cleanup, atexit unlink, 0600 perms. `start/stop/isRunning` exposed for the runtime toggle.
- `apps/desktop/main/cli-router.ts` — verb sanitisation + publish on `cli:<verb>` topic
- `apps/desktop/main/cli-helper.ts` — resolves the helper's absolute path per packaging (source / asar-unpacked / AppImage shadow) and refreshes the AppImage shadow at daemon startup
- `apps/desktop/main/tile-ipc.ts` — IPC entry point; suppresses per-tile error logging on Wayland; `tile:app:cli-helper-path` returns the resolved helper path for the settings UI
- `apps/desktop/main/tile-preload.cts` — `api.platform = { os, isWayland }` and `api.app.getCliHelperPath()` exposed to renderers
- `apps/desktop/main/entry.ts` — calls `ensureCliHelperShadow()` at startup; reconciles socket against `cliSocketEnabled` pref on every prefs publish
- `scripts/peek-cli.mjs` — non-Electron Node CLI helper. Auto-discovers the live socket, sends one verb, exits in milliseconds. Honours `$PEEK_PROFILE` for explicit selection.
- `app/cmd/background.js` — subscribes to `cli:cmd-open`
- `features/peeks/background.js` — subscribes to `cli:peek-open`, takes `keyNum` arg
- `features/slides/background.js` — subscribes to `cli:slide-open`, takes edge arg
- `app/config.js` — `cliSocketEnabled` core pref (default true)
- `app/settings/settings.js` — `cliSocketEnabled` checkbox + verb list with copy-to-clipboard in Keyboard Shortcuts group (verb list Wayland-only; checkbox everywhere)
- `electron-builder.yml` — `scripts/peek-cli.mjs` whitelisted back into the bundle and added to `asarUnpack`; Linux targets include `AppImage` and `deb`

### Ship gaps

- **Not on `$PATH`.** Users bind to the absolute path the Settings UI shows. PATH-onto-`peek-cli` would need a `/usr/bin/peek-cli` wrapper from the deb postinst (and Snap/Flatpak equivalents); not done yet.
- **No cold-start path.** `peek-cli` exits non-zero if no daemon is listening — the user has to start Peek the normal way before binding the shortcut. Auto-launching on first verb is doable later.
- **No `peek-cli --list`** that asks the daemon for the live verb registry (the canonical list lives in `cli-router.ts:KNOWN_VERBS`; `peek-cli --help` mirrors it manually).
- **Linux + macOS only** (Unix sockets). Windows isn't broken — `globalShortcut.register` works there natively — so no urgency for named-pipe support.

## The real answer (shipped 2026-05-06): CLI verbs + DE keyboard settings

Side-steps every blocker the portal route has. Now live; see "What we ship today" above for the file map. The sections below are the original design notes, kept so the rationale for each piece survives.

The trick: don't try to grab keys at all. Expose CLI verbs that wake the running Peek and tell it what to do; let users bind those verbs to keys in their desktop environment's keyboard-shortcuts UI. The OS owns the key grab, so all the Wayland security model questions go away.

```
$ peek cmd-open
$ peek peek-open 0
$ peek slide-open up
```

User opens GNOME Settings → Keyboard → Custom Shortcuts (or KDE equivalent, or `hyprctl bind`), points the shortcut at `peek cmd-open`, and `Super+Space` (or whatever) opens the cmd panel. The shortcut binding is a system setting, not an app setting — it survives reinstalls, works across compositors, and doesn't need a portal.

### Why this dodges everything

- No `org.freedesktop.portal.GlobalShortcuts` dependency → works on Ubuntu LTS, Debian stable, sway, every distro.
- No app_id stability problem → there's no portal session to key on.
- No first-launch consent prompt → the user explicitly bound the shortcut themselves.
- No portal version skew across compositors → every DE has a custom-shortcut UI.
- Bonus: the same CLI surface is useful for scripting, voice assistants, and automation on macOS/Windows too.

### Architecture sketch

The whole point is "Peek is already running — wake it up cheaply." So skip Electron's `requestSingleInstanceLock` (which spawns a whole second Electron process just to forward argv — 300–800ms on Linux, completely defeats the point). Use a Unix socket instead: the daemon listens, a tiny CLI helper writes a verb and exits.

1. **Daemon side** (in `apps/desktop/main/`) — on app start, listen on `${XDG_RUNTIME_DIR:-$HOME/.cache/peek}/ipc.sock`. On exit, clean up. Inbound message shape: `{ "verb": "cmd-open", "args": [...] }`. New module `apps/desktop/main/cli-router.ts` maps verbs to existing dispatch paths (cmd panel open, peek/slide execute via pubsub).
2. **CLI side** — a tiny non-Electron helper bundled with the app (~100 lines of plain Node, or a small Rust binary if we want to be picky about ms). Behavior:
   - Connect to the socket. If it works: write the verb, exit. ~5–20ms total.
   - If connection fails (Peek isn't running): exec the full Peek binary in daemon mode. The daemon starts up, creates the socket, and processes the original verb. Slow path, but only once per session.
3. **Argv shape** — `peek-cli cmd-open`, `peek-cli peek-open 0`, `peek-cli slide-open up`. The CLI helper ships inside the app bundle at a stable absolute path (e.g. `/opt/peek/peek-cli` for deb, `<AppDir>/usr/bin/peek-cli` for AppImage); users bind GNOME/KDE shortcuts to that absolute path. **First ship deliberately skips packaging the CLI helper onto PATH** — saves 1–2 days of per-format packaging fiddling at the cost of "type `peek-cli` in a terminal" discoverability. Promote to PATH later if it turns out to matter.
4. **Settings UI on Wayland** — replace the current "global hotkeys unavailable" note with the verb list **and the absolute path to the bundled CLI helper** (settings UI knows it because the helper sits next to the daemon binary). Include a one-line "bind these in GNOME Settings → Keyboard → Custom Shortcuts" hint and a copy-to-clipboard affordance per verb so users don't have to retype `/opt/peek/peek-cli cmd-open`.
5. **Promote this section** in this doc from "likely real answer" to "the answer on Wayland."

### Effort estimate (escape-hatch scope)

Roughly **2 days** for the absolute-path-only version (plus an additional 1–2 days later if/when we want `peek-cli` on PATH).

- Quick (1–2 hours each): socket server + cleanup, `cli-router.ts`, settings UI update, doc update.
- Medium (half-day each): wiring verbs to existing dispatch paths through pubsub topics that cmd/peeks/slides already subscribe to (avoids main-process reaching into renderers); CLI helper itself (~100 lines Node, or ~150 Rust if we care about Node's ~50ms startup); edge cases (stale-socket cleanup, cold-start race when user spams the shortcut while daemon is starting).
- Skipped for the escape-hatch ship: AppImage / Snap / deb wrapper scripts to put `peek-cli` on PATH.

### What about Electron's `requestSingleInstanceLock`?

We don't use it for hotkey dispatch. We *might* still want it (or socket presence) as the "is another Peek already running?" check — but cheap-and-correct ways to do that exist on the socket path too (try to connect; if it succeeds, exit silently or message the running instance).

### Trade-offs vs. the local-fallback we ship today

- **Pro:** works when Peek is in the background. Local fallback only fires when a Peek window is focused.
- **Pro:** survives across all compositors and Linux distros without per-platform code.
- **Con:** user has to bind each shortcut once in their DE's settings UI. Discoverability problem — they have to read docs or hit the settings note to know.
- **Con:** N peeks × M slides × cmd = ~10+ shortcuts to bind by hand.
- **Resolution:** ship both layers. The local fallback stays as the zero-config baseline; the CLI verbs are the upgrade path for users who want true global hotkeys on Wayland today.

### Risks

- **Process spawn cost** could be worse than estimated on slow systems. Mitigation: socket-helper escape hatch above.
- **AppImage / Snap / Flatpak packaging** might not put `peek` on PATH cleanly. Need to check each format and document the absolute path users should bind to.
- **Verb stability** — once people bind shortcuts to `peek cmd-open`, we can't rename it casually. Pick names carefully on first commit.

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

Keep this section in sync with `apps/desktop/main/shortcuts.ts` if any of the file paths shift.

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

New file `apps/desktop/main/portal-shortcuts.ts` exporting:

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
3. New module `apps/desktop/main/portal-shortcuts.ts`. Implement `PortalClient` with just CreateSession + BindShortcuts + Activated subscription. No unregister yet.
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
