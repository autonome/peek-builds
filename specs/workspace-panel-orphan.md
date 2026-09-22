---
enabled: true
touches: [apps/desktop/features/spaces/**, apps/desktop/main/session.ts, apps/desktop/main/session.test.ts, apps/desktop/main/session-projection.ts, apps/desktop/main/session-projection.test.ts, apps/desktop/main/entry.ts, apps/desktop/tests/desktop/*.spec.ts]
depends-on: [workspace-session-snapshot]
---

# Workspace panel is never persisted and never comes back orphaned

Peek item `2b37ac30`. Builds on `workspace-session-snapshot`, which must have landed first: that
spec makes feature chrome carry an explicit no-persist property and removes the global-pin list.
This spec covers the panel's lifecycle and the relaunch test.

## Symptom being fixed

Quit while a named workspace is active, relaunch: the workspace panel
(`apps/desktop/features/spaces/panel.html`, opened by `background.js showPanel()` with role
`panel` and `pinScope: 'global'`) reappears showing the old workspace name while the app has
started in the default workspace, often twice. Nothing owns either copy: the spaces feature is
lazy, has not loaded, its `panelWindowId` is null, so `hidePanel()` never closes them and
`closeCurrentWorkspaceWindows()` skips them as global pins. They persist across every further
relaunch until closed by hand.

Two persistence paths both picked it up: the general session snapshot (`panel` role was not
excluded) and the global-pin list (`pinScope: 'global'`). The dependency spec removes both
routes in principle; this spec proves it for the panel and fixes what remains.

## Requirements

1. The panel exists only while a named workspace is active. The feature creates it when a
   workspace is entered and closes it when the workspace is left or the app starts in the
   default workspace. On boot the default workspace is active and no panel is created.
2. The panel window carries the no-persist property the dependency spec introduced, so no
   snapshot ever contains it. If the border window (`border.html`) is opened by the feature, it
   carries the same property.
3. Quit inside a named workspace, relaunch: no `panel`-role window exists. Enter a named
   workspace: exactly one panel. `close space` (the leave-workspace command) removes it.
4. A profile that already holds an orphaned panel entry from before this fix (a `panel`-role
   window in the saved snapshot) does not reopen it on the next boot: the restore path skips
   windows carrying the no-persist role or property, whatever an old snapshot says.
5. A new desktop spec relaunches the app after quitting inside a named workspace and asserts
   zero `panel`-role windows at startup and one after entering a workspace. It runs the real
   boot path, not a test bridge. If a boot-time path is still gated on `!isTestProfile()`, the
   gate is removed or the spec drives the same code the gate protects.

## Verify

The repo gate runs only the unit tests. Run the panel specs too and record pass/fail counts in
the handoff's `**Result**` section:

```
yarn workspace @peek/desktop test:grep "workspace panel"
```

Done when the existing panel spec and the new relaunch spec are green.

## Working rules

- `apps/desktop/CLAUDE.md` governs the desktop app. Read it before editing.
- Run one command per Bash call; use the `yarn` scripts, never `npx playwright` directly.
