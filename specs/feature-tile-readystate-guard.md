---
enabled: true
touches: [apps/desktop/features/groups/home.js, apps/desktop/features/tags/home.js, apps/desktop/features/search/home.js, apps/desktop/features/windows/windows.js, apps/desktop/features/editor/home.js, apps/desktop/features/tag-actions/home.js, apps/desktop/features/sheets/sheet.js, apps/desktop/features/pagestream/home.js, apps/desktop/features/timers/home.js]
depends-on: []
---

# Guard every feature tile's DOMContentLoaded registration on document.readyState

`apps/desktop/features/spaces/home.js` (and several others: `lists`, `entities`, `lex`,
`websearch`, `spaces/panel`, `pubsub-repro`, `scripts/manager` — already fixed, not touched by
this spec) guard their `DOMContentLoaded` listener like this:

```js
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
```

The lesson: a page whose script registers `DOMContentLoaded` only after an `await` can lose the
race if the event has already fired by the time the listener goes on — the listener then never
runs and `init()` never happens under load. `spaces/home.js` hits this for real because its HTML
does `await window.app.initialize()` then a *dynamic* `import()` of the module, which isn't part
of what blocks `DOMContentLoaded`.

## What this spec covers

Nine files register `document.addEventListener('DOMContentLoaded', init)` (or equivalent) at
true top level, synchronously, during initial module evaluation, with no preceding `await`:

- `apps/desktop/features/groups/home.js`
- `apps/desktop/features/tags/home.js`
- `apps/desktop/features/search/home.js`
- `apps/desktop/features/windows/windows.js`
- `apps/desktop/features/editor/home.js`
- `apps/desktop/features/tag-actions/home.js`
- `apps/desktop/features/sheets/sheet.js`
- `apps/desktop/features/pagestream/home.js`
- `apps/desktop/features/timers/home.js`

None of these currently race — they're loaded via a static `<script type="module">` tag and
register synchronously before the event can fire, so this isn't a live bug. It's defense in depth:
apply the same `document.readyState === 'loading'` guard to each one's registration, so a future
change that adds an `await` before the registration (exactly the mistake `spaces/home.js` made)
doesn't silently reintroduce the race. Match each file's existing init-function name and style;
don't rename anything or restructure beyond wrapping the existing registration in the guard.

`apps/desktop/features/groups/home.js` also has a separate, unrelated top-level bootstrap IIFE
that does its own `await api.initialize()` — leave that alone; it doesn't touch the
`DOMContentLoaded` registration at line ~1878 this spec is guarding.

## Verify

This is a mechanical, behavior-preserving change (the guard's `else` branch — call `init()`
immediately — only ever runs today when `document.readyState` is already `'loading'` at import
time is false, but since the pages are always loaded after the DOM exists in current usage, only
the `if` branch fires in practice; verify nothing regresses):

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
```

These are exactly the repo gate commands, so a clean run of the gate itself is sufficient — no
extra desktop spec needed for this one, since the change has no behavioral difference in the
paths those tests already exercise.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app. Read it before editing.
