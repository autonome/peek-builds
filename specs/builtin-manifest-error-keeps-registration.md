---
enabled: true
touches: [apps/desktop/main/feature-installer.ts, apps/desktop/main/feature-installer.test.ts]
depends-on: []
---

# Builtin sync must not unregister a builtin because its manifest failed to parse

Peek item `75746811`. Nothing from it has landed. `syncBuiltinFeatures` in
`apps/desktop/main/feature-installer.ts` (called from `initializeFeatures` in
`apps/desktop/main/feature-startup.ts`) still prunes any registered builtin whose id it did
not collect during the disk scan, and it only collects an id after `JSON.parse`,
`detectManifestVersion(raw) === 'tile'` and `validateTileManifest(raw)` all succeed.

## What the code does now

In the scan loop, `onDiskIds.add(manifest.id)` happens after the three checks. Three paths
skip it: the `catch` (unparseable JSON), the `continue` when the manifest is not a tile
manifest, and the `continue` when `validateTileManifest` returns errors. The prune loop
(`registry.listFeatures({ sourceType: 'builtin' })`, `registry.unregisterFeature(entry.id)`)
then treats all three as "directory gone" and calls `registry.saveRegistry()`.

That unregister is not cosmetic: the `onUnregister` listener installed by
`initializeFeatures` fires the tile-lifecycle `UNINSTALL` trigger for every tile, removes the
`manifest_cache` row, and calls `dropManifestRulesForFeature(id)`, so a transient bad
manifest also discards the feature's rules rows.

A broken manifest has no usable `manifest.id`, and the directory name is not the id here
(`features/theme-basic` is id `basic`, `theme-peek` is `peek`, `theme-shichijuni` is
`shichijuni`). The only pre-parse handle is the directory path, and the registry stores
exactly that: every builtin entry's `path` is `path.join(featuresDir, entry.name)`, both in
the `!existing` register branch and in the update branch of this function.

## Change

In `syncBuiltinFeatures`:

- Add a second set, `onDiskPaths: Set<string>`, next to `onDiskIds`. In the scan loop, right
  after the `if (!fs.existsSync(manifestPath)) continue;` check and before the `try`, add
  `path.join(featuresDir, entry.name)` to it. A directory with no `manifest.json` is not
  added, so "manifest.json deleted" still counts as gone.
- In the prune loop, unregister only when `!onDiskIds.has(entry.id) && !onDiskPaths.has(entry.path)`.
  Compare `entry.path` by plain string equality against the same `path.join(featuresDir,
  entry.name)` expression the register/update branches use; do not add `path.resolve` or
  realpath normalisation.
- Replace the empty `catch { // Skip unparseable manifests }` body with a `console.warn`
  naming `entry.name` and the error message, matching the `Failed to scan` line in
  `scanBuiltinFeatures`. The two `continue` paths stay as they are.
- Nothing else changes: a present-but-broken builtin is not added, updated, or re-registered;
  `result.added` / `result.updated` do not mention it; the return type is unchanged. If it was
  never registered, it stays unregistered (there is no id to register it under).

Decision, already closed: a registered builtin whose `path` no longer matches any scanned
directory AND whose manifest is broken is still pruned. The path is the only handle, and
the next clean boot re-registers it as today.

No change to `tile-loader.ts` or `feature-startup.ts`. Once the entry survives sync,
`loadSingleFeature` in `apps/desktop/main/tile-loader.ts` already returns a non-`skipped`
error for it (`Manifest not available for <id> (cache miss + disk parse failed)`), which
`collectLoadErrors` in `apps/desktop/main/feature-list-entries.ts` picks up and the feature
card renders.

## Tests to change

`apps/desktop/main/feature-installer.test.ts`, inside the existing
`describe('syncBuiltinFeatures')`, using the file's `writeManifest`, `makeTileManifest` and
`makeV1Manifest` helpers. Each case pre-registers a builtin entry with
`path: path.join(featuresDir, '<dir>')` the way `'should remove builtins no longer on disk'`
does, then asserts `result.removed` is `[]`, `registry.getFeature(id)` is still defined, and
`result.added` does not contain the id.

- Invalid JSON: write the literal string `{ not json` to `<featuresDir>/theme-broken/manifest.json`
  (use `fs.writeFileSync`, not `writeManifest`), register id `broken` at that path. The
  directory name deliberately differs from the id so the test fails if the fix keys on names.
- Schema-invalid but parseable: `writeManifest(..., makeTileManifest('badschema', { tiles: 'nope' }))`
  (`manifestVersion: 3` keeps it a tile manifest; `validateTileManifest` rejects `tiles`).
- Non-tile manifest: `writeManifest(..., makeV1Manifest('oldstyle'))` with a registered
  builtin `oldstyle` at that path; also assert `result.added` is `[]` so the existing
  `'should skip v1 manifests during sync'` expectation still holds for this shape.
- Directory present, `manifest.json` absent: `fs.mkdirSync(path.join(featuresDir, 'hollow'))`,
  register builtin `hollow` at that path; assert `result.removed` includes `hollow` and
  `registry.getFeature('hollow')` is `undefined`.
- `'should remove builtins no longer on disk'` must keep passing unchanged.

## Verify

The new cases compile into `dist/main/feature-installer.test.js` and run under the electron
runner, so the repo gate covers them. Run:

```
yarn workspace @peek/desktop test:unit
```

Record pass/fail counts for both unit runners under `**Result**`. Done when the four new
cases pass alongside the existing `syncBuiltinFeatures` cases and nothing else in the two
runners newly fails.

## Working rules

Run one command per Bash call.
