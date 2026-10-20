---
enabled: true
touches: [apps/desktop/main/tile-protocols.ts, apps/desktop/main/tile-protocols.test.ts, apps/desktop/main/protocol.ts, apps/desktop/main/tile-preload.cts, apps/desktop/main/tile-ipc.ts, apps/desktop/main/tile-manifest.ts, apps/desktop/main/tile-api.d.ts, apps/desktop/features/features-manager/publish.js, apps/desktop/features/features-manager/manifest.json, apps/desktop/tests/desktop/tile-protocol-atproto.spec.ts, docs/design/tile-protocols.md]
depends-on: []
---

# Tile APIs as Web Tiles protocols, first slice: `atproto`

The design and every decision behind it are in `docs/design/tile-protocols.md` (section
"Decided"); read it first. This slice builds the shared protocol machinery and moves one API,
`atproto`, for one user, the features-manager publish wizard.

## What the code does now

- `main/tile-preload.cts` builds `api.atproto` (`request`, `sessionInfo`, `uploadBlob`), each
  waiting on `validationPromise` and invoking `tile:atproto:*` with `tileToken`.
- `main/tile-ipc.ts` registers `tile:atproto:request`, `tile:atproto:session-info` and
  `tile:atproto:upload-blob` through `registerTileIpc`, which checks the token; the handlers check
  the capability (`network`, see `runAtprotoProxy` and the session-info handler) and call
  `handleViolation()` on failure. The proxy itself is `main/atproto-proxy.ts`.
- `main/protocol.ts routeProtocolRequest()` serves `peek://<tile-id>/<path>` from the tile's own
  directory, plus the legacy `peek://ext/<id>/` form.
- Users of `api.atproto`: `features/features-manager/publish.js` (`uploadBlob`, `request`,
  `sessionInfo`), loaded at `peek://features-manager/publish.html`, and
  `features/lex/atproto.js`.

## What changes

1. **One registration per protocol.** New `main/tile-protocols.ts`: a protocol is declared once
   with its name, the capability that gates it, and its methods as main-process handlers. From
   that declaration it registers one IPC handler per method that checks the tile token and the
   capability on every call (calling `handleViolation()` on failure, as now) and produces the
   module source served to tiles. The per-tile ready queue for host-to-tile events belongs here
   too, but `atproto` pushes no events, so this slice leaves a clearly named place for it rather
   than building it.
2. **One generic preload bridge.** `tile-preload.cts` exposes a single call that a protocol module
   uses to reach a protocol method (protocol name, method, arguments), carrying `tileToken` and
   waiting on `validationPromise` itself. Any tile can call it directly; the main-process check
   in step 1 is the gate.
3. **Serving.** `routeProtocolRequest()` answers
   `peek://<tile-id>/.well-known/web-tiles/<name>.js` from the registry, taking the requesting
   tile from the host. A registered protocol whose capability the tile holds is served as a
   JavaScript module; an unknown protocol, or one the tile is not granted, gets the same failed
   response, so the tile's `import()` rejects identically in both cases. Requests under the legacy
   `peek://ext/` form are not served protocols.
4. **`atproto` moves.** Declare `atproto` through step 1 with the existing handlers' behaviour and
   gate unchanged. Its module exports `request`, `sessionInfo` and `uploadBlob` with the same
   arguments and results as `api.atproto`. `publish.js` imports it instead of reading
   `api.atproto`. `api.atproto` stays in the preload because `features/lex/atproto.js` and the
   tests below still use it; the old `tile:atproto:*` channels may be served by the new
   registration as long as both paths keep working.
5. **Manifest `protocols` field.** `main/tile-manifest.ts` accepts an optional
   `"protocols": { "<name>": "required" | "optional" }` and rejects any other value.
   `features-manager/manifest.json` declares `"protocols": { "atproto": "required" }`. A tile
   that lists a `required` protocol that is not registered, or whose capability it lacks, is not
   opened; the refusal is logged naming the tile and the protocol, through the same path that
   reports other manifest refusals today. An `optional` one never blocks opening.

Nothing else moves to protocols in this slice. Core surfaces stay on `window.app`.

## Tests to change

- New `main/tile-protocols.test.ts`: the registry derives one handler per method; a call without
  a valid token, or from a tile lacking the capability, is refused and reported; the served module
  for a granted tile exports exactly the declared methods; an ungranted or unknown protocol yields
  the same failure; the manifest `protocols` field accepts `required`/`optional` and rejects other
  values; a missing `required` protocol blocks opening and a missing `optional` one does not.
- New `tests/desktop/tile-protocol-atproto.spec.ts`: a tile granted the capability imports
  `/.well-known/web-tiles/atproto.js` and `sessionInfo()` returns the same result as
  `window.app.atproto.sessionInfo()` (signed out on a fresh profile); a tile without the capability
  gets a rejected import; importing `/.well-known/web-tiles/nonexistent.js` rejects the same way.
  Because a protocol module is ordinary page code, the wizard's import can be observed from the
  spec; assert `publish.html` loads with the `atproto` import resolved.
- Unchanged and still passing: `tests/desktop/atproto-session-info.spec.ts` and
  `tests/unit/lex-atproto-proxy.test.js`.

## Verify

```
yarn workspace @peek/desktop build
NODE_ENV=test ELECTRON_RUN_AS_NODE=1 npx electron --test apps/desktop/dist/main/*.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
yarn workspace @peek/desktop test:grep "atproto"
PEEK_LIVE_ATPROTO=1 HEADLESS=1 BACKEND=electron ./scripts/playwright-with-display.sh test --config apps/desktop/playwright.config.ts --project=desktop-serial --workers=1 --grep 'live atproto' --trace=off
```

Done when the unit tallies report `fail 0`, the `test:grep` run collects the new spec's tests
and they and `atproto-session-info.spec.ts` pass, and the live publish spec passes unchanged
(its credentials file is present on the Linux box; it publishes through the wizard, which now uses
the protocol). Record each run's pass/fail count under `**Result**` in the handoff, and add a line
under "Decided" in `docs/design/tile-protocols.md` stating that the slice is built and what
remains on `api.atproto`.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app. Read it before editing; `tile-preload.cts` stays
`.cts`. Run one command per Bash call.
