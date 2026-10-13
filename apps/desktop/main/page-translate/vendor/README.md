# Vendored: Bergamot translator glue

`bergamot-translator.js` is the Emscripten glue for the Bergamot translator wasm that Firefox
uses for its built-in translation. It is copied byte for byte, unmodified.

- Upstream path: `toolkit/components/translations/bergamot-translator/bergamot-translator.js`
  in the Firefox source tree (GitHub mirror `mozilla-firefox/firefox`).
- Upstream revision: `48d55cf7ec80093903e2ef7f58b61a84a22ef716` (2026-01-29, "Bug 1968038").
- Glue version: `BERGAMOT_VERSION_FULL = "v0.6.0+eea6e5a8"`, matching the major-3 wasm records
  of the Remote Settings collection `translations-wasm`
  (`engine-files.ts SUPPORTED_ENGINE_MAJOR_VERSION`).
- SHA-256: `faff1ef6285b0d26f01787776fd49299dfb756ecb9688aa990c250e66797b47d`.
- License: Mozilla Public License 2.0 (header kept in the file;
  https://mozilla.org/MPL/2.0/). The file stays a separate file so the MPL terms apply to it
  alone.

The wasm itself is not vendored: `engine-files.ts` downloads it from Remote Settings.

The build copies this directory to `dist/main/page-translate/vendor/` (the `build` script in
`apps/desktop/package.json`), because `tsc` compiles only `.ts`. `engine-bergamot.ts
BERGAMOT_GLUE_PATH` points at the copy. The engine process reads it with `fs.readFileSync`,
which Electron's asar support serves from inside `app.asar`, so no `asarUnpack` entry is needed.

To update: replace the file with the upstream one at a newer revision, update the revision and
hash above, and keep the glue's major version in step with
`engine-files.ts SUPPORTED_ENGINE_MAJOR_VERSION`, because the glue's `TranslationModel`
signature changes with the major version.
