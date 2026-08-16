# Tauri Desktop — Agent Guide

**This app is off the critical path.** It is months out of date and not actively maintained. Do not spend agent time on it unless explicitly instructed.

The canonical desktop app is `apps/desktop/` (Electron). Use `yarn test:desktop:electron` for all desktop testing, not anything in this subtree. (This subtree's own full suite, if ever needed, is `yarn test:desktop:tauri`.)

See `DEVELOPMENT.md` history for context on why Tauri desktop was paused.

## Schema fidelity checks are skipped, not enforced

The project is paused, so its schema fidelity checks in `packages/schema/fidelity.test.js`
(`Tauri Desktop Backend` describe block) and `packages/integration-tests/schema-consistency.test.js`
(`desktop-tauri` platform) are marked as skipped rather than run — they no longer gate
unrelated schema work, and they will not go red if this backend's schema drifts further
out of date. Before unpausing this project: remove the skip markers in both files, run
`yarn schema:test` and `node --test packages/integration-tests/schema-consistency.test.js`,
and bring `apps/tauri-desktop/src-tauri/src/datastore.rs` back in sync with
`packages/schema/v1.json` until both pass.
