---
enabled: true
touches: [docs/features.md]
depends-on: []
---

# Rewrite docs/features.md as the reference for building a feature

Peek item `8fe5f28e`, first half (the `docs/` sweep is `specs/docs-sweep.md`). `docs/features.md`
is the page a newcomer building a mini app lands on, and it describes an older system.

## What the doc gets wrong (spot-checked, not exhaustive)

- Titled "Peek Extensions", with extension / `peek://ext/` vocabulary. The code calls these
  features (`apps/desktop/features/`); each is a set of tiles loaded through
  `apps/desktop/main/tile-preload.cts` with capabilities granted by its `manifest.json`.
- Says features live under `features/` at the repo root; they are under `apps/desktop/features/`.
- Claims `CONSOLIDATED_EXTENSION_IDS = ['cmd', 'groups', 'peeks', 'slides']` load as iframes in
  one extension-host window. Check against `apps/desktop/main/` before writing anything about
  hosting; there is no `cmd` feature directory.
- Lists about five features; there are now several dozen.

## What changes

Rewrite `docs/features.md` in place (keep the filename; links point at it) as "Building a Peek
feature". Every claim is checked against the code, not carried over:

- What a feature is: a directory under `apps/desktop/features/` with a `manifest.json` (schema
  v3) declaring tiles; how tiles load (`tile-launcher.ts`, `tile-preload.cts`), resident versus
  lazy tiles (`apps/desktop/CLAUDE.md`, "Lazy feature activation").
- The manifest: the fields the loader actually reads and validates (find the validator, cite it
  by file and symbol), including tiles, entries, commands, shortcuts, `pubsub.topics` (a
  consumer must list each topic it subscribes to), and capabilities.
- The `window.app` API: the namespaces a feature uses most, with a pointer to the full
  reference doc that exists (`docs/tile-api.md` or `docs/api.md`, whichever is current) rather
  than a second copy of it.
- UI: the `<peek-*>` component library and the required `lit` importmap
  (`apps/desktop/CLAUDE.md`, "UI").
- Starting point: the smallest real feature to copy (likely `hello-world`; confirm it is
  enabled and self-contained), walked through file by file.
- A short list of real features worth reading for common patterns, one line each.
- Lazy-tile init ordering: register wake handlers before any `await`.

Leave history out; if something in the old doc is still useful as background, it can move to
the bottom under "## History".

## Verify

```
grep -c 'peek://ext/' docs/features.md
grep -c -i 'extension' docs/features.md
```

The first prints 0. The second prints only mentions of Chrome extensions, if any. Every file
path in the rewritten doc exists (check each with `test -e`), and every manifest field and
`window.app` name it shows appears in `apps/desktop/main/` or `apps/desktop/features/`; list
those checks and their results under `**Result**` in the handoff. The repo gate in `tracks.json`
must still pass (no code changes, so it should).

## Working rules

Docs only; edit no code. Run one command per Bash call.
