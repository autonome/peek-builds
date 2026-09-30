---
enabled: true
touches: [apps/desktop/main/adblocker.ts, apps/desktop/main/adblocker-fallback.ts, apps/desktop/main/adblocker.test.ts, apps/desktop/main/session-partition.ts, apps/desktop/main/download-filename.ts, apps/desktop/main/session-partition.test.ts]
depends-on: []
---

# Move the adblocker fallback and download filename helpers out of electron-loading modules so their tests import them

Part of Peek item `57895545`. This slice covers the two flagged main-process tests whose product
code is pure but sits in a module that imports `electron`: `adblocker` and `session-partition`.

## Problem

The main unit tests run as `NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test
dist/main/*.test.js`, where `import ... from 'electron'` cannot load. So both tests copy the code
they check:

- `apps/desktop/main/adblocker.test.ts` re-creates `BUNDLED_FALLBACK_FILTERS` and
  `buildFallbackEngine()` from `apps/desktop/main/adblocker.ts` ("the module keeps
  buildFallbackEngine internal"). The copy has diverged: it lists 5 rules, the real constant about
  30 (`advertising.com`, `pubmatic.com`, `criteo.com`, comment lines starting `!`, and more).
  `adblocker.ts` imports `app` and `session` from `electron` and `getProfileSession` from
  `./session-partition.js`. Its last case, `simulateInit`, re-implements a try/catch around
  `ElectronBlocker.parse` and exercises no product code at all.
- `apps/desktop/main/session-partition.test.ts` copies `resolveUniqueDownloadPath()` and
  `sanitizeDownloadFilename()` from `apps/desktop/main/session-partition.ts` ("the implementation
  in session-partition.ts is the authoritative copy - keep in sync"). Both copies currently match
  behaviour. `session-partition.ts` imports `electron` plus window-registry, protocol and
  permission-handler, so it cannot load under the electron runner.

## What goes

Precedent: `main/izui-roles.ts` is a pure leaf that `session-partition.ts` already imports
(`downloadCloseTarget`), and `main/izui-roles.test.ts` imports it with a plain static import.

1. `adblocker.ts`: move `BUNDLED_FALLBACK_FILTERS` and `buildFallbackEngine()` into a new
   `apps/desktop/main/adblocker-fallback.ts`, exported. It imports only `ElectronBlocker` from
   `@ghostery/adblocker-electron` (the existing test already imports that package under the
   electron runner). `adblocker.ts` imports both back; `initAdblocker()` keeps calling
   `buildFallbackEngine()` in its fallback branch. The constant's content and the comment block
   above it move verbatim. Nothing else references either symbol.
2. `session-partition.ts`: move `resolveUniqueDownloadPath()` and `sanitizeDownloadFilename()`,
   with their doc comments, into a new `apps/desktop/main/download-filename.ts` (imports only
   `node:fs` and `node:path`), exported. `session-partition.ts` imports both back for their two
   call sites in `_registerDownloadHandlerImpl`; its own `fs` / `path` imports stay because
   `getDownloadsDir()` and others still use them. No re-export is needed: the only importer of
   either function outside `session-partition.ts` is `session-partition.test.ts`.
3. `adblocker.test.ts`: import `buildFallbackEngine` and `BUNDLED_FALLBACK_FILTERS` from
   `./adblocker-fallback.js`, delete the inline constant, and drive the cases through
   `buildFallbackEngine()`. Delete the `simulateInit` case and the long comment justifying it
   (name the deleted case in the commit message). Add one case that a rule present only in the
   real list is blocked (for example a request to `https://criteo.com/x.gif`), so the test can no
   longer pass against a 5-rule copy. Update the header comment, which says the module cannot be
   imported.
4. `session-partition.test.ts`: import both functions from `./download-filename.js`, delete the
   two inline copies and the "keep in sync" header. Cases and their temp-dir helpers stay.

## What stays

- Behaviour of `initAdblocker()`, `registerDownloadHandler()` and the will-download handler:
  the moved functions are byte-for-byte the same.
- `session.test.ts` and its extractions belong to peek item `c243fdb6`; do not touch them.
- No other module imports the moved symbols today, so `entry.ts`, `ipc.ts`, `tile-ipc.ts` and
  `index.ts` (importers of `adblocker.ts`) need no edits.

## Verify

Run each in its own Bash call and record counts under **Result**.

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/adblocker.test.js apps/desktop/dist/main/session-partition.test.js
node scripts/lint-test-honesty.mjs
```

Done when the build compiles, both test files report `fail 0` (adblocker: previous cases minus
`simulateInit` plus the added real-list case; session-partition: the same 15 cases as before),
and neither `adblocker.test.ts` nor `session-partition.test.ts` appears in the lint output
(the lint still exits 1 while other flagged files remain). Then run the repo gate
(`NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js` and
`NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js`) and record `fail 0`.
