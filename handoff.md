# Bake-off labelling tile

## Goal

Implement the current authority at `specs/bake-off-labeling.md`: one lazy built-in desktop tile for manually labelling task clusters, entity spans, and command-routing cases against live Peek data, with JSON export through the native save dialog.

## Current state

Complete and verified. The lazy built-in tile now provides the shared search/URL picker, date-driven task clustering, verbatim entity-span labelling, multi-call command-routing/refusal cases, and native JSON exports. The Playwright coverage exercises all three workflows, including range-reload reconciliation and a two-call routing payload, and calls each payload builder through the tile test hook.

## Resume Here

The independent-review findings are fixed. Next step: `/land`.

## Decisions

- Pasted URLs reuse an exact matching URL item when one exists; otherwise the picker creates an in-memory candidate with a stable `url:<url>` ID. It does not mutate the datastore.
- Export uses the current strict tile API signature, `dialogs.save(content, { filename, mimeType })`.
- Tile-internal payload builders are ES module exports and are also exposed through `window.__bakeOffLabelingTest`, matching the renderer-side Playwright hook pattern.
- Reloading a task date range keeps task-group names but removes assignments to items no longer in the loaded candidate set. This preserves useful labels while guaranteeing self-contained exports.

## Key files & symbols

- Authority: `specs/bake-off-labeling.md`
- Reference tile: `apps/desktop/features/entities/manifest.json`, `apps/desktop/features/entities/home.html`
- New tile: `apps/desktop/features/bake-off-labeling/`
- New test: `apps/desktop/tests/desktop/bake-off-labeling.spec.ts`
- APIs: `window.app.datastore.queryItemVisits()`, `queryItems()`, `extractPageContent()`, `window.app.dialogs.save()`
- MCP list source: `apps/desktop/features/mcp-server/server.js` `TOOLS`
- Research context: `docs/local-ai-needle-research.md`

## How to verify

- `yarn workspace @peek/desktop build`
- `yarn test:grep 'bake-off labeling'`
- Exercise all three workflows and directly assert all three export payload shapes per Requirement 6.

**Result**

The command-routing editor now accumulates multiple expected MCP calls per case, and task range reloads remove stale assignments so exports cannot contain dangling item IDs. Regression coverage verifies a two-call routing payload and range-reload reconciliation.

Verification:
- `yarn workspace @peek/desktop build` — passed
- `yarn test:grep 'bake-off labeling'` — 1 passed
- The prohibited full Electron gate was not run.

No person decision is required; ready to land.
