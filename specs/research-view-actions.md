---
enabled: true
touches: [apps/desktop/features/research/, apps/desktop/tests/desktop/research-view-actions.spec.ts, apps/desktop/tests/unit/research-view-*.test.js, docs/design/search-rounds.md]
depends-on: [research-view-searches-notes]
---

# The research view: Enter and click actions

Follows `specs/research-view-searches-notes.md`. The view so far lists a space's pages, searches
and notes; this slice makes each row do something.

Decisions:

- **A page**: Enter or click brings its open window forward, or opens it in the space the way
  `features/spaces` opens a space's page.
- **A search**: Enter or click runs it again through web search in the space.
- **A note**: Enter opens it for editing in place, as a plain input styled as the row (reuse
  `features/editor/query-inline-editor.js` only if it can look like a list row). Enter or leaving
  the row saves; Escape closes the editor, and a second Escape closes the view.

## Tests to change

New `tests/desktop/research-view-actions.spec.ts` on a test profile: a space with one open page,
one closed page, one `search-round` item and one note; Enter on the open page brings its window
forward; Enter on the closed page opens it in the space; Enter on the search starts a web search
in the space; editing the note and pressing Enter saves the new text; Escape twice closes the
view.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn workspace @peek/desktop test:grep "research|search-rounds|spaces"
```

Done when the unit tallies report `fail 0`, the new tests pass, and the other collected specs show
no new failure compared with `apps/desktop/tests/gate-baseline.md`. Record the `test:grep`
pass/fail count under `**Result**` in the handoff. Unverified by this run: whether bringing a
window forward from a see-through view lands focus where expected on macOS, which needs a look on
the laptop before landing.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app; read it before editing, especially the
`<peek-*>` component rules and the transient closing rule. Run one command per Bash call.
