---
enabled: false
touches: [apps/desktop/features/editor/editor-layout.js, apps/desktop/features/editor/home.js, apps/desktop/features/editor/background.js, apps/desktop/features/editor/codemirror.js, apps/desktop/features/editor/status-line.js, apps/desktop/features/editor/manifest.json, apps/desktop/renderer/cmd/commands/edit.js, apps/desktop/renderer/cmd/panel.js, apps/desktop/renderer/cmd/state-machine.js, apps/desktop/renderer/lib/tag-action-affordances.js]
depends-on: []
---

**Status — design spec, no implementation.** Disabled until the open questions
at the end are answered; nothing here is built. `touches` lists the files an
implementation would most likely change — the final set depends on the
outer-surface decision (see Open questions).

Part of Peek item `item_1790655511612_0mmmdmy59` ("tag query editor view", tags
`peek`, `peek:todo`, `desktop`). Read it with the peek MCP `get_item` if that
tool is available; this file carries everything needed if it is not. The item's
requirement list is transcribed in "Source requirements" below. One line of the
item arrived truncated mid-sentence ("with a visua…") and is treated as unknown.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

# Tag-query editor view: one editor document over every item matching a tag query

`edit #todo #today` opens a single editor window holding every item that
carries both tags, presented as one document: a block-editor/notebook hybrid
where each item is a visually distinct block, navigable and foldable with the
editor's vim bindings, editable inline through the embedded text editor. The
view is a mode of the existing editor feature, not a fork of it.

## Problem

Two surfaces touch tagged items today, and neither is an editing surface for a
group:

- The tags grid (`apps/desktop/features/tags/home.js`) lists and filters items
  (its `filterItems`/`parseSearchQuery` from `features/tags/search.js` support
  `#tag` AND queries), renders cards with tag-action affordances, and edits one
  text item at a time in an embedded editor (`createEmbeddedEditor`). It is a
  browser, not a document: no folding, no outline, no one-document overview.
- The editor (`apps/desktop/features/editor`) edits exactly one item per
  window: `renderer/cmd/commands/edit.js` (`edit` command `execute`) returns an
  `item`-mimeType output, the cmd panel's `renderer/cmd/state-machine.js`
  (`States.EXECUTING` on `COMMAND_COMPLETE`, guards `isArrayOutput` /
  `isEditorMimeType`) sends arrays to output-selection mode, and selecting one
  row makes `renderer/cmd/panel.js` (`doSelectOutputItem`, `publishEditorOpen`)
  publish `editor:open` with that single `itemId`. `features/editor/background.js`
  (`openEditor`) then keys the window per item (`editor-<itemId>`).

So working through a queue like `#todo #today` means either hopping item to
item across editor windows or losing the document feel in the tags grid. The
query editor closes that gap: the group becomes one editable document.

## Terms

- **Query** — the set of `#tag` names the view is open over. AND semantics: an
  item matches only when it carries every tag in the query (same rule as
  `parseSearchQuery` tag filters in `features/tags/search.js`).
- **Block** — one item's rendered region in the document. Blocks are the
  top-level rows of the view.
- **Row** — a visual line of a block (title row, tag-binding row, body rows).
- **Outer surface** — the document itself: the thing j/k, folding and block
  selection act on.
- **Inline editor** — the embedded CodeMirror text editor that opens inside a
  block for editing (the `createEmbeddedEditor` pattern from
  `features/tags/home.js`).
- **Vim command area** — the single status line the editor shows vim mode,
  cursor position and messages in (`features/editor/status-line.js` `StatusLine`;
  `EditorLayout` creates the one instance in its `statusLineContainer`).

## The view

### Opening a query

- `edit #todo #today` — the `edit` command recognizes arguments that are
  entirely `#tag` tokens as a query and produces a query output instead of a
  single item or selection list. (Whether `edit` itself grows this form or a
  sibling command is better is Open question 1; the UX described here is the
  source item's example verbatim.)
- Tag resolution follows existing patterns: resolve by name
  (case-insensitive; `renderer/cmd/item-suggestions.js` `findTagByName`), read
  items with `api.datastore.getItemsByTag(tag.id)` and intersect across query
  tags. An unknown tag MUST NOT be auto-created (the `completeItem` precedent
  returns no suggestions for a missing tag) — the result is an empty view with
  a notice naming the unknown tag.
- The panel routes the query output to the editor window, mirroring the
  `publishEditorOpen` seam in `renderer/cmd/panel.js` (today it branches on
  `mimeType === 'new-item'` → `editor:add`, single item → `editor:open`). The
  exact new output shape / topic is Open question 2.
- The editor opens with the query as its source, the way `features/editor/home.js`
  `init()` today reads `content` / `file` / `itemId` URL params — a query param
  (e.g. `tags=todo,today`) is the natural extension, and `openEditor()` keys
  the window per query (e.g. `editor-query-<sorted tags>`) so re-running the
  same query focuses the existing window instead of stacking windows.
- Default order: `updatedAt` descending (most recently edited first). The
  source item's ordering line is truncated after "with a visua…" — the intended
  visual cue (date separators? age badges like `search-result-card.js`
  `formatAge`?) is unknown; Open question 3.

### The document

- One scrollable document; each matching item is a block with a visually
  distinct treatment (block editor / notebook hybrid per the source item).
- A block's first row is its title row (first content line with heading marker
  stripped — the `extractTitle` convention shared by `card-helpers.js` and
  `item-suggestions.js` `toItemSuggestion`), plus a left column carrying the
  item's tag bindings (below).
- Bodies render per type: `text` items render their markdown (the rendering
  path `features/editor/preview-sidebar.js` `renderMarkdown` already provides);
  `url` items render like a card row (favicon, title, URL —
  `card-helpers.js` `getItemDisplayInfo` / `createUrlSpan`); `image` items
  render the image. Type coverage beyond text/url/image is Open question 5.
- Which sidebars apply is undecided: the layout's pane machinery (outline /
  preview / annotations, see Reuse map) is available, but what the outline of a
  query document is (block titles as top-level entries?) is Open question 7.

### Left column: tag bindings

- Each block carries a left column that renders and executes the item's tag
  bindings — toggle checkboxes like `#todo`/`#done` — exactly the way cards do:
  `renderer/lib/tag-action-affordances.js` (`createAffordanceElements` /
  `resolveAffordances`, rules cached via `createActionRulesCache`), clicks
  publishing `affordance:click` for the rule engine to execute. This MUST be
  the shared affordance module, not a copy.
- Toggling a binding that removes an item from the query (e.g. checking
  `todo→done` in a `#todo` view) SHOULD animate the item leaving the document
  rather than silently vanishing; exact behavior is Open question 10.

### Top toolbar

- The view adds a top toolbar above the document. The source item wants it
  designed as a general editor capability ("probably want that in regular
  editor too"), so it MUST be an `EditorLayout`-level element both editors can
  host — not a query-view-private strip. The existing editor's toolbar lives
  below the editor pane (`EditorLayout` `this.toolbar`); the top toolbar is
  additional, not a move. Contents (query display? sort? filter? refresh? add
  item?) are Open question 8.

### Navigation and folding

- `j`/`k` move block selection through the document, following the
  grid-navigation pattern (`renderer/lib/grid-nav.js` `updateSelection` —
  selection state, visual highlight, scroll-into-view), generalized from cards
  to blocks. Arrow keys SHOULD behave as aliases as they do in card views.
- Folding is a **subset** of the editor's vim folding bindings, applied at the
  top level only: the fold unit is the block, never lists/indents inside an
  item's content. The bindings are the existing ones
  (`features/editor/codemirror.js`: `Vim.defineAction` `foldCode` / `unfoldCode`
  / `toggleFold` / `foldAll` / `unfoldAll`, mapped via `Vim.mapCommand` to
  `zc` / `zo` / `za` / `zM` / `zR` / `zr` / `zm` and `<Space>`):
  - `zM` (collapse all): every block shows only its first row.
  - `zR` (expand all): all rows of all blocks.
  - `zc` / `zo` / `za` on the selected block: collapse / expand / toggle that
    block.
  - Inside an open inline editing session these keys belong to the inline
    editor's own document (CodeMirror folding), not the block level — the
    handoff is Open question 6.
- The editor's existing per-line folditall folding (`codemirror.js`
  `canStartFold` / `hasFoldableChildren` machinery) does not operate on the
  outer surface in v1.

### Inline editing

- `<Enter>` on a selected block opens the inline editor inside that block,
  notebook-style; `<Esc>` closes it and returns selection to the block.
- The inline editor is the embedded CodeMirror editor — the same construction
  `features/tags/home.js` `createEmbeddedEditor()` uses (imports
  `peek://extensions/editor/codemirror.js` and `StatusLine`), with vim mode
  from the shared `vimMode` preference, wired to the single vim command area
  (below).
- Saving follows the established autosave pattern: debounced writes
  (`AUTOSAVE_DELAY_MS` in `features/editor/home.js` `performAutosave` via
  `api.datastore.updateItem(id, { content, title })`; same 1500 ms debounce in
  the tags view) and a dirty flush on `<Esc>`-close or block navigation (the
  flush in `handleEscape()` before leaving the detail view is the precedent).
- The `<Esc>` cascade, innermost first, mirrors the tags view's documented
  cascade (`handleEscape`): vim insert → normal; inline editor open → close it;
  then the outer surface's existing `<Esc>` behavior (the editor window's
  focus-mode exit / close). Note the preload intercepts `<Esc>` via
  before-input-event so CodeMirror's vim extension never sees it — whichever
  layer owns the cascade must handle insert→normal itself, as the tags view
  does.

### The single vim command area

- There is exactly one vim command area. The view MUST NOT grow a second
  status line: while an inline editor is open, it **takes over** the existing
  `StatusLine` — the inline editor's vim-mode and cursor events
  (`onVimModeChange` / `onSelectionChange`, as wired in `createEmbeddedEditor`)
  drive the shared instance, and on close the outer surface's state is
  restored. This is the source item's "we don't want two vim command areas …
  the inline editor needs to temporarily take over the vim command area"
  constraint, and it is the riskiest interaction in the design (see What is
  unverified).

## Source requirements

Transcribed from Peek item `item_1790655511612_0mmmdmy59` (requirements and
implementation notes), kept as the normative source where this spec
paraphrases:

- new feature for editing groups of tagged items in one view; e.g. a cmd
  `edit #todo #today` opens an editor with all matching items
- editor experience is a hybrid of block editor and notebook style; presents as
  a single document with visual cues making each block distinct
- mostly same features as existing editor — sidebars, vim support, etc
- new top toolbar for some controls, designed with reuse in the regular editor
  in mind
- search tagged items, render each appropriately for the type (note, url,
  image)
- default order: date edited, descending, with a visua… (truncated in the
  source item; see Open question 3)
- tag binding stuff works: a left col that renders/executes the bindings, e.g.
  checkbox for `#todo`/`#done`, just like in cards
- rendered view renders markdown content in items
- `j`/`k` nav for rows
- a subset of our vim folding bindings, applying at top level only (not to
  lists/indents inside content); collapse all shows only the first row of each
  item, expand all shows all rows of all items
- `<enter>` to edit, `<esc>` to close edit; editor view opens inline like any
  notebook/block-editor; editor uses the embedded text editor like in places
  such as the tags view
- ideally integrate into the existing editor instead of forking; that may look
  like swapping out the content-area renderer; need to look at the code and
  judge whether it makes the current editor too complex
- if integrated, the inline editor is the text editor running inside the text
  editor; we don't want two vim command areas, so the inline editor
  temporarily takes over the vim command area — "could be hairy, but if you
  blur your eyes it looks like vim buffers"
- review different block editor and notebook libs/frameworks to figure out
  which meets the requirements
- would be super cool on mobile too, but likely needs full integration, not a
  separate app (or an overhaul of how mobile works)

## Reuse map

What exists today and MUST be reused rather than copied:

| Need | Existing thing |
| --- | --- |
| Editor chrome: panes, resize/collapse, focus mode, layout prefs | `features/editor/editor-layout.js` `EditorLayout` (`_applyPaneState`, `editor:layout-prefs`) |
| Vim editing + fold bindings + `:set` persistence | `features/editor/codemirror.js` (`createEditor`, `Vim.defineAction`/`Vim.mapCommand`, `onVimSetOption`) |
| Status/command line | `features/editor/status-line.js` `StatusLine` (`updateMode`, `updatePosition`, `showMessage`) |
| Embedded editor precedent + autosave + `<Esc>` cascade | `features/tags/home.js` `createEmbeddedEditor` / `destroyEmbeddedEditor` / `handleEscape` / `scheduleEditorAutosave` |
| Tag query parsing semantics | `features/tags/search.js` `parseSearchQuery` / `filterItems` (AND across `#tags`) |
| Tag bindings in the left column | `renderer/lib/tag-action-affordances.js` (`createAffordanceElements`, `resolveAffordances`, `createActionRulesCache`) |
| Per-type item display | `renderer/lib/card-helpers.js` (`getItemDisplayInfo`, `extractTitle`, `createUrlSpan`); card assembly in `renderer/lib/search-result-card.js` |
| Markdown rendering | `features/editor/preview-sidebar.js` `renderMarkdown` |
| j/k row selection pattern | `renderer/lib/grid-nav.js` (`updateSelection`, `toggleSelectedCheckbox`) |
| Keeping the view fresh | `renderer/lib/live-query.js` `liveQuery` (query + subscribe + debounced re-render; whether to use it is Open question 10) |
| Lazy rendering of many rows | `renderer/lib/visibility-gate.js` `createVisibilityGate` (already used by the tags view) |
| Tag resolution + `getItemsByTag` precedent | `features/todo/background.js` `ensureTag`; `renderer/cmd/item-suggestions.js` `findTagByName` / `filterTaggedItems` |
| Cmd output → editor routing | `renderer/cmd/state-machine.js` (`COMMAND_COMPLETE` guards), `renderer/cmd/panel.js` `doSelectOutputItem` / `publishEditorOpen`, `features/editor/background.js` `editor:open` subscription / `openEditor` |

## Integration constraints

- **No fork.** The query view is a mode of `features/editor` — same feature
  directory, same manifest, same window role — per the source item's
  "integrate into existing editor instead of forking". A separate feature that
  duplicates the layout/CodeMirror/status-line wiring is a failure condition.
- **Content-area swap.** The anticipated shape is `EditorLayout` keeping its
  panes and chrome while the center content area renders the block document
  instead of (or as a mode of) the single CodeMirror document. Whether the
  outer surface is itself CodeMirror with block decorations, plain DOM blocks,
  or an adopted library is the central open decision (Open question 4) and is
  exactly what the library review must answer.
- **The single-document editor MUST NOT regress.** The existing editor test
  surface (`apps/desktop/tests/editor/editor-layout.spec.ts`,
  `editor-folding.spec.ts`, the Playwright `editor` project) stays green and
  meaningful; the query mode must not complicate the single-doc path to the
  point of needing special cases in it — the source item explicitly flags
  "whether it makes the current editor too complex" as the thing to judge.
- **Editor-in-editor.** When integrated, the inline editor is the embedded
  text editor running inside the editor surface ("the text editor running
  inside… the text editor"). Both layers are vim-capable; the single command
  area is the only shared vim UI.

## Library review

Before any implementation, the design calls for reviewing block-editor /
notebook libraries and frameworks against the requirements, and comparing with
building the outer surface on what the repo already has (CodeMirror +
decorations + the affordance/card modules). No block-editor dependency exists
in the repo today (no lexical/tiptap/prosemirror/blocknote in any
`package.json`). The review MUST at least evaluate, against this spec's
requirements: vim-mode compatibility or embeddability of CodeMirror instances
per block, block-level fold/collapse APIs, j/k selection hooks, markdown
rendering per block, license/size/maintenance, and theming against the
existing CSS variables the editor and `StatusLine` use (`--base00`…). Outcome
recorded against Open question 4.

## Non-goals

- Mobile. The source item wants this on mobile eventually ("super cool on
  mobile too") but as full integration or a mobile overhaul, not this spec.
- Replacing the tags grid; the grid keeps its browse/filter role.
- Intra-item folding at the outer level in v1 (the folding subset is
  block-level only).
- Full vim parity on the outer surface beyond navigation + the folding subset
  (what else the outer surface needs — searching, marks, `:` commands — is part
  of Open question 4's criteria).

## What is unverified

- The source item's ordering sentence is truncated ("with a visua…"); the
  intended visual cue is genuinely unknown and must not be guessed into the
  implementation.
- Two simultaneously vim-enabled CodeMirror surfaces in one window (outer
  surface if CodeMirror-based + inline editor) have no in-repo precedent — the
  tags view runs exactly one embedded editor at a time. Whether key handling
  and focus interplay cleanly, and whether `@replit/codemirror-vim` supports
  two instances' state driving one status line, is unproven. The source item
  itself calls this "could be hairy".
- The `<Esc>` interception note (preload before-input-event) is documented in
  the tags tile's `handleEscape` comment; it has not been verified that the
  editor home tile's window behaves identically.
- The panel-routing description (`publishEditorOpen` branches, output-selection
  guards) reflects `renderer/cmd/panel.js` / `state-machine.js` as read for
  this spec; the exact new output shape (question 2) will need those guards
  re-read at implementation time.
- Scale is unmeasured: no data on how many items a typical `#tag` query
  matches or how a single-document block view behaves at that size. The
  visibility-gate mechanism is the existing lazy-render answer if needed.
- The library review has not been done; every "which library" statement above
  is a requirement statement, not a finding.

## Open questions

1. **Command surface:** extend `edit` itself (`edit #todo #today`) or add a
   sibling command? If `edit`, how do `#tag` tokens coexist with its existing
   text search and `{ type: 'item' }` param suggestions (`completers.js`
   `completeItem`)? Does bare `edit #todo` (one tag) open the query view or
   today's single-item picker?
2. **Routing seam:** new output mimeType (e.g. `item-set`) routed by
   `publishEditorOpen`, a `tags` field on `editor:open`, or a new topic? And
   the window-key scheme for query windows (`editor-query-<tags>`) — confirm.
3. **Ordering cue:** what was "with a visua…" meant to be — date separators,
   age badges (`formatAge`), a gutter date? Is the order strictly
   `updatedAt` desc, with any tie-break?
4. **Outer surface representation:** CodeMirror with block decorations vs DOM
   blocks + embedded CodeMirror per block vs an adopted block-editor library —
   decided by the library review against which criteria list?
5. **Type coverage in v1:** text/url/image are named; what about `tagset`,
   `series`, `feed`, `entity`, `event` items that can carry tags — render
   read-only rows, or exclude from the view? Are url/image blocks read-only
   (open on activate) or metadata-editable?
6. **Folding/focus handoff:** while an inline editor is open, do `z` keys
   always go to the inner document? How does block selection behave when a
   fold command would collapse the block being edited?
7. **Sidebars in the query view:** which of outline/preview/annotations apply?
   Is the outline the list of block titles (and does clicking it jump/fold)?
   Does preview render the whole document or the selected block?
8. **Top toolbar contents and placement:** which controls, and confirmation
   that the single-doc editor adopts the same toolbar (the source item wants
   it designed for reuse)?
9. **Vim command area takeover mechanics:** rebind one `StatusLine` to the
   focused surface, or multiplex events? What does the status line show while
   the outer surface has no vim state of its own (if the outer surface is not
   CodeMirror-based)?
10. **Liveness and mutation:** does the document re-render live as items
    change (`liveQuery` on `item:*` / `tag:*` topics), or refresh on demand?
    What happens to an open inline editor when its item is edited elsewhere,
    retagged out of the query, or deleted? Is there an add-item flow that
    pre-tags a new note with the query's tags?
11. **Scale/virtualization:** expected worst-case block counts per query, and
    whether the visibility gate or another virtualization is required for v1.
12. **Mobile:** confirm it stays fully out of scope for this spec's
    implementation slices.
