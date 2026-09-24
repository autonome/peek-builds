---
enabled: false
touches: [apps/desktop/main/window-kernel.ts, apps/desktop/main/window-kernel-executor.ts, apps/desktop/main/electron-window-backend.ts, apps/desktop/main/ipc.ts, apps/desktop/main/window-escape.ts, apps/desktop/main/window-kernel.test.ts, apps/desktop/main/window-escape.test.ts, apps/desktop/tests/desktop/cmd-url-unfocused.spec.ts, docs/design/window-rules.md]
depends-on: []
---

# A side task ends when it loses key: the page is reopened as an ordinary window

Peek item `f46a44ad`. A page opened from the command palette while another app is frontmost is a
side task (`izui-roles.ts pageOpensAsSideTask()`, `docs/design/window-rules.md` G1): built as a
non-activating window (`type: 'panel'`) so it can take typing without the app coming forward.
Electron forces every panel-type window onto all desktops and keeps it there
(`shell/browser/ui/cocoa/electron_ns_panel.mm setCollectionBehavior:` re-adds the all-desktops
bit on every set), so the page follows the user to every desktop and cannot be anchored. The
side-task design is kept; what changes is that the side task has an end, and at its end the page
becomes an ordinary window on the desktop the user is on.

## The rule

A side task is a non-activating page-hosting application window (`WindowRecord.kind ===
'page-host'`, a content role, `nonActivating === true`) that holds key while the app is inactive.
It ends the moment either happens:

- it stops being key while the app is still inactive (the user clicks the other app, presses the
  palette hotkey again, or switches desktop), or
- the app becomes active while it is key.

When a side task ends, its window is replaced by an ordinary application window showing the same
page at the same bounds: activating, anchored to the desktop it is on, not held above other apps,
shown without focus, and stacked as the frontmost of the app's windows behind the active app.
The other app keeps focus throughout. Nothing else about the page changes: it is still open, still
belongs to its workspace, still closes on a close request whether or not the app is active.

Escape on a side task closes it. There is no set-aside: the page either has key or it is closed,
the same as any other close of a page, and the other app keeps focus (F8).

The palette is unaffected: it is transient and keepLive, so losing key hides it until the next
hotkey, and as a transient it follows the user across desktops by design
(`izui-roles.ts desktopMembershipForRole()`).

## What changes

**Kernel (`window-kernel.ts`).** One new effect, platform-neutral, one intention:
`ReopenAsOrdinaryWindow { id }`. `react()` emits it when a record that is a side task (definition
above; write it as a pure predicate `isSideTask(state, record)` next to
`admitsHoldAboveOtherApps`) satisfies either end condition across a transition:

- `OsFocusLost` for that window with `state.appActive === false`, or
- `AppActivated` while that window is `state.key`.

The effect is emitted once per window; `OsFocusLost` today emits nothing and touches only `key`,
which stays true. No new state field is needed: the kernel treats the reopen as a close of the old
record followed by a registration of a new one, both arriving through the existing commands.

**Executor / backend (`window-kernel-executor.ts`, `electron-window-backend.ts`, `ipc.ts`).** The
executor realizes `ReopenAsOrdinaryWindow` by reading the record's URL, bounds and open params,
issuing `CloseOrHideWindow` for it, and re-entering the window-open path in
`ipc.ts registerWindowHandlers` with the same params minus `type`, plus the saved bounds and a
show-without-focus intent (the spelling today is `show: false`, which `assembleHybridPageHost`
turns into `showHybridHost(.., { inactive: true })`). `pageOpensAsSideTask()` returns false for the
reopen because it declares a `type`-less open that is `show: false`; keep that guard, it is what
stops the reopen from becoming a side task again. The reopened host is an ordinary `BaseWindow`, so
AppKit leaves it on the current desktop; no desktop-membership call is needed, and none may be made
on it while the app is inactive (the "anchor" pair in `electron-window-backend.ts
setDesktopMembership` flashes the window and moves it to the active desktop).

The content WebContents is destroyed with the old host and the page reloads in the new one. Page
state (scroll, form input, back history) is lost at the moment the user leaves the page. Caveat
accepted: the user has just left the page and the app is inactive, so the reload is invisible except
when they return to it within its load time. Moving the `WebContentsView` between hosts would keep
the state and is the follow-up if the loss shows up in use; nothing in the rule changes for it.

**Escape (`window-escape.ts`).** The side-task branch of `interpretEscape()` issues
`CloseOrHideWindow`, unconditionally. Delete the old set-aside path outright: the `SideTaskEscape`
type, the `SIDE_TASK_ESCAPE` constant, the `sideTaskEscape` parameter and every caller that passes
it, and the `HideWindow` command with `returnsOnActivation: true` that the branch built. If that
branch was the only producer of `returnsOnActivation`, remove the field from the `HideWindow`
command and the `WindowHidden` event and the kernel code that reads it; if another producer
remains, leave the field and say which producer in **Result**.

**Rules doc (`docs/design/window-rules.md`).** Add G13 side-task-ends stating the rule above.
Amend the last sentence of G1 and of F6 so the hold on a side task lasts until the side task ends,
not until the app activates. Rewrite the table in "Opening a page from another app": steps 5a
(Escape: page closes), 5c (click the other app: page reopens as an ordinary window behind the
other app, on this desktop), and add 5d (switch desktop: same as 5c, the page stays on the desktop
it was on when it lost key) and 5e (bring the app forward: the page becomes an ordinary window and
is the front window). State the Electron fact as the reason, once, in the prose. Add a row to the
failure table: "page opened from the palette over another app shows on every desktop and stays
above every app after the user leaves it" citing G13.

## What stays

- `pageOpensAsSideTask()`, `windowNonActivating()`, `isKeyHeldWhileAppInactive()` and their tests.
- The side-task open in `ipc.ts registerWindowHandlers` (`options.type = 'panel'`,
  `options.activation = 'user'`, the `page-opens-as-side-task` log line).
- The hold above other apps while the side task is alive (`heldAboveOtherApps`); it ends with the
  close.
- `hybridShowIntent()` / `showHybridHost()`. Their `nonActivating` flag is keyed on the quick-view
  role and disagrees with the machine record for a side task; out of scope here, note it on the
  item.
- The diag tracing from earlier on this branch is already reverted (`e2a50a83`, `579f75cc`).

## Tests to change

- `window-kernel.test.ts`: a table for `ReopenAsOrdinaryWindow`. Emitted: side task loses key with
  the app inactive; app activates while the side task is key. Not emitted: the palette (kind
  `browser`) loses key; an ordinary content window loses key with the app inactive; a side task
  loses key after the app is already active (it was reopened at activation); a hidden side task.
  Exactly one emission per window across the whole transition sequence.
- `window-escape.test.ts`: the side-task Escape test asserts a `CloseOrHideWindow` command and
  nothing about a setting; delete any test that existed only to pin the removed constant.
- `cmd-url-unfocused.spec.ts` (darwin-only): after the existing side-task assertions, inject the
  OS focus-lost report for the page through the executor's test surface (the same route the
  spec's Escape injection uses), then assert from the kernel record and timeline: the original
  page id is closed, one new page-host record exists with the same URL, `nonActivating` is false
  on it, it is visible, it is not `state.key`, `heldAboveOtherApps` is not set on it,
  `state.appActive` is still false, and no `HideApp` was issued. Replace the Escape assertion
  (`hidden:inactive`) with a close. Update the header comment. Record what the spec does before
  and after in **Result**: it was reported already failing on macOS in `4ad9b745`.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn test:grep 'cmd URL open while the app is in the background'
node scripts/check-platform-leak.mjs
```

Then one live check on macOS with a person, from this worktree on a fresh profile
(`yarn kill`, then launch with `PROFILE=agent-side-task-1`). The person performs only the
gesture, on desktop 2 with another app frontmost: open a URL from the palette, type into the page,
click the other app, switch to desktop 1 and back, then press cmd+tab to the app. Read the
`event=diag-poll` lines: the reopened host reports `isVisibleOnAllWorkspaces=false` and
`isAlwaysOnTop=false` from its first observation, the old host id stops reporting, and
`isFocused` on the new host stays false until the cmd+tab.

## Result

(filled by the implementing track)
