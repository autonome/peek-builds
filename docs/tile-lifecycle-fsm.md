# Tile Lifecycle FSM + Manifest Cache

Status: design, pre-implementation. Tracks the policy hammered out in the
2026-04-22 session. All prior `launchTile` vs `window-open` divergence,
silent `noun:register-batch` allowlist drops, and spinner-hang-on-
unloaded-tile bugs are instances of drift from this policy.

## Goals

1. A single code path for creating any tile window, regardless of whether
   it's loaded eagerly at boot, lazily on demand, or re-loaded after a
   crash. Timing controls *when*, never *how*.
2. Static manifest declarations (commands, nouns, shortcuts,
   capabilities, lazyEvents) surface without the owning tile running.
   They're cached at install/update and read from the cache by the
   cmd panel, shortcut registry, and event interceptors.
3. Dynamic registrations require a live tile (state ≥ `ready`) and are
   scoped to its lifetime.
4. Cmd/noun dispatch to a tile ensures the tile is loaded, or surfaces
   an error — never a silent hang.
5. Lifecycle drift is detectable at runtime (dev assertions) rather
   than presenting as silent bugs downstream.

## States

| State | Meaning |
|---|---|
| `unregistered` | Never installed, or explicitly removed. No entry in `manifest_cache`. |
| `registered` | Manifest parsed + cached. Static declarations wired into main-process registries. Tile renderer NOT loaded. |
| `loading` | `BrowserWindow` created, tile URL loading, awaiting the renderer's `tile:ready` publish. |
| `ready` | Renderer initialised, capability token validated, dynamic registrations accepted. Window not shown. |
| `visible` | `ready` + window currently on screen. |
| `unloading` | Shutdown sequence in progress (`ext:{id}:shutdown` grace window → token revoke → window close → subscription cleanup). |
| `crashed` | Render process exited unexpectedly. Awaiting cleanup or auto-relaunch. |

## Transitions

```
                    ┌──────────────────────────────┐
install             │                              │
  ┌───────▶ unregistered ─────uninstall────────────┤
  │                │                               │
  │                │ parse-manifest                │
  │                ▼                               │
  │           registered ◀───────── unloading ◀────┤
  │                │                               │
  │       load trigger (eager OR dispatch)         │
  │                ▼                               │
  │           loading ───render-gone───▶ crashed ──┤
  │                │                        │      │
  │       tile:ready                        │      │
  │                ▼                        │      │
  │           ready ◀───hide────── visible  │      │
  │                │ │              ▲  │    │      │
  │                │ └──show────────┘  │    │      │
  │                │                   │    │      │
  │                ├───────────────────┤    │      │
  │                │ disable/quit           │      │
  │                ▼                        │      │
  └───────── unloading ◀────────────────────┘      │
                   │                               │
                   └───────────────────────────────┘
```

Allowed transitions (explicit table):

| From | Trigger | To |
|---|---|---|
| `unregistered` | install / discover manifest | `registered` |
| `registered` | eager boot (resident) OR lazy dispatch | `loading` |
| `registered` | uninstall | `unregistered` |
| `loading` | renderer `tile:ready` | `ready` |
| `loading` | render-process-gone | `crashed` |
| `ready` | show / showSelf | `visible` |
| `visible` | hide / hideSelf | `ready` |
| `ready` \| `visible` | shutdown (disable, quit, manual unload) | `unloading` |
| `ready` \| `visible` | render-process-gone | `crashed` |
| `unloading` | cleanup done, still installed | `registered` |
| `unloading` | cleanup done, being uninstalled | `unregistered` |
| `crashed` | cleanup done (no auto-relaunch) | `registered` |
| `crashed` | auto-relaunch policy fires | `loading` |

## Invariants

1. **Static declarations are wired only on `unregistered → registered`.**
   Cmd panel / shortcut registry / lazyEvents read them from the
   manifest cache. Tiles need not be loaded for their declared commands
   to appear.
2. **Dynamic registrations (via `api.commands.register()` etc.) are
   accepted only in `ready` or `visible`.** Publishes arriving
   outside those states → rejected with a violation event (not silent
   drop).
3. **Window creation occurs only on `registered → loading`.** No tile
   URL is ever loaded by a raw `new BrowserWindow` bypassing the FSM.
   Peek chrome (frameless where applicable), role resolution, session-
   registry entry, tracking, and custom menu are all applied in this
   transition — same code regardless of trigger.
4. **`tileWindows` registry is populated on `loading → ready` and
   cleared on `→ registered` / `→ unregistered` / `→ crashed`.**
5. **Command dispatch requires target state `≥ ready`.** If the target
   is in `registered`, the dispatcher forces `registered → loading →
   ready`, then dispatches. If the load fails (timeout, error), the
   dispatch rejects with an error — not a pending spinner.
6. **Manifest cache is the single source of truth for static decls.**
   Writes happen only at install / update. Reads happen from many
   places (cmd panel, shortcut registry, lazyEvents, Features pane).
7. **Manifest cache is empty in ephemeral profiles (`tmp-*`) on boot.**
   First-boot behavior: discover manifests, parse, populate. No cross-
   session state.

## Drift detectors (dev-mode assertions)

These fire in dev (DEBUG=1) and in test runs. In production they
degrade to a log entry and a `tile:drift` GLOBAL pubsub so a
monitoring widget can surface them.

- **Pubsub-without-ready.** A `cmd:register` / `noun:register-batch`
  publish whose source tile is not in `ready`/`visible` → violation.
  Catches the case where a tile publishes before `tile:ready` or after
  `unloading` starts.
- **Off-path window creation.** A `BrowserWindow` whose URL is
  `peek://{id}/...` created outside a `registered → loading`
  transition → violation. Catches code that bypasses the unified
  create path.
- **Dispatch-without-ready.** A `cmd:execute:{name}` publish to a
  tile whose target is in `registered` without a pending
  load-on-dispatch promise → violation. Catches handlers that send
  into the void.
- **Cache/code mismatch.** At `loading → ready`, the tile renderer
  sends its set of dynamically-registered command names. The FSM
  compares against the manifest cache. If the cache claims a command
  the tile hasn't implemented (or vice versa), violation.
  Rationale: reload + install/update are the only ways manifests and
  code can diverge, and both should invalidate the cache.

## Manifest cache (manifest_cache table)

New table. Distinct from `features_history` (which is an immutable
audit log). This table is the current installed / discovered state.

```sql
CREATE TABLE IF NOT EXISTS manifest_cache (
  featureId TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  manifest TEXT NOT NULL,           -- parsed manifest as JSON
  commands TEXT,                    -- array of command declarations
  nouns TEXT,                       -- array of static noun declarations
  shortcuts TEXT,                   -- array of shortcut bindings
  capabilities TEXT,                -- resolved capability grant shape
  lazyEvents TEXT,                  -- array of {topic, command}
  updatedAt INTEGER NOT NULL,
  disabledAt INTEGER                -- null = enabled
);
```

Write path (single): `featureInstallOrUpdate(manifestPath)` — parses,
validates, writes row. Only call-site is the feature-installer and the
boot-time manifest discovery pass.

Read paths:
- Cmd panel / cmd registry: `listCommandsForPanel()` → merges
  declared commands from every enabled row with any dynamic
  registrations from currently-ready tiles.
- Shortcut registry: `registerDeclaredShortcuts()` at boot.
- LazyEvents interceptor: `registerDeclaredLazyEvents()` at boot.
- Features pane: `getAllRegisteredFeatures()` lists every row.

## Ephemeral profile behavior

Profiles whose name starts with `tmp-` or `test-` treat the table as
ephemeral:
- On boot, if the table exists but the profile has never been booted
  before, it's truncated.
- Manifests are rediscovered from the filesystem.
- Dev profile (`dev`) also re-parses manifests on every boot (cache
  write is unconditional, invalidating any stale entries).

## Module layout

Policy lives where its consumers do. The pure FSM is a pure TS module
that could port anywhere; today only the main process imports it. If
a renderer ever needs policy introspection (e.g. cmd panel drift
detection surface), we'll expose a snapshot via strict IPC rather
than import the FSM file cross-process.

- `apps/desktop/main/tile-fsm.ts` — **pure** transition table + `validateTransition(from, trigger) → to | error`. No electron / node imports. Testable in isolation.
- `apps/desktop/main/tile-lifecycle.ts` — state store + enforcement engine. Wires the pure FSM to BrowserWindow events, token lifecycle, and broadcaster registration. Authoritative `tileId → state` map lives here.
- `apps/desktop/main/manifest-cache.ts` — SQLite writer + reader for `manifest_cache`. Only write call-sites: feature install path + boot-time manifest discovery. Read API exposed via strict tile IPC for cmd panel / features pane. Distinct from `apps/desktop/main/feature-registry.ts`, which stores install metadata (source, publisher, capability grants, update policy) in `registry.json`.
- `apps/desktop/renderer/cmd/background.js` — already in the core renderer; stops subscribing to `noun:register-batch` / `cmd:register` for *declared* commands (those come from the cache via IPC). Keeps the subscriptions for *dynamic* registrations from live tiles.

## Phased plan

1. **Phase A (this commit).** Design doc + pure FSM module + manifest_cache
   table + schema migration + stub enforcement engine. No behavior change;
   scaffold only.
2. **Phase B.** Parse-on-install path. Feature installer writes to
   manifest_cache. Boot-time manifest discovery does the same for
   builtins. No reads yet.
3. **Phase C.** Cmd panel / shortcut registry / lazyEvents read from
   manifest_cache. Tile publishes of declarative commands become
   no-ops (or advisory). This kills the allowlist-blocked
   `noun:register-batch` pain for declared nouns.
4. **Phase D.** Unify window creation. `launchTile` → shared window-
   open pipeline. Entities-style single-tile UIs get peek chrome.
   FSM transitions wire up to existing lifecycle events.
5. **Phase E.** Load-on-dispatch. Dispatcher ensures target state
   before sending `cmd:execute`. Timeout → reject. Spinner hangs
   become explicit errors.
6. **Phase F.** Drift detectors in dev + `tile:drift` pubsub.
7. **Phase G (stretch).** Migrate declared `open {noun}` duplicates:
   features that declare both a manifest command AND register a noun
   with the same name drop the declarative duplicate; noun registration
   is authoritative (tracked separately in
   [task #11](historical/tasks.md)).

## Non-goals

- Tauri / iOS path. This is Electron-only for now. The FSM semantics
  port to other backends later; the SQLite cache is Electron-specific
  until we unify backends.
- Changing the tile-preload API surface. `api.commands.register()`
  still exists for dynamic registrations.
- Schema migration for existing users — on the first boot after this
  lands, an empty `manifest_cache` gets populated from manifest
  files. No user-visible data loss.

## Test plan

- Unit: FSM transitions (pure function). Each allowed transition +
  every disallowed transition returns an error.
- Unit: manifest_cache round-trip (write manifest → read back
  matches).
- Integration: boot with no cache, assert cmd panel shows declared
  commands for every enabled feature before any tile is loaded.
- Integration: dispatch `open entities` from cold cmd panel when
  entities tile is `registered` (not loaded), assert tile loads and
  view opens.
- Integration: cmd panel dispatch to an uninstalled tile → explicit
  error (no spinner hang).
- Regression: current green desktop suite stays green.
