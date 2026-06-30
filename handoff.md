# Handoff — `tag` command wrong-page fix: COMPLETE (all follow-ups closed)

## Goal
The `tag <name>` command in the Peek desktop app (Electron, `apps/desktop/`) was
tagging the **wrong page** under the hybrid page-host: it tagged whichever window
sorted last by id instead of the page the user was viewing. The core fix shipped
(`9039383e`). All follow-ups are now closed, including the live GUI confirmation.

## Current state — ALL DONE
- **Core fix — DONE, shipped** (`9039383e`). Root cause + fix recap below under
  "Decisions & gotchas".
- **Follow-up 2 — DONE, committed** (`01923416`): removed the dead canvas-era
  fallback in `getActiveWindow()`.
- **Follow-up 3 — DONE, committed** (`ef1b857d`): rewrote the stale
  `tag-command.spec.ts` into a real command-path / window-targeting test.
- **Follow-up 1 (live GUI verification) — DONE, confirmed 2026-06-30.** Ran the
  dev app visibly (dev profile, restored session held 8 real hybrid web-page
  hosts, ids 3–10 — exactly the multi-hybrid scenario the bug mis-targeted). The
  exact fixed function `api.window.getFocusedVisibleWindowId()` returned a LIVE
  focused id (not null, not the highest-id fallback) when probed via
  `peek-cli debug-eval` against the background window. The user then visually
  confirmed in the GUI that `tag` lands on the focused page. **No code change —
  verification only.** Nothing left to do.
- **Handoff doc commits** (`31dde5c6`, `456eb187`, + this closeout).
- All code + this handoff are committed; working copy clean (`jj status`).
  Nothing pushed — pushing requires explicit user ask
  (`scripts/push-main.sh --yes`), do NOT push unprompted.
- **Full gate green** except one unrelated load flake (details under "How to
  verify"). The flake is NOT from these changes.

Commit stack on top of `main@tangled` (newest first):
```
31dde5c6  docs(handoff): record tag-command follow-ups 2 & 3 done, gate green
ef1b857d  test(tags): rewrite tag-command spec to pin window targeting
01923416  refactor(tags): drop dead canvas-era fallback in getActiveWindow
9039383e  fix(desktop): tag command targets the focused hybrid page, not the highest-id window
```

## Next steps — NONE (work complete)
No remaining work on the `tag` wrong-page fix. The four items above (core fix +
three follow-ups) are all done and committed; the live GUI confirmation closed
the last one on 2026-06-30. This doc is now historical.

If the wrong-page bug ever RECURS, the suspect is the resolver chain — start at
`apps/desktop/main/tile-ipc.ts:3531` (the `tile:window:get-focused-visible-id`
IPC handler) and `apps/desktop/main/izui-roles.ts:438`
(`resolveFocusedVisibleWindowId`), and get a live `fs-diag` trace per the
"LESSON" in `apps/desktop/CLAUDE.md` (headless can't observe the macOS
first-responder interaction) rather than editing blind.

## Key files & paths

- `apps/desktop/features/tags/background.js:69 getActiveWindow()` — resolves the
  window the `tag`/`untag` command acts on. **Follow-up 2 simplified this:** it
  now returns the focused-visible resolver's window or `null`; the old
  `isPageCanvasUrl` filter + highest-window-id fallback are GONE. Invariant the
  reader must not break: do NOT reintroduce any "pick the newest/highest-id
  window" fallback here — that silent guess is exactly what tagged the wrong
  page. Failing loud (`null` → command returns "No active window") is intended.
- `apps/desktop/features/tags/background.js:184 executeTag(ctx)` — the `tag`
  command handler. Calls `getActiveWindow()` → reads `.url` → `findItemByUrl`
  (`:82`, normalizes via `api.datastore.findUrlItem`) → creates the item if
  missing → links tags. Returns `{ success, added, existing }` (add mode) or
  `{ success, removed }` (`-r` remove mode) or `{ success, tags }` (no args).
- `apps/desktop/main/izui-roles.ts:438 resolveFocusedVisibleWindowId(...)` — PURE
  (no Electron) resolver. This is where the actual bug fix lives. Resolution
  order: tracked id (if live BrowserWindow OR live hybrid host) → focused
  BrowserWindow → active hybrid host → first visible+focusable live window →
  null. The hybrid-host branch is the fix: a tracked hybrid id (a `BaseWindow`,
  invisible to `getLiveWindow`/`getFocusedWindow`) is now accepted instead of
  discarded. Keep this Electron-free (unit-tested under `ELECTRON_RUN_AS_NODE`).
- `apps/desktop/main/tile-ipc.ts:3531` — the `tile:window:get-focused-visible-id`
  IPC handler that `api.window.getFocusedVisibleWindowId()` calls. Gathers the
  six inputs and delegates to `resolveFocusedVisibleWindowId`. The bug was here:
  it previously validated the tracked id only via `getLiveWindow()` (blind to
  hybrid hosts) and returned null.
- `apps/desktop/main/tile-ipc.ts:2868` — the `tile:window:list` handler's hybrid
  loop. Confirms hybrid page-hosts ARE enumerated by `api.window.list()`, so once
  `getActiveWindow()` has the focused id it can find the window object. Don't
  assume hybrid hosts are absent from the list.
- `apps/desktop/main/izui-roles.test.ts:396` — `describe('resolveFocusedVisibleWindowId …')`,
  8 pure unit cases incl. the hybrid-tracked-id-wins case and the null case. This
  is the DETERMINISTIC home for the fix logic (real hybrid focus is unobservable
  headless). Runs in the main-process unit runner.
- `apps/desktop/tests/desktop/tag-command.spec.ts` — REWRITTEN this session. Two
  tests: `:114` "tags the FOCUSED window URL and leaves a co-open window
  untouched" (write side), `:135` "no-arg `tag` reflects the FOCUSED window tags"
  (read side). See "Decisions & gotchas" for why it focuses the *newest* window.
- `apps/desktop/tests/desktop/command-execution.spec.ts` — pre-existing; drives
  `cmd:execute:tag` but its assertions are deliberately TAG-CENTRIC
  ("getActiveWindow may return a different window") — it never pins which
  window's URL got tagged. That gap is what the rewritten spec fills.
- `apps/desktop/tests/desktop/window-targeting.spec.ts:29` — proves the focus
  tracker is drivable/observable headless via `api.window.focus(id)` + ~200ms
  settle, for the newest-focused BrowserWindow. The rewritten spec models this.
- `apps/desktop/CLAUDE.md` — the "Hybrid page-host" section + the load-bearing
  "LESSON" about headless being unable to observe macOS first-responder /
  `globalShortcut` interactions. Read before touching the focus path.

## Load-bearing snippets (current ground truth)

`getActiveWindow()` after follow-up 2 — `apps/desktop/features/tags/background.js:69`:
```js
const getActiveWindow = async () => {
  const result = await api.window.list({ includeInternal: false });
  if (!result.success || !result.windows.length) {
    return null;
  }
  const focusedId = await api.window.getFocusedVisibleWindowId();
  if (!focusedId) return null;
  return result.windows.find(w => w.id === focusedId) ?? null;
};
```

Pure resolver (the fix) — `apps/desktop/main/izui-roles.ts:438` (verbatim):
```ts
export function resolveFocusedVisibleWindowId(
  trackedId: number | null,
  trackedIsLiveWindow: boolean,
  trackedIsHybridWindow: boolean,
  focusedBrowserWindowId: number | null,
  activeHybridWindowId: number | null,
  firstVisibleFocusableLiveId: number | null,
): number | null {
  if (typeof trackedId === 'number' && trackedId > 0) {
    if (trackedIsLiveWindow || trackedIsHybridWindow) return trackedId;
  }
  if (focusedBrowserWindowId != null) return focusedBrowserWindowId;
  if (activeHybridWindowId != null) return activeHybridWindowId;
  if (firstVisibleFocusableLiveId != null) return firstVisibleFocusableLiveId;
  return null;
}
```

How a test drives `cmd:execute:tag` and reads the result (pattern used by both
`tag-command.spec.ts` and `command-execution.spec.ts`):
```js
const resultTopic = `cmd:execute:tag:result:${unique}`;
api.subscribe(resultTopic, (r) => resolve(r));
api.publish('cmd:execute:tag', { search: '#foo', params: [], expectResult: true, resultTopic });
```

## Decisions & gotchas
- **Root cause of the original bug:** `tile:window:get-focused-visible-id`
  validated the tracked id only via `getLiveWindow()` (blind to hybrid
  `BaseWindow` page-hosts), so it discarded the correct focused-hybrid id and
  returned null. `getActiveWindow()` then hit its now-removed highest-window-id
  fallback and tagged the wrong window. Fixed by the pure resolver + handler
  delegation.
- **Why the rewritten spec focuses the NEWEST window:** headless can reliably
  drive AND observe the focus tracker only for the most-recently-focused
  BrowserWindow. Refocusing an OLDER window *backward* with `api.window.focus()`
  does NOT settle the tracker headless (observed this session — the "focus a"
  variant failed with tracked=higher-id). So the spec opens `other` first,
  `focused` second (newest), focuses it, and asserts the tag lands on `focused`'s
  URL and not `other`'s. It does NOT (cannot, headless) reproduce the exact
  hybrid-host + highest-id bug — that stays covered by `izui-roles.test.ts:396`.
- **Handoff-claim correction from the prior session:** "real focus is
  unobservable headless" is too broad. Precisely: the TRACKER is observable
  headless for the newest-focused BrowserWindow; only (a) backward refocus and
  (b) hybrid-BaseWindow focus events are unobservable. The new spec relies on (a-
  not-b) being usable.
- **Test URL choice:** the rewritten spec opens two `peek://app/settings/settings.html?tagwin=…`
  windows with `role:'workspace'` (distinct query strings). Reasons: `role:'workspace'`
  avoids the hybrid page-host open path (which `await`s `loadURL` and would FAIL
  on an unresolvable `*.example.com` host — that's why several
  `command-execution.spec.ts` tests `test.skip` under hybrid); `peek://` loads
  with no network; the query string makes two distinct items via `findUrlItem`
  normalization (which preserves/reorders query, doesn't strip it).
- **jj workflow (NOT git):** commit with `jj commit <path> -m '…'`; never
  `git commit/push/rebase` (corrupts jj state). `main` only moves via
  `scripts/push-main.sh`/`scripts/finalize-isolated-clone.sh` — never manually
  `jj bookmark set main`. Don't push unless the user explicitly asks.
- **Bash discipline:** ONE command per call, no `&&`/`;`/`|`/`` ` ``/`$()` outside
  single quotes (a hook blocks them). `sed -i` is blocked — use the Edit tool.

## How to verify
- **Fast inner loop (the two new tag tests, source-only, headless):**
  `yarn test:desktop:electron` is the full gate; for just these:
  `yarn test:grep "Tag Command"` → expect both pass (the pre-existing
  `command-execution.spec.ts` "creates item if none exists" shows as skipped
  under hybrid — that's expected, not a regression).
- **Resolver units:** `yarn test:grep "resolveFocusedVisibleWindowId"` (pure,
  in the main-process unit runner).
- **Full gate:** `yarn test:desktop:electron` (~10 min, 6 runners). Last run this
  session: main-process unit **2214 pass / 0 fail**, node unit **654 / 0**,
  desktop Playwright **364 pass / 1 fail / 75 skip**, desktop-serial **40**,
  components **57**, editor **91**. The ONE failure was
  `hybrid-overlay.spec.ts:1969` ("hold-to-drag: navbar background HOLD then move
  publishes page:set-bounds and moves the host") — a timing-sensitive
  synthetic-input drag gesture, **unrelated to the tags changes**, and it
  **passes in isolation**: `yarn test:grep "hold-to-drag: navbar background HOLD"`.
  Treat the gate as green for this work.
- **Running the gate in background:** do NOT use `yarn test:desktop:electron:bg`
  in an agent session — its `nohup` detach gets reaped when the tool call
  returns, leaving a 0-byte `/tmp/test-electron.log` (hit this exact trap this
  session). Instead run `yarn test:desktop:electron` via the Bash tool's
  `run_in_background: true` so the harness tracks it and notifies on completion.
- **Live (the open follow-up):** see Next Steps step 1 — needs a visible/dev
  session; use the peek-bg-run skill, and respect the no-surprise-focus rule.
