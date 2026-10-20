---
enabled: true
touches: [apps/desktop/main/closed-window.test.ts, apps/desktop/main/main.ts, apps/desktop/main/closed-window-stack.ts]
depends-on: []
---

# Test the reopen-closed-window stack through real code instead of a copy

Part of Peek item `57895545`. `main/closed-window.test.ts` passes the test-honesty lint, because it
imports `session-projection.ts closedWindowSaveBounds`, but most of its cases still exercise inline
copies of `pushClosedWindow` / `popClosedWindow` and of how `main.ts finalizeWindowClose` builds a
closed-window entry.

Rule for every slice of this item: the shipped code is presumed correct. Where a case only passed
because the copy behaves differently, the case is changed to the real behaviour, and the difference
is named in the commit message and under **Result**. Product behaviour does not change.

## What goes

1. Move the closed-window stack (the push, pop and cap logic, and the pure part of entry building
   in `finalizeWindowClose`) out of `main.ts` into a new pure `main/closed-window-stack.ts`. It must
   not import `electron` or any module that does. Precedent: the landed spec
   `specs/honesty-extract-main-pure-helpers.md` and `main/izui-roles.ts`. `main.ts` imports it back;
   bodies move verbatim, and module state becomes either state owned by the new module or a
   parameter, whichever keeps `main.ts` call sites unchanged in behaviour.
2. `closed-window.test.ts`: delete the inline copies and import the real functions. Keep the
   `closedWindowSaveBounds` cases.

## What stays

- What reopening a closed window does, including the stack cap and which fields an entry carries.
- `session-projection.ts`.

## Verify

Run each in its own Bash call from the repo root, and record counts under **Result**.

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/closed-window.test.js
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
yarn test:grep "reopen"
```

Done when `grep -nE 'function (pushClosedWindow|popClosedWindow)' apps/desktop/main/closed-window.test.ts`
prints nothing, both electron runs report `fail 0`, and the Playwright reopen-closed-window specs
pass (or fail identically on `main`, recorded as such). If `"reopen"` collects no tests, find the
spec that covers reopening a closed window and grep for its title instead.
