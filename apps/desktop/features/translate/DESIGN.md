# Page translation on the device

Translates web pages inside Peek with Mozilla's Bergamot translator and the models Firefox's
built-in translation uses. Page text never leaves the machine: the only network traffic is
downloading the engine and model files from Mozilla's settings server and attachment CDN.

This is a built-in feature (`features/translate/`) backed by main-process code
(`main/page-translate/`). It is not a change to any imported Chrome extension.

Nothing here is built yet beyond the engine spike (`tools/translate-spike/spike.mjs`).

## Engine

Bergamot runs as WASM in an Electron `utilityProcess`, not in a tile:

- `main/tile-csp.ts DEFAULT_CSP_DIRECTIVES` blocks workers and has no `wasm-unsafe-eval`.
- A separate process keeps translation CPU off the main process and survives a lazy tile
  being put to sleep.
- The process reads model files from disk itself, so model bytes never cross IPC.

**Chosen build: Firefox's** — Remote Settings collection `translations-wasm`, record
`bergamot-translator`, highest `version` (3.0 at the time of writing, about 5 MB, bergamot
`v0.6.0`), with the glue `bergamot-translator.js` from Firefox
`toolkit/components/translations/bergamot-translator/` (MPL-2.0).

What the spike established, under plain Node 24 on an Apple M4, en→de `base-memory` model 3.0:

| | Firefox build (v0.6.0) | npm `@browsermt/bergamot-translator` 0.4.9 (v0.4.5) |
|---|---|---|
| Loads current models | yes | yes |
| Runtime init | ~15 ms | ~12 ms |
| Model construction | ~60 ms | ~60 ms |
| First sentence (warm-up) | ~120 ms | ~130 ms |
| Inline HTML segment | ~16 ms, markup kept | same |
| Batch of 5 paragraphs, 103 words | ~190 ms, ~540 words/s | same |
| Process RSS after one pair | ~330 MB | ~430 MB |

Both produce identical output. Firefox's build is chosen because it is the one Mozilla ships
and updates alongside the models, its glue links the matrix-multiply imports itself, and its
`TranslationModel` carries the language pair. The npm build is unmaintained and leaves the
`wasm_gemm` import to the caller.

What the glue needs:

- No browser globals. With `Module.wasmBinary` supplied, the Emscripten glue takes neither its
  web nor its worker branch and never fetches; it uses only `WebAssembly`, `console` and
  `performance`.
- Firefox's glue is a single `function loadBergamot(Module)` declaration with no export, so the
  host evaluates the file and calls it (the spike uses `new Function(src + 'return
  loadBergamot')`). Ready is signalled through `Module.onRuntimeInitialized`; failure through
  `Module.onAbort`.
- `WebAssembly.mozIntGemm` does not exist outside Firefox. The glue detects that and falls
  back to the integer matrix-multiply built into the wasm (`Using fallback gemm
  implementation`). The measured speed above is with the fallback.
- API (v0.6): `new BlockingService({cacheSize: 0})`; `new AlignedMemory(bytes, alignment)`
  with alignment 256 for the model and 64 for lex and vocab files; `AlignedMemoryList` of one
  `vocab` or of `srcvocab` then `trgvocab`; `new TranslationModel(src, tgt, configText, model,
  lex, vocabs, null)`; `service.translate(model, VectorString, VectorResponseOptions)` or
  `service.translateViaPivoting(m1, m2, …)`; `responses.get(i).getTranslatedText()`; every
  wasm-side object freed with `.delete()`.
- The config is Marian YAML text, indented as in Firefox's
  `translations-engine.worker.js BergamotUtils.generateTextConfig`. `gemm-precision` is
  `int8shiftAlphaAll` for `*.intgemm.alphas.bin` models and `int8shiftAll` for
  `*.intgemm8.bin`; every model in the catalogue at the time of writing is an alphas model.

Runs single-threaded (`cpu-threads: 0`). Whether the build requires WASM SIMD was not
checked; Electron's V8 supports it either way.

### Engine process

`main/page-translate/engine-host.ts createEngineHost` is the main-process side and satisfies
`page-session.ts SessionEngine`. It forks `engine-worker-main.js` as a `utilityProcess` on the
first non-empty request, holds requests until the process reports `ready`, matches replies by
request id, and turns an aborted `AbortSignal` into an immediate rejection plus a `cancel`
message. A process exit fails every outstanding request with `engine-exited`; the next request
starts a new process. After five idle minutes (`DEFAULT_ENGINE_IDLE_MS`) the process is
stopped: rebuilding a model costs ~60 ms, while a loaded engine holds ~330 MB.

The process (`engine-worker.ts createEngineWorker`) translates one request at a time in arrival
order; a `cancel` aborts the running request or drops a queued one. Messages are in
`engine-protocol.ts`. `PEEK_TRANSLATE_ENGINE=stub` selects a stub engine that uppercases text
outside tags and entities (`PEEK_TRANSLATE_STUB_DELAY_MS` adds a per-segment delay); any other
value selects Bergamot (`engine-bergamot.ts createBergamotEngine`). The child
inherits main's environment, so the flag set on the app reaches it. The entry point also speaks
Node's `child_process` IPC, which is how the main-process unit test runs a real engine process:
`utilityProcess` does not exist under `ELECTRON_RUN_AS_NODE`.

The Bergamot engine reads every file it needs from the request: a translate message carries
`resources` (`engine-protocol.ts EngineResources`: the wasm path and one or two directions with
their model files on disk, built from `model-provider.ts ReadyStep`s by
`engineStepsFromReady`), so the process never reaches the network or the catalogue. A request
without them answers `engine-unavailable`. The runtime loads once per wasm path; a different
wasm path (a newer engine version) replaces it and frees every model. One `TranslationModel`
per direction is kept built, the four most recently used (`MAX_WARM_MODELS`), because each
holds ~30–60 MB of wasm heap. A pivot pair runs through `translateViaPivoting` with both
directions, as Firefox does, which keeps inline HTML aligned across both legs. Segments go to
the engine eight at a time (`SEGMENTS_PER_CALL`), with a turn of the event loop between calls
so a `cancel` lands; blank segments come back unchanged without reaching the engine, because
empty text breaks it. Errors: `engine-load-failed` (retried on the next request),
`model-files-missing`, `bad-request` (steps that do not chain from `from` to `to`).
Measured through a forked engine process on an Apple M4 with es→en base-memory 3.0: runtime +
model + three sentences 225 ms cold, a short HTML paragraph 13 ms warm, engine RSS ~280 MB.

## Models

Remote Settings collection `translations-models-v2`
(`https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models-v2/records`).
Records carry `sourceLanguage`, `targetLanguage`, `fileType` (`model`, `lex`, `vocab`, or the
split pair `srcvocab` + `trgvocab`), `architecture` (`tiny`, `base`, `base-memory`),
`version`, `decompressedHash`, `decompressedSize`. Attachments are zstd-compressed and served
from the CDN named by the server root's `capabilities.attachments.base_url`.

- About 35 MB per pair on disk, one direction per model, mostly to or from English. A
  non-English pair pivots once through `en`.
- Several models of the same pair coexist in the catalogue (18 pairs have two, across
  versions 3.0, 3.0a1 and 3.1 and architectures). Each record's `filter_expression` says which
  Firefox builds it is for, and it decides most of these: `env.appinfo.OS == 'Android'` /
  `!= 'Android'` splits en-ko, en-ru, ja-en, ko-en and zh-Hans-en between a phone model
  (base-memory 3.1, split vocab) and a desktop one (base 3.0); `env.channel == 'default' ||
  env.channel == 'nightly'` marks the 3.0a1 pre-releases nightly-only, so nn-en has no release
  model at all. Peek evaluates filters as a desktop release build and drops any record whose
  filter it cannot read.
- Selection, `main/page-translate/model-store.ts resolvePlan()`: of the records that pass the
  filter, have a major version the engine reads (3) and form a complete model (`model`, `lex`,
  and `vocab` or both `srcvocab` and `trgvocab`), a preferred architecture wins when present,
  then the newest version (`3.0a1` < `3.0` < `3.1`). No direct pair → one pivot through `en`;
  otherwise the result names the missing legs.
- Cache in `<userData>/translations/`: `records.json` and
  `models/<src>-<tgt>/<architecture>/<version>/<fileType>` (`model-store.ts cachePath()`, which
  rejects any record whose fields would leave the cache root). Writes go to `.tmp` and are
  renamed into place, as in `main/adblocker.ts`. Each download is checked against
  `attachment.hash`/`size` and each decompressed file against `decompressedHash`/`Size`
  (`verifyAttachment()`, `verifyDecompressed()`; both SHA-256, confirmed on the real en-de
  files) before it is used.
- Fetched from main with `net.fetch`, directly from Mozilla's Remote Settings servers: they
  are the canonical, already-hosted source, and every file is checked against its record's
  hash anyway. `main/page-translate/model-download.ts`: the server base is the one constant
  `DEFAULT_REMOTE_SETTINGS_SERVER`, overridable per call (`server`), and the attachment host is
  read from the server root, so a mirror serving the same API replaces both with no other
  change. `downloadModelFile()` reuses a cached file whose bytes still match, otherwise
  fetches, checks the attachment hash, zstd-decompresses (Node's built-in `zlib`), checks the
  decompressed hash, and writes `.tmp`-then-rename; `downloadPair()` does every file of one
  model; `readRecordsCache()`/`writeRecordsCache()` keep `records.json`. Attachment
  `location`s that are absolute or climb out of the base are refused.
- `main/page-translate/model-provider.ts createModelProvider({fetch, root, server?})` ties
  these together: `records()` fetches the catalogue once per session and writes `records.json`,
  falling back to the last `records.json` when the server cannot be reached so pairs already
  on disk keep working offline (`refresh: true` fetches again); `plan(from, to)` resolves
  without downloading; `ensure(from, to)` resolves and downloads every file of every step and
  answers with their paths, or with the plan's failure. Concurrent `ensure` calls for one pair
  share one download. `translate-main.ts pageTranslationModels()` builds it over Electron's
  `net.fetch` and `<userData>/translations` on first use. It asks nothing: consent comes from
  its caller. A real es→en download through it (base-memory 3.0, 37 MB on disk from 25 MB of
  attachments) took ~1.7 s with all three hashes matching.
- Managing models: `model-inventory.ts` lists the directions on disk with their size (one
  `models/<src>-<tgt>` folder each, named back to languages by `model-store.ts
  parsePairDirName`), deletes one, and estimates a download (`estimateDownload`: compressed
  bytes still to fetch, counting files already present at their expected size as free, plus
  the bytes on disk afterwards). `model-topics.ts` publishes these on pubsub
  (`translate:models:list` / `:estimate` / `:download` / `:delete`, answered on `:listed` /
  `:estimated` / `:progress`). A download request is itself the consent: the view sends it only
  after the user accepted a prompt naming the size, once per pair before its first download.
  A plain list stays local; the catalogue is read only when the list asks for it, since that
  may contact the server.

## Main-process side, `main/page-translate/`

- `engine-host.ts` — spawns and keeps the utility process; requests `{segments, isHTML}` by id;
  the process exits after a few idle minutes.
- `model-store.ts` — catalogue, download, hash check, decompression, cache.
- `page-session.ts` — one session per window: a pure `transition(state, event)` returning
  effects, and `createPageSession({page, engine})`, which carries them out. Phases idle →
  collecting → translating ⇄ translated → restoring → idle, plus closed after
  `page:will-close`. While translated, `drain()` is polled on a timer. Every request carries a
  run number; showing the original, navigating, closing and failing start a new run, so late
  engine results or page replies from the old run are dropped, and the engine request's
  `AbortSignal` fires before dispatch returns. Navigation goes straight to idle (the document
  holding the originals is gone); a failure restores the page; a failed restore reloads it.
  A batch is sent to the engine as at most two requests, HTML units and plain-text units. A
  `translate` while a session is active is ignored by the session itself;
  `translation-service.ts` turns it into show-original-then-translate.
- `translation-service.ts` — `createTranslationService({pageFor, engine, onState})` keeps one
  session per window id over one shared engine; `translate(windowId, {from, to})`,
  `showOriginal`, `navigated`, `closed`, `state`, `dispose`. A `translate` with another
  language pair while a session is active shows the original and starts the new translation
  once the page is restored, so one command changes the target language; the same pair again
  does nothing; if that restore fails the page reloads and the queued translation is dropped.
  `pageFromWebContents(wc)` runs scripts in isolated world `TRANSLATE_WORLD_ID` (1001;
  Electron reserves 0 and 999, nothing else in Peek claims one).
- The injected translator is replaced when `injectionSource` is called with other options
  (`targetLang` is among them), because its translation cache is keyed by source text only and
  would otherwise reapply the previous language's translations after a restore.
- `content-script.ts` — `pageTranslator(document, {pageLang, batchSize, viewportMargin})`,
  a self-contained function that unit tests call on a linkedom DOM and that
  `injectionSource()` serialises with `toString()` for the isolated world (installed once as
  `globalThis.__peekPageTranslator`); `callSource(method, arg)` builds each call. It is
  TypeScript in `main/` rather than a `.js` file because the build compiles only `.ts` there,
  and its test is `main/page-translate-content-script.test.ts`.

## Reaching the page

`executeJavaScriptInIsolatedWorld` on `hybrid-overlay.ts getHybridContentWC(id)`, following
`wireExecuteScript`. Main pulls and owns every transition:

- `collect()` scans the page, queues every unit and returns the first batch of work items
  `{id, text, isHTML}`, units near the viewport first. Block units are HTML; attribute units
  are plain text, so main groups a batch into one engine request per `isHTML` value.
- Main translates and calls `apply([{id, text}])`. A unit whose source changed after it was
  handed out is re-queued rather than overwritten.
- While translated, main polls `drain()` for the rest of the scan and for content a
  MutationObserver queued; units near the viewport are re-prioritised on every call.
- Translations are cached by source text for the page's lifetime, including across a
  restore, so identical text is applied without another engine call.
- Original child nodes and attribute values are kept, so `restore()` puts back the same node
  objects with no reload; `wc.reload()` is the fallback.

## Page text handling

Modelled on Firefox's `translations-document.sys.mjs TranslationsDocument`:

- A recursive walk over elements, including open shadow roots (a hand-written walk rather
  than a TreeWalker, which cannot skip a subtree without a filter). There is no layout in the
  walk: an element counts as inline by tag name (`a`, `b`, `span`, `em`, …); anything else is
  a block. A block with text of its own, directly or through inline children, is a unit; a
  block nested inside a unit is its own unit and a placeholder in the outer one.
- Skipped: `code`, `kbd`, `samp`, `var`, `pre`, `script`, `style`, `noscript`, `template`,
  `textarea`, `iframe`, `svg`, `math`, media and `select` elements, `translate="no"`,
  `.notranslate`, contenteditable regions, and elements whose `lang` primary subtag differs
  from the page's.
- A unit is sent as HTML in which every inline element is reduced to `<tag data-t="n">` (no
  other attributes) and every other element is an empty placeholder. Results are parsed in an
  inert `<template>` and merged back by index onto the original elements, so listeners,
  attributes and references survive and the engine's reordering is followed. Placeholders the
  engine drops are appended at the end of the unit rather than lost. The engine keeps inline
  markup in place (verified by the spike for `<a>` and `<b>`).
- Attributes translated: `title`, `alt`, `placeholder`, `aria-label`, `aria-description`, and
  `value` on button-type inputs.
- Known limits: content a page adds inside an already translated unit is left untranslated;
  the MutationObserver watches `document.body` only, so new content inside shadow roots is
  not picked up.
- Visible blocks first, DOM updates batched, a per-session result cache, and a
  MutationObserver that re-queues new content.

## Feature, `features/translate/`

A lazy tile with `lazyEvents: ["page:translatable"]`, commands and settings, and no network
capability (downloads happen in main).

- Commands: `translate page` (optional target language), `show original`, `translate
  language`, `manage translation models`.
- Settings: target language (defaults to the OS locale), offer translation automatically (off
  by default), always translate from these languages, model architecture.
- UI: a page widget, following `features/pagewidgets-sample/background.js`, showing
  "Translate from X", progress and "Show original"; a models manager built on `<peek-*>`
  components.
- Handlers are registered synchronously in `init()` and guarded on an `initReady` promise, as
  in `features/websearch/home.js`.
- The wasm is not bundled: `main/page-translate/engine-files.ts createEngineProvider`
  downloads the newest `translations-wasm` record named `bergamot-translator` of major version
  3 through the same overridable server base as the models (`model-download.ts`), checks it
  against the record's attachment hash and size (the wasm is served uncompressed), and caches it
  at `<userData>/translations/engine/bergamot-translator/<version>/bergamot-translator.wasm`
  with the record list in `engine/records.json` for offline use. Only major 3 is accepted
  because the glue's API (the `TranslationModel` signature) changes with the major version.
- The glue is not in any Remote Settings collection (Firefox ships it in its source tree), so
  it is the one part that must ship with Peek, pinned to the v3 wasm. It is vendored unchanged
  at `main/page-translate/vendor/bergamot-translator.js` (MPL-2.0; upstream path, revision and
  hash in `vendor/README.md`) and copied to `dist/main/page-translate/vendor/` by the build,
  because `tsc` compiles only `.ts`. The engine process reads it from inside `app.asar`, so it
  needs no `asarUnpack` entry.

What exists now (`background.js`, `translate-logic.js`, tested by
`tests/unit/translate-tile.test.js`):

- The tile is lazy and wakes on its two commands and on `page:translatable`. It subscribes in
  `init()` with no await at all, so it needs no `initReady` guard until settings arrive.
- A command acts on the window `api.window.getFocusedVisibleWindowId()` names, the same front
  window the `tags` commands use, rather than one remembered from `page:loaded`, because the
  front window is what the user means and a remembered one goes stale when windows switch.
- The source language is the page's declared one, read with `page:execute-script`
  (`<html lang>`, then the `Content-Language` meta) and cut to its primary subtag. A page that
  declares nothing is refused with a message until text-based detection exists. The target is
  the command's argument, else `navigator.language`, both cut the same way.
- The status widget is drawn only when the `translate:state` window is the front window,
  because the widget lives in the shared chrome of the window in front. While a translation
  runs or is shown, it carries a "Show original" `<peek-button>` with
  `data-widget-action="show-original"`. The page-widget host
  (`renderer/page/page-widgets.js widgetActionFromPath`, wired in `overlay.js addWidget`)
  publishes a click on any element carrying `data-widget-action` as `widget:action
  {extensionId, widgetId, action, value, windowId}`, `windowId` being the window whose chrome
  showed the widget; the tile turns it into `translate:show-original` for that window
  (`translate-logic.js widgetActionRequest`), so the click acts on the window it was made in
  rather than whichever window reads as focused once the chrome takes the click. The widget
  closes when the page is back to its original.
- The translation offer: on `page:translatable {windowId, url, lang}` for the front window,
  the same widget shows "This page is in X." with a "Translate from X" `<peek-button>`
  (`data-widget-action="translate"`, `data-widget-value="<from> <to>"`); the click becomes
  `translate:page` for the clicked window (`translate-logic.js offerView`,
  `widgetActionRequest`). The value carries both languages, so the click alone names the
  request and the tile keeps no memory of what it offered. The target is
  `navigator.language`. The offer is shown by default; the "offer translation automatically"
  setting does not exist yet. A `page:loaded` for the window whose offer is showing closes it
  (it comes before that load's own `page:translatable`), and a translation's status replaces
  it. After "Show original" no offer comes back until the next load.
- `manage translation models` is a declarative `window` command opening `models.html` (a
  `workspace` window, key `translate-models`), so the background tile is not woken for it.
  The view (`models.js` over the pure `models-logic.js`, tested by
  `tests/unit/translate-models.test.js`) is built on `<peek-card>`, `<peek-button>` and
  `<peek-dialog>` with the lit importmap. Opening it publishes `translate:models:list
  {catalogue: true}`, because opening the manager is the request to see what can be
  downloaded. It lists model directions, not language pairs: what is on disk with its size
  and a Delete button, and every other catalogue direction with a Download button. A pair
  that pivots through English is its two directions, each listed on its own. Download
  publishes `translate:models:estimate` first and opens a prompt naming the bytes to fetch
  (and the size on disk when larger); only Download in the prompt publishes
  `translate:models:download`, while Cancel, Escape and the backdrop publish nothing. When
  the estimate finds every file already on disk, the download is published without a prompt,
  because nothing would be fetched. Answers carrying no catalogue (those after a download or
  delete) keep the list already shown.

## Language detection

The page's declared language first (`<html lang>`, then the `Content-Language` meta), cut to
its primary subtag; `und`, `zxx`, `mul` and `mis` name no language and count as undeclared.
When a hybrid page finishes loading, `ipc.ts wireHybridContentEvents` calls
`page-translate/translate-main.ts pageTranslationLoaded`, which reads the language in the
translator's isolated world (so page scripts cannot change what the read sees) and publishes
`page:translatable {windowId, url, lang}` when it differs from `app.getLocale()`
(`page-translate/page-language.ts translatableLanguage`). Main compares with the system
language because the target-language setting does not exist yet; once it does, main reads
it, so a page already in the user's language never wakes the tile. Detection from page text
(CLD2, Apache-2.0, as Firefox does) is a later addition.

## Undecided

- Whether the engine and models come from Mozilla's servers directly or from a mirror on a
  Peek-run host.
- Model download consent: proposed as an explicit prompt naming the size before each pair.
- Scope: web pages only, not `peek://` pages. Peeks and slides windows are undecided.
- The utility process's idle exit delay.
