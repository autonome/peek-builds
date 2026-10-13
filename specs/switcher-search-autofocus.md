---
enabled: true
touches: [apps/desktop/features/windows/windows.js, apps/desktop/tests/desktop/switcher-search-autofocus.spec.ts]
depends-on: []
---

# The window switcher opens with its search input focused

Peek item `6d475cd9`. Opening the window switcher (command `windows`, the
`CommandOrControl+Shift+W` shortcut, or Escape's switcher fallback) shows the window list without
a caret in the search input, so typing to filter needs a click first.

## What the code does now

- `features/windows/background.js openWindowsView()` opens `peek://windows/windows.html` fresh
  each time (`role:'switcher'`, overlay); `windows.js closeWindowsView()` destroys it, so every
  open runs `windows.js init()` once.
- The search input is `<peek-input class="search-input">` in `features/windows/windows.html`.
  The only `searchInput.focus()` call is in `windows.js handleKeydown()`, on `/` or Cmd/Ctrl+F.
  `init()` never focuses it.

## What changes

`windows.js init()`: after the first `renderWindows()`, focus the search input
(`searchInput.focus()`, the same call `handleKeydown` uses). No timer, no retry: `init()` already
runs after the DOM is ready. Keyboard navigation in `handleKeydown` (hjkl, arrows, Enter) must
keep working while the input holds focus; if a key handler today assumes the input is unfocused
(for example hjkl moving the selection), keep letters typing into the search and keep arrows and
Enter navigating, and record the choice in the handoff under `**Result**`.

## Tests to change

New `apps/desktop/tests/desktop/switcher-search-autofocus.spec.ts`, following
`windows-lazy-wake.spec.ts` (`createPerDescribeApp`, open with
`globalThis.__peek_test.publishCmdExecute('windows')`, `app.getWindow('windows/windows.html')`):

1. After open, the search input is the focused element: `document.activeElement` is the
   `peek-input.search-input` (or its shadow root's `activeElement` is its inner input).
2. Typing a few characters with `page.keyboard.type` lands in the search input and filters the
   list, with no click first.
3. ArrowDown then Enter still activates a card, so focus in the input did not break keyboard
   selection.

Real OS focus is not observable headless; assert the page's focused element only.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn workspace @peek/desktop test:grep "switcher"
```

Done when the unit tallies report `fail 0` and the `test:grep` run collects the three new tests
and they pass, with no new failure among the other switcher specs compared with
`apps/desktop/tests/gate-baseline.md`. Record the `test:grep` pass/fail count under `**Result**`
in the handoff.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app. Read it before editing. Run one command per
Bash call.
