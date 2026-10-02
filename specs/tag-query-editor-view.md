---
enabled: false
touches: [apps/desktop/features/editor/editor-layout.js, apps/desktop/features/editor/home.js, apps/desktop/features/editor/background.js, apps/desktop/features/editor/codemirror.js, apps/desktop/features/editor/status-line.js, apps/desktop/features/editor/manifest.json, apps/desktop/renderer/cmd/commands/edit.js, apps/desktop/renderer/cmd/panel.js, apps/desktop/renderer/cmd/state-machine.js, apps/desktop/renderer/lib/tag-action-affordances.js]
depends-on: []
---

**Status — design spec, no implementation.** This file is the design and stays
disabled; nothing here is built. The design questions are settled in Decisions,
and the work is sliced into the enabled implementation specs listed under
"Implementation slices". `touches` lists the files an implementation would most
likely change — the final set depends on the outer-surface trial (see
Decisions, "Outer surface").

Part of Peek item `item_1790655511612_0mmmdmy59` ("tag query editor view", tags
`peek`, `peek:todo`, `desktop`). Read it with the peek MCP `get_item` if that
tool is available; this file carries everything needed if it is not. The item's
requirement list is transcribed in "Source requirements" below. One line of the
item's ordering line arrived truncated mid-sentence ("with a visua…"); the
intended cue is the sort chooser, the toolbar sort dropdown.

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
  sibling command is better was settled in Decisions: `edit` takes it.)
- Tag resolution follows existing patterns: resolve by name
  (case-insensitive; `renderer/cmd/item-suggestions.js` `findTagByName`), read
  items with `api.datastore.getItemsByTag(tag.id)` and intersect across query
  tags. An unknown tag MUST NOT be auto-created (the `completeItem` precedent
  returns no suggestions for a missing tag) — the result is an empty view with
  a notice naming the unknown tag.
- The panel routes the query output to the editor window, mirroring the
  `publishEditorOpen` seam in `renderer/cmd/panel.js` (today it branches on
  `mimeType === 'new-item'` → `editor:add`, single item → `editor:open`). The
  query output rides the existing `editor:open` topic with a `tags` field
  (Decisions, "Routing").
- The editor opens with the query as its source, the way `features/editor/home.js`
  `init()` today reads `content` / `file` / `itemId` URL params — a query param
  (e.g. `tags=todo,today`) is the natural extension, and `openEditor()` keys
  the window per query (`editor-query-<sorted tags>`) so re-running the
  same query focuses the existing window instead of stacking windows.
- Default order: `updatedAt` descending (most recently edited first). The
  ordering controls are a sort-option dropdown in the
  toolbar (the sort chooser) plus a manual order (Decisions, "Manual order").

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
  render the image. Other item types are left out (see Decisions).
- Which sidebars apply is undecided: the layout's pane machinery (outline /
  preview / annotations, see Reuse map) is available, but what the outline of a
  query document is (block titles as top-level entries?) is settled in Decisions (block titles, no preview).

### Left column: tag bindings

- Each block carries a left column that renders and executes the item's tag
  bindings — toggle checkboxes like `#todo`/`#done` — exactly the way cards do:
  `renderer/lib/tag-action-affordances.js` (`createAffordanceElements` /
  `resolveAffordances`, rules cached via `createActionRulesCache`), clicks
  publishing `affordance:click` for the rule engine to execute. This MUST be
  the shared affordance module, not a copy.
- Toggling a binding that removes an item from the query (e.g. checking
  `todo→done` in a `#todo` view) SHOULD animate the item leaving the document
  rather than silently vanishing; open-editor cases are in Decisions ("Live
  updates while editing").

### Top toolbar

- The view adds a top toolbar above the document. The source item wants it
  designed as a general editor capability ("probably want that in regular
  editor too"), so it MUST be an `EditorLayout`-level element both editors can
  host — not a query-view-private strip. The existing editor's toolbar lives
  below the editor pane (`EditorLayout` `this.toolbar`); the top toolbar is
  additional, not a move. Contents (query display? sort? filter? refresh? add
  item?) beyond sort are undecided (see Decisions).

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
    handoff: see Decisions (folding and instant apply).
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
  source item; the cue is the sort chooser, the toolbar sort dropdown)
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
| Keeping the view fresh | `renderer/lib/live-query.js` `liveQuery` (query + subscribe + debounced re-render; live updates are decided in Decisions) |
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
  or an adopted library is settled by the two trials in Decisions ("Outer
  surface"); the library review ruled libraries out on paper.
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
recorded in "Library review findings" and Decisions ("Outer surface").

## Library review findings

Registry facts (license, version, last publish, unpacked size) were read from
the npm registry on 2026-10-01. Everything else about the libraries comes from
general knowledge of their designs and was not checked against their current
documentation or by a trial; web search was unavailable.

What the repo has: `apps/desktop/package.json` already depends on
`@codemirror/view` 6.39, `@codemirror/language`, `@codemirror/state`,
`@replit/codemirror-vim` 6.3 (MIT) and `lit`; no React and no ProseMirror. The
editor theme in `features/editor/codemirror.js` is built entirely from
`var(--base00…0F)` values, so any CodeMirror instance created through its
`createEditor` is already themed. `renderer/lib/visibility-gate.js`
`createVisibilityGate` is not a virtualizer: it only defers a refresh while the
window is hidden. The tags view (`features/tags/home.js`) renders all cards and
relies on CSS `content-visibility: auto` (comment near `renderCards`) to skip
painting off-screen cards.

| Option | License / size / upkeep | Per-block CodeMirror with vim | Block-level fold, j/k | Markdown per block | Theming with `--base*` | Fit |
| --- | --- | --- | --- | --- | --- | --- |
| BlockNote (`@blocknote/core` 0.55) | MPL-2.0; 9.3 MB unpacked; active | Code blocks use a highlighter, not CodeMirror; would need a custom block hosting `createEditor` | No block collapse built in beyond toggle blocks; keys are ProseMirror's, so j/k would be a custom plugin | Its own document model; markdown is import/export | Own CSS, overridable | Poor: React-centred UI, a second editing model next to CodeMirror |
| Tiptap (`@tiptap/core` 3.31) | MIT core (some paid extensions); active | Node views can mount any DOM, including a CodeMirror per node | Collapse is a custom node attribute; j/k custom | Markdown extension is import/export | Headless, so themable | Workable but adds ProseMirror for no gain over plain DOM blocks |
| Lexical (`lexical` 0.52) | MIT; 3.2 MB unpacked; active | Decorator nodes can host a CodeMirror | Custom | Markdown transformers | Headless | Same objection as Tiptap |
| Milkdown (`@milkdown/core` 7.22) | MIT; active | Has a CodeMirror code-block plugin, not a per-item editor | Custom | Markdown-native, one document | Own themes | Models a single markdown document; our blocks are separate items |
| CodeMirror 6 with block decorations (in repo) | MIT; zero new weight | The outer surface is itself a vim editor; inline editors would be a second vim instance (the unverified item below) | Fold ranges and `foldEffect` exist, but block-widget bodies are not text, so j/k and folds would map to document lines, not blocks | Widgets render with `renderMarkdown` | Already themed | Uncertain: every block is a widget, so CodeMirror adds a text layer under them that nothing needs |
| Plain DOM blocks plus per-block `createEditor` (in repo) | No new dependency | One embedded editor at a time, as the tags view already does; no outer vim instance | Block fold is a class toggle; j/k follows `grid-nav.js` `updateSelection` | `renderMarkdown` on non-editing blocks | Uses the same variables as cards | Best fit |

Virtualization options, same sources:

| Option | License / size | Notes |
| --- | --- | --- |
| CSS `content-visibility: auto` with `contain-intrinsic-size` | Built into Chromium; none | Already used by the tags grid; skips layout and paint but keeps every block in the DOM, so scroll position, find and j/k jumps need no extra code |
| `@tanstack/virtual-core` 3.17 | MIT; 0.4 MB unpacked; framework-free | Dynamic heights through measurement; folding and live edits change heights, which causes scroll correction work |
| `virtua` 0.52 | MIT; 2.3 MB unpacked | Mainly a React/Vue/Solid component set; adds a framework |
| `createVisibilityGate` | in repo | Not a virtualizer; only defers refresh while hidden |

Recommendation: plain DOM blocks in the existing editor window's center area,
each rendered with the shared affordance, card and `renderMarkdown` modules,
with one embedded `createEditor` instance opened inside the selected block at a
time, and selection and folding done at the block level. Add no block-editor
library: each one brings a second document model and, for BlockNote, React,
while the requirements are met by modules the repo already has, and one vim
editor at a time removes the two-instances risk. For scale, start with
`content-visibility: auto` and measure; reach for `@tanstack/virtual-core` only
if hundreds-to-thousands of blocks measurably stall, since virtualized folding
and inline editing both change block heights.

What remains unverified:
- Performance of `content-visibility: auto` at a thousand blocks with rendered
  markdown and affordances; no measurement was made.
- That a custom ProseMirror/Lexical block hosting `createEditor` would be as
  awkward as assumed; no trial was built, and library capabilities above are not
  checked against current documentation.
- That the outer surface needs no CodeMirror at all: searching within the
  document, `:` commands and marks are not covered by plain DOM blocks and would
  have to be added or dropped.
- Whether the editor tests for the single-document path stay untouched when the
  center area is swapped.

Manual order: an order stored on the query (its sorted tag set) is lost when
the tags change, while an order stored as an ordered membership of a saved list
survives. The lists feature is undesigned, so the order is stored per query for
now (Decisions, "Manual order").

## Non-goals

- Mobile. The source item wants this on mobile eventually ("super cool on
  mobile too") but as full integration or a mobile overhaul, not this spec.
- Replacing the tags grid; the grid keeps its browse/filter role.
- Intra-item folding at the outer level in v1 (the folding subset is
  block-level only).
- Full vim parity on the outer surface beyond navigation + the folding subset
  (what else the outer surface needs — searching, marks, `:` commands — is part
  of the outer-surface comparison criteria in Decisions).

## What is unverified

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
  this spec; the guards need re-reading when the query output is wired in.
- Scale is unmeasured: no data on how many items a typical `#tag` query
  matches or how a block view behaves at that size. Measuring at about 1000
  blocks is a task inside each surface trial, not an open question.
- Which of the two outer surfaces wins is unknown until the trials are
  compared; every slice after the comparison assumes the pick.
- Where a per-query manual order is persisted (which datastore or settings
  call) is not chosen; the manual-order slice picks it from what exists.
- The library review was desk-only (registry metadata and general knowledge of
  each design); see "Library review findings" for what remains unchecked.

## Decisions

- **Command surface (was question 1):** `edit` with arguments that are all
  `#tag` tokens opens the query view, including a single tag (`edit #todo`).
  Other `edit` arguments keep today's behavior (pick one item from a text
  search and open it alone).
- **Item types (5):** only text, url and image items appear; other item types
  that can carry tags are left out. For url and image blocks the notes and
  tags are editable; the image itself is shown static.
- **Edits apply instantly (6):** there is no save step in a block. Edits are
  written as they are made and flushed when the block closes, whether by
  `<Esc>` or by a fold command collapsing it.
- **Folding (6):** the `z` bindings open and close blocks; they do not enter
  edit mode.
- **Outline (7):** the outline lists each block's title, falling back to the
  top line, or the first line of the notes for url and image items. No preview
  sidebar: every block that is not being edited is already rendered.
- **Top toolbar (8):** collapsible, with a small handle like the sidebar
  separators. The only control decided so far is sort; the rest is open.
- **Vim command area (9):** modal. It belongs to the whole document, or to the
  inline editor while one is open.
- **Liveness (10):** the document updates live as items and tags change.
- **Mobile (12):** out of scope.

- **Manual order:** stored per query, keyed by its sorted tag set. This is the
  simplest option, and the lists feature is undesigned, so a saved-list model is
  a later change. Consequence: renaming or changing a query's tags starts a
  fresh order.
- **Routing:** a `tags` field on the existing `editor:open` topic, with window
  key `editor-query-<sorted tags>`. It is the smallest change to the
  panel/background seam and is cheap to replace later.
- **Outer surface:** plain DOM blocks (`features/editor/query-surface-dom.js`),
  with `content-visibility: auto` on each block. Both plain DOM blocks and
  CodeMirror with block decorations were built as trials and compared; the
  CodeMirror surface and the options it added to `codemirror.js` were removed.
  Block-editor libraries were ruled out on paper by the library review.
  Comparison, from the trial results (headless Electron 43, Apple M4, 1000
  generated blocks):
  - `j`/`k` and block folding: DOM blocks map selection and fold to blocks
    directly through `select`/`fold`/`unfold`. CodeMirror moves `j`/`k` by
    document line (heading, blank line, each body line) and `j` from a folded
    block steps into the hidden body and reveals it, so it needs a custom
    block-wise `j`/`k`; its `zc zo za zM zR` needed a facet added to
    `codemirror.js` so they fold blocks rather than markdown heading sections.
  - One vim command area taken over by the inline editor: DOM blocks have no
    outer vim instance, so the inline editor is the only one and owns the
    status line while open. Two vim-enabled CodeMirror instances coexist with
    separate state, but each opens its own `.cm-vim-panel`, so two prompts can
    be open at once; sharing one status line needs a takeover that was not
    built.
  - Search, `:` commands and marks: CodeMirror gets `/`, `n`, `:` and marks
    from vim (not exercised live; `:w`/`:q` would act on the outer surface
    unless overridden). DOM blocks have none of them: search is Chromium
    find-in-page (sees every block despite `content-visibility`), and `:`
    commands and marks need a small key handler and table. This is the one
    criterion CodeMirror wins; it is new code for DOM blocks, accepted because
    the nav/folding slice already adds that handler.
  - About 1000 blocks: mount, fold-all, unfold-all and selection across 100
    blocks took 3.2-4.6, 1.8-2.2, 1.4-1.8 and 20.5-22.4 ms for DOM blocks, and
    3.7-16.6, 7.8-18.3, 6.1-13.6 and 38.0-46.5 ms for CodeMirror. Neither
    stalls, so no virtualizer is indicated. Selection costs about 0.2 ms per
    step for DOM against 0.4 for CodeMirror. Not measured for either: real
    scrolling, rendered markdown, the affordance column.
  - Single-document editor tests: the CodeMirror trial changed `codemirror.js`
    (`lineFolds`, `extraExtensions`, a `blockFoldAt` facet) with defaults kept;
    `editor-folding.spec.ts` was not run against it. DOM blocks touch none of
    it.
  - Pick and reason: DOM blocks. Block navigation and fold are native to it,
    it adds no second vim instance and no second status line, selection is
    cheaper, and it does not touch the single-document editor. CodeMirror's
    advantage (vim search, `:` and marks for free) is outweighed by having to
    rework `j`/`k`, block folds and the status line anyway.
  - Kept: the `syntheticBlocks=N` measurement hook in `home.js`, which drives
    the DOM surface and is needed for the later measurement at scale with
    rendered markdown.
- **Scale:** measuring at about 1000 blocks is a task inside each trial. The
  virtualizer options in "Library review findings" are reached for only if the
  measurement shows a stall.
- **Live updates while editing:** when an open block's item is retagged out of
  the query or deleted, the block freezes visually and fades out. Edits made
  elsewhere to an open item are not merged in v1: the open inline editor keeps
  its text until it is closed.
- **Add item:** a control in the query view creates a new text item pre-tagged
  with all of the query's tags and opens it in the inline editor. This lets a
  group be extended without leaving the document.

## Implementation slices

Each slice is its own enabled spec under `specs/`, landable on its own with its
own verify, in this dependency order:

1. `tag-query-open` — `edit #tags` command, query resolution, `editor:open`
   `tags` field and window key.
2. `editor-top-toolbar` — top toolbar in `EditorLayout` with the sort dropdown.
3. `tag-query-dom-surface-trial` — plain DOM block outer surface, with
   measurements.
4. `tag-query-codemirror-surface-trial` — CodeMirror block-decoration outer
   surface, with measurements.
5. `tag-query-surface-pick` — comparison against the criteria and the pick.
6. `tag-query-block-rows` — affordance left column, per-type rendering.
7. `tag-query-block-nav-folding` — `j`/`k` and block folding.
8. `tag-query-inline-editor` — inline editor, single vim command area takeover,
   `<Esc>` cascade.
9. `tag-query-live-updates` — live document with freeze-and-fade.
10. `tag-query-add-item` — add a new item pre-tagged with the query's tags.
11. `tag-query-manual-order` — manual order per query.
