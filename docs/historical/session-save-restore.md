# Desktop session save/restore: implementation, history, portability, and cost

*Historical: an audit and benchmark of desktop session save and restore; not current guidance.*

## Executive summary

Peek persists a **logical window-session snapshot**, not native window objects. The current path is read → pure projection → synchronous SQLite write; restore is parse/validate → plan loading → reopen through the normal window-open handler → import saved stacking → activate one saved-focused window. This split is mostly portable. The snapshot, filters, geometry rules, workspace keys, and stack plan can be reused by another toolkit; Electron handle discovery, display queries, dialogs, window creation, load events, and native focus/stack realization cannot.

Spaces does not maintain a second session mechanism. A workspace is a keyed session row: `session/snapshot` for default and `session/snapshot:<tagId>` for named workspaces. The feature brackets save/close/restore so ambient saves cannot capture the empty interval. This unification is real and tested, but the feature's older `DESIGN.md` still contains draft-era descriptions before its later “Default Workspace” section.

Measured here, pure data work is not the practical window-count limit. On an Apple M4, 1,000 synthetic windows took about **0.51–0.59 ms median to project**, **0.47–0.52 ms to stringify**, and **0.90–1.03 ms to parse and plan saved stack order**. At 50,000 it was roughly 46–49 ms, 26–29 ms, and 55–58 ms median. The harness completed 250,000 windows (107 MB JSON) with medians of 364 ms, 186 ms, and 367 ms. That is a measured outer bound for this in-process harness, **not** evidence that 250,000 native windows are usable. Real restore is dominated much earlier by native windows, renderer processes/content, GPU compositing, network pages, and OS window management; this audit did not run the prohibited Electron GUI gate or claim GUI throughput.

## Evidence and architecture map

### Save

1. Lifecycle sources call `saveSessionSnapshot`: before-quit and signals in `main/entry.ts`, autosave in `main/session.ts`, open/close lifecycle debounce, manual commands, and Spaces' explicit workspace save.
2. `main/session.ts:buildSessionSaveWindows` joins registry entries to Electron `BrowserWindow` or hybrid `BaseWindow` facts. `readKernelOrderFacts` takes one window-kernel state read.
3. `main/session-projection.ts:serializeSession` is Electron-free. It applies visibility, modal/utility/persist/overlay/stale-tile/workspace filters; projects URL/title, restorable bounds, maximize state, context, focus and stack index; and removes blank URLs.
4. `saveSessionSnapshot` synchronously `JSON.stringify`s and writes `feature_settings` through `node:sqlite`. Metadata records clean shutdown/crash and restore counts. Named-workspace saves also refresh global pins in the default row.
5. Guards reject ambient save during restore and during the close/open gap of a workspace switch. The write remains synchronous because quit cleanup needs completion before DB closure.

The persisted contract is `SessionSnapshot` version 1 and ordered descriptor fields. `main/session-projection.test.ts` compares JSON text against a legacy oracle, intentionally catching key order, absent-vs-null, and shape drift.

### Restore

`main/session.ts:restoreSessionSnapshot` reads and parses the row, checks version and descriptors, excludes stale overlay/no-persist entries, applies global-pin policy, sorts by saved `zOrder`, hoists the focused descriptor for loading, and makes only the top five eager (`SESSION_EAGER_RESTORE_COUNT`); later page hosts are placeholders until first focus. It collapses saved geometry to the primary display, sanitizes stale/transient open parameters, and calls the normal in-process `invokeWindowOpen` seam. Every loop show is inactive. After creation, `orderRestoredWindowsBottomToTop` feeds `kernelImportStackOrder`; only the focused descriptor is activated. Hybrid first-composited-frame IPC marks a host orderable and lets the kernel re-drive stacking.

Correctness mechanisms visible in code/tests include: mid-restore and blank-URL corruption guards; source/key preservation; pre-maximize bounds migration; old snapshots with no `stackIndex`; stale tile/overlay rejection; single-display off-screen handling; global pin deduplication on workspace switch; crash-loop handling; and always-on `[session:perf]` markers for real restores. Relevant suites are `main/session.test.ts`, `main/session-projection.test.ts`, and desktop specs named `session-restore-*`, `workspace-round-trip-fidelity`, `space-workspace-page-host`, and `pin-session-restore`.

### Spaces usage

`features/spaces/background.js` resolves a real `space:default` tag, declares a default mode for newly opened windows, and adopts unassigned visible content windows. `workspaceSnapshotKey` maps default to the legacy `snapshot` row and other tags to their IDs. `openSpace` calls `beginWorkspaceSwitch`, saves and closes the outgoing content windows (except global pins), restores the target through `restoreWorkspaceSnapshot`, then calls `setActiveWorkspace` in `finally`. A never-saved named workspace opens one Spaces home window rather than every tagged item. Role-based sweeping replaced mode-tag sweeping because context can lag or be overwritten (commit `0c4ac43e`).

“Spaces” has two meanings that must not be conflated:

* the Spaces **feature** above is Peek's named-workspace/session product and is cross-platform in intent;
* macOS **Spaces** are OS virtual desktops. Their follow/anchor behavior is a window-backend concern and does not identify Peek workspaces.

## Historical attempts and outcomes

Repository evidence (commit IDs are the durable citation):

* `ba8ac482` added the restore-in-flight guard after quit during restore could overwrite a good snapshot with empty URLs. A shadow `.partial` snapshot was considered but explicitly deferred in `session.ts`; the guard plus blank-URL filtering was chosen as the smaller solution.
* `672d9f4c` removed a “fewer windows” save guard. It prevented legitimate saves after users closed windows, so count monotonicity was not a valid corruption detector.
* `e926ffee` fixed hybrid page hosts disappearing from save: `BrowserWindow.fromId` cannot resolve a hybrid `BaseWindow`. The explicit hybrid registry branch is still present.
* `922ef1d0` introduced top-five eager/deferred restore after many fully loaded webviews caused sustained GPU/WindowServer load; `ddb793fd` completed navigate-on-focus for the hybrid host. This is a qualitative historical rationale in code/commit history, not a fresh GUI measurement in this memo.
* `552d50ce`, `e810bf2e`, `36b2364c`, `1d205b04`, `aee38a6d`, and `a63df259` iterated on wrong/restored focus and startup activation. The settled rule is inactive creation in the loop and one post-loop activation.
* `486feb50` added literal stack replay; `43ad886f` reasserted hybrid ordering after first composition; `3f9f36b1` routed replay through the machine. Pre-field snapshots retain a fallback ordering.
* `43d0d4e4`, `52cb2235`, `9e08523a`, `52cf2612`, `cb39fe48`, `8fd4d6e4`, and `cedb0742` moved save/focus/order decisions from native reads and the retired state machine into the pure projection and current kernel. `docs/design/window-manager.md` §5 step 11 records the task-number collisions and says no evidence was found for further step-11 tasks; it does not prove no further defects exist.
* Spaces first had a separate workspace persistence path. `1e5b795e` unified it with session snapshots; `058216ab` and `11cfd7cd` fixed pipeline defects; `56b23f43` added defense against no-persist chrome; `ff8a033d` enforced membership at open; `0c4ac43e` fixed leaking content during switches.

Approaches not found in the repository: native macOS window restoration APIs, `NSWindow` archival, Windows Restart Manager, freedesktop session management, a Tauri implementation of this snapshot contract, incremental/delta snapshots, background-worker serialization, or transactional shadow-file promotion. “Not found” is an audit result, not a claim that they were never discussed outside git.

## Performance measurement

### Method

`apps/desktop/scripts/benchmark-session-projection.mjs` imports the compiled production `serializeSession`, `readStackIndex`, and `orderRestoredWindowsBottomToTop`. Fixtures are deterministic and include geometry, every tenth window maximized, serializable params, workspace context, one focused window, and complete kernel order. Each ordinary workload has 5 warmups and 30 measured repetitions. Three independent process runs were captured in `docs/research/session-save-restore-benchmark-results.jsonl`. The outer run uses 2 warmups and 10 repetitions.

Reproduce:

```sh
yarn workspace @peek/desktop build
node apps/desktop/scripts/benchmark-session-projection.mjs
SESSION_BENCH_COUNTS=100000,250000 SESSION_BENCH_REPEATS=10 SESSION_BENCH_WARMUPS=2 node apps/desktop/scripts/benchmark-session-projection.mjs
```

Machine/runtime: Apple M4, 10 logical CPUs, 32 GiB RAM, Darwin 25.5.0 arm64, Node 24.11.1. “Project” includes production notices and descriptors; “stringify” is snapshot JSON only; “restore plan” is JSON parse plus production stack-index read/order planning. It excludes SQLite, registry/native reads, descriptor validation and loading-order sort embedded in `session.ts`, IPC, network, renderers, native windows, compositing, focus, and stacking realization.

### Results

Ranges below are medians across the three independent runs (milliseconds):

| live-window fixture | JSON size | project | stringify | parse + stack plan |
|---:|---:|---:|---:|---:|
| 10 | 4.0 KiB | 0.012 | 0.005 | 0.011–0.012 |
| 100 | 39.7 KiB | 0.051–0.053 | 0.044–0.047 | 0.095–0.097 |
| 1,000 | 404 KiB | 0.510–0.590 | 0.470–0.516 | 0.902–1.029 |
| 10,000 | 4.00 MiB | 6.38–6.54 | 5.06–5.35 | 9.74–10.26 |
| 50,000 | 20.27 MiB | 45.66–48.71 | 25.65–28.97 | 55.06–57.51 |
| 100,000 (outer) | 40.60 MiB | 98.85 | 53.89 | 105.98 |
| 250,000 (outer) | 102.46 MiB | 363.79 | 185.71 | 366.71 |

The ordinary runs are approximately linear over realistic counts. Stack planning has a sort and is asymptotically O(n log n), though already ordered fixture data is favorable to the engine's sort. Projection builds maps and is O(n), except stale extension lookup uses `registeredTileIds.includes`; the tile set is small in practice. Memory and event-loop pause, not compute throughput alone, become material at the 107 MB outer fixture.

### Defensible outer-bound interpretation

The **measured harness bound** is 250,000 descriptors: it completed repeatedly without failure, but consumed a 107 MB serialized snapshot and imposed hundreds of milliseconds of main-thread work per phase. The benchmark did not seek an allocation-crash point because that would describe this machine's heap configuration, not a product limit. A practical data-layer budget is therefore comfortably beyond tens of thousands on this hardware, while a reasonable event-loop goal would keep synchronous save well below that.

The **application bound is unknown and necessarily far lower**. Restore creates one native host per descriptor and eagerly loads five content surfaces; even deferred hosts consume native/WebContents resources. Existing production logs can measure `window-open`, `restore-end`, first DOM-ready and `all-loaded`, but no controlled GUI run was performed here. Consequently this memo supports “projection/serialization is unlikely to bottleneck normal sessions,” not “Peek supports N native windows.” For a product limit, run a separate isolated-profile GUI harness at 10/25/50/100 windows and record RSS, WindowServer/GPU use, focused-window time, restore loop, all-loaded tail, failures, and teardown; native-window throughput must be reported separately by OS.

## Portability and layering

| Layer | Current implementation | Portability |
|---|---|---|
| Domain contract | `SessionSnapshot`, `WindowDescriptor`, context, workspace key | JSON/toolkit-neutral; Electron rectangle types are compile-time leakage that should become a neutral `Rectangle` type. |
| Pure projection/planning | `session-projection.ts`, `session-save-filter.ts` | Runtime Electron-free and directly portable to Node/another JS host; a Rust backend needs a faithful port or shared schema/conformance fixtures. |
| Window state authority | `window-kernel.ts` and `WindowBackend` effects | Deliberately toolkit/OS neutral. `setDesktopMembership(follow|anchor)` may no-op where absent. |
| Orchestration/persistence | `session.ts`, synchronous `node:sqlite`, crash metadata | Policy is reusable; module is Electron-bound and must be adapted. SQLite row layout is portable. Synchronous quit semantics differ by toolkit/OS. |
| Creation/presentation | `invokeWindowOpen`, BrowserWindow/hybrid registries, `screen`, load events | Electron-specific. Tauri must implement enumerate/open/show/focus/load-ready/orderable/display adapters. |
| Spaces feature | JS tile API calls to generic session/context/window capabilities | Feature logic can be shared if another backend supplies the same tile API. Current `apps/tauri-desktop` exposes basic window commands but grep finds no session restore/workspace implementation. |
| Native realization | `electron-window-backend.ts` | Replace per toolkit and OS. The kernel contract should stay unchanged. |

Cross-OS persistence is structurally plausible because URLs, params, contexts and rectangles are ordinary JSON. It is not byte-for-byte behavior portability: absolute coordinates and work areas differ, current restore deliberately collapses all windows to the primary display, native maximize/fullscreen/focus semantics differ, and role-specific desktop membership is macOS-only today. Snapshot interchange between machines also presumes the same tile IDs, URL handlers, profile data, and permissions; there is no sync/export protocol for snapshots in evidence.

Electron on macOS is the only fully implemented backend in this path. On Windows/Linux, session data and normal Electron window creation work, while `spacesPolicyForRole` returns `none` and desktop membership no-ops. Tauri desktop has a separate Rust window registry and basic open/close/hide/show/list bridge, but no evidence of this session pipeline; porting requires an adapter, not merely copying the JSON file. Another toolkit can reuse the architecture if it can report authoritative visibility/bounds/maximize/order/focus and realize inactive creation plus post-loop stack/focus.

## Direct OS and toolkit reach-arounds

Audit scope: session files, Spaces feature, window port and their cited call paths.

1. `session.ts` imports Electron `BrowserWindow`, `dialog`, `screen`, and `ipcMain`; it resolves live BrowserWindows separately from hybrid BaseWindows, uses primary-display/work-area APIs, presents crash recovery, and consumes a private `hybrid:first-frame` IPC. These are toolkit reach-arounds around the otherwise pure layer, not direct AppKit/Win32 calls.
2. `electron-window-backend.ts:setDesktopMembership` directly invokes Electron's macOS `setVisibleOnAllWorkspaces`. Anchor is a required `true` then `false` pulse; `skipTransformProcessType` prevents activation-policy flashing and `visibleOnFullScreen` supports full-screen Spaces. This ordered workaround is correctly below `WindowBackend.setDesktopMembership`.
3. `electron-window-backend.ts:attachSpaceChangeListener` subscribes through Electron `systemPreferences` to the AppKit notification string `NSWorkspaceActiveSpaceDidChangeNotification`. It is Darwin-only; observed `userInfo` is empty, so it logs but stores no Space identity and reasserts nothing.
4. Hybrid first-frame ordering compensates for macOS native orderability: relative raises can no-op until content has composited. The renderer's first-frame IPC feeds the neutral kernel. This is an OS-behavior reach-around even though no AppKit symbol is called at that point.
5. Persistence uses `node:sqlite` synchronously and profile filesystem locations selected in `entry.ts`; it does not call an OS session manager.
6. Spaces' border uses only exposed tile window/context/pubsub APIs. No `child_process`, Objective-C/Swift, AppleScript, Win32, X11/Wayland command, native addon, or shell reach-around was found in `features/spaces/` or the session modules.

The public tile API still accepts Electron option names for compatibility (`visibleOnFullScreen`, `skipTransformProcessType`), but `tile-ipc.ts` intentionally discards them and translates only to neutral follow/anchor intent. That is residual API vocabulary leakage, not a bypass of the kernel.

## Risks, gaps, and recommendations

1. **Measure the real limit next.** Add an opt-in, isolated-profile GUI workload (not a default test) and report OS/native and renderer costs separately from this harness. Use existing `[session:perf]` markers.
2. **Extract restore planning.** Validation, loading-order selection, option cleaning, and stack planning remain embedded in Electron-bound `session.ts`; moving them to a pure module would make fuller benchmarks and Tauri conformance possible without duplicating algorithms.
3. **Publish a versioned neutral schema.** Replace `Electron.Rectangle` in pure type signatures, define tolerant migrations, and run the same JSON fixtures against Electron and future Tauri adapters.
4. **Add atomic persistence only if evidence warrants it.** SQLite `INSERT OR REPLACE` is atomic at row level and current guards address known corruption. A shadow protocol adds recovery complexity; do not revive it without a demonstrated failure.
5. **Clarify names and docs.** Distinguish Peek workspaces from macOS Spaces in APIs/docs, and reconcile the draft-era top of `features/spaces/DESIGN.md` with its implemented later sections.
6. **Keep native workarounds behind the port.** The true/false Space pulse, AppKit notification, orderability workaround, display policy, and focus realization must not migrate into projection or feature code.
