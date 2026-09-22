---
enabled: true
touches: [apps/desktop/renderer/cmd/url-completion.js, apps/desktop/renderer/cmd/panel.js, apps/desktop/renderer/components/peek-navbar.js, apps/desktop/renderer/page/background.js, apps/desktop/tests/unit/url-completion.test.js, apps/desktop/tests/components/peek-navbar-autocomplete.spec.ts, apps/desktop/tests/desktop/cmd-url-ghost.spec.ts]
depends-on: []
---

# Loopback hosts get `http://`, not `https://`, when a default scheme is added

Peek item `c2ee1080`, part 1 only. When typed text has no scheme, the app adds `https://`,
including for loopback hosts. Local dev servers are almost always http-only, so opening
`localhost:3000` goes to `https://localhost:3000`, which fails. That URL is also written to history
as an item, and history now holds many `https://localhost*` rows that can never be reached. Part 2
of the item is out of scope: whether those existing rows are rewritten or deleted is still
undecided, and no data migration belongs in this spec.

## What the code does now

These places add a default scheme to scheme-less text, and every one of them adds `https://`:

- `apps/desktop/renderer/cmd/panel.js` `getValidURL(str)`: when `str` has no
  `https?|ftp|file|peek` scheme, it accepts `isDomainPattern` (the last label must be at least 2
  letters, and no port is allowed) or `isLocalhost` (`/^localhost(:\d+)?(\/.*)?$/`). Both branches
  return `'https://' + str`. Because of that recognizer, `127.0.0.1:8080`, `[::1]:8080` and
  `foo.localhost:3000` are not URLs at all (`valid: false`). `foo.localhost` with no port matches
  `isDomainPattern` and becomes `https://foo.localhost`. `getValidURL` feeds the `openURL` action
  (the `ENTER` payload's `isURL`/`url`) and the URL-mode Enter branch (`url-mode-typed`) of the
  `keydown` listener.
- `apps/desktop/renderer/cmd/panel.js` `openUrlGhost()`: below `'full'` granularity it opens
  `'https://' + completion`, where `completion` is the scheme-less matchable form from
  `currentGhostCompletion`. So a stored `http://localhost:3000` history item, accepted at `host`
  granularity, opens as `https://localhost:3000`.
- `apps/desktop/renderer/components/peek-navbar.js` `PeekNavbar._normalizeUrl(input)`: it keeps an
  explicit `http://`/`https://`. Every other input, with or without a dot, returns
  `'https://' + trimmed`. `_onUrlKeydown` calls it on Enter when no dropdown row is highlighted.
  That includes the case where an accepted inline ghost has put a scheme-less completion in the
  input.
- `apps/desktop/renderer/page/background.js` `getValidURL(str)`: a verbatim copy of the panel
  function, used by the `open` command (`open localhost:3000`). The item does not list this copy,
  but it is the same defect on the same kind of input.

## The change

1. `apps/desktop/renderer/cmd/url-completion.js` (a pure leaf module, still with no imports): add
   and export two functions.
   - `isLoopbackAddress(text)`: true when the host part of scheme-less `text` is loopback. The host
     part is everything before the first `/`, `?` or `#`, with an optional `:<digits>` port removed.
     A bracketed IPv6 host (`[::1]` or `[::1]:8080`) is taken whole, brackets included. Loopback
     means, case-insensitively: `localhost`, any `*.localhost`, `127.0.0.1`, or `[::1]`. Nothing
     else counts: no other `127.x` address, no RFC1918 LAN address, and no bare `::1` without
     brackets. Empty text or text containing whitespace returns false.
   - `withDefaultScheme(text)`: if `text` already starts with a scheme
     (`/^[a-z][a-z0-9+.-]*:\/\//i`), return it unchanged, so an `http://` or `https://` the user
     typed is kept exactly. Otherwise return `'http://' + text` when `isLoopbackAddress(text)` is
     true, and `'https://' + text` when it is not. The helper does not trim or validate; callers
     keep doing both.
   Add a doc comment explaining the rule: loopback dev servers are http-only, `https://localhost`
   can't be reached and pollutes history, and public hosts keep the https default.

2. `apps/desktop/renderer/cmd/panel.js`:
   - `getValidURL`: replace the `isLocalhost` regex with `isLoopbackAddress(str)`, so every loopback
     form in the item's list is recognized as a URL. Keep the `(\/.*)?` path allowance: a trailing
     path/query is fine and whitespace is not. Replace `'https://' + str` with
     `withDefaultScheme(str)`. The `new URL(...)` guard and the explicit-scheme branch stay as they
     are.
   - `openUrlGhost`: replace `'https://' + completion` with `withDefaultScheme(completion)`. The
     `'full'` / no-completion branch still opens `urlGhostSuggestion.url` verbatim.
   - Add `isLoopbackAddress` and `withDefaultScheme` to the existing `./url-completion.js` import.

3. `apps/desktop/renderer/components/peek-navbar.js` `_normalizeUrl`: keep the empty-input `null`
   return and the explicit `https?://` passthrough. Replace both remaining `'https://' + trimmed`
   returns (the dotted branch has the same result as the fallback, so it can go) with a single
   `withDefaultScheme(trimmed)`. Update the JSDoc, which currently says "adding https:// if needed".
   Add `withDefaultScheme` to the existing `../cmd/url-completion.js` import.

4. `apps/desktop/renderer/page/background.js` `getValidURL`: make the same two edits as the panel
   copy (`isLoopbackAddress` for recognition, `withDefaultScheme` for the prefix). Import both from
   `../cmd/url-completion.js`. The file is an ES module imported by the core background renderer,
   and the navbar already imports this module by a relative path. Merging the two `getValidURL`
   copies into one is out of scope.

## What stays

- Public hosts: `example.com`, `github.com/foo` and so on still get `https://`.
- `isDomainPattern` and its no-port limit for public hosts (`example.com:8080` is still not a URL
  in cmd). Only loopback recognition is widened.
- `urlMatchable`, `urlCompletionAtGranularity`, `inlineCompletionFor`, `URL_GRANULARITY_ORDER`:
  unchanged. Matchable forms still drop the scheme.
- Existing `https://localhost*` rows in the datastore: untouched. There is no migration, no
  deletion and no dedup change. That decision (item part 2, related to `480654b4`) is separate. The
  dev profile's seeded peek `1 = http://localhost` is not affected.
- Other `https://` prefixing that does not add a scheme to text typed into a navigation surface
  stays as it is: `renderer/lib/card-helpers.js` `extractUrl` / `_googleFaviconFallback`,
  `features/editor/links.js` (only `www.` links), and `features/widget-demo`.
- `_normalizeUrl` still sends non-http schemes it doesn't recognize down the default-scheme path.
  Its passthrough is only `https?://`. Widening that is a separate concern. `withDefaultScheme`
  itself does leave any `scheme://` input alone.
- The `keydown` listener's structure, `state-machine.js`, and the `ENTER` payload shape.

## Tests to add

`apps/desktop/tests/unit/url-completion.test.js`: add `describe('isLoopbackAddress')` and
`describe('withDefaultScheme')`, importing both beside the existing imports.

- `withDefaultScheme`: `localhost` → `http://localhost`; `localhost:3000` →
  `http://localhost:3000`; `localhost:3000/api?x=1` → `http://localhost:3000/api?x=1`;
  `127.0.0.1:8080` → `http://127.0.0.1:8080`; `[::1]:8080` → `http://[::1]:8080`;
  `foo.localhost` → `http://foo.localhost`; `LOCALHOST:3000` → `http://LOCALHOST:3000`;
  `example.com` → `https://example.com`; `localhost.example.com` → `https://localhost.example.com`
  (a `localhost` label that is not the last one is not loopback); `127.0.0.2` →
  `https://127.0.0.2`; `192.168.1.10:3000` → `https://192.168.1.10:3000`; `https://localhost`
  unchanged; `http://example.com` unchanged.
- `isLoopbackAddress`: true for `localhost`, `localhost:3000/x`, `a.b.localhost`, `127.0.0.1`,
  `[::1]`. False for `''`, `localhostx`, `mylocalhost.com`, `127.0.0.1.example.com`, `::1`
  (unbracketed), and `localhost 3000` (whitespace).

`apps/desktop/tests/components/peek-navbar-autocomplete.spec.ts`: inside the existing
`'peek-navbar URL autocomplete @components'` describe, add a test titled
`'Enter on a loopback address emits navigate with http'`. Clear `window.__navEvents`, then clear and
focus the input the way `typeUrl` does. `typeUrl` waits for suggestions, and the fixture `HISTORY`
has no localhost row, so do not use it for this input. Type `localhost:3000`, press Enter, and
assert that the last entry in `window.__navEvents` is `http://localhost:3000`. Do the same for
`127.0.0.1:8080` and `http://127.0.0.1:8080` in the same test. Before the fix it emits
`https://localhost:3000`.

`apps/desktop/tests/desktop/cmd-url-ghost.spec.ts`: add a standalone describe
`'cmd URL loopback default scheme @desktop'` with its own
`createPerDescribeApp('cmd-url-loopback')`, copying the `openPanel`/`closePanel` helpers from the
trailing-space describe. Seed nothing. Add one test titled
`'typing a loopback address and Enter opens http, not https'`. In `bgWindow`, subscribe to
`window:opened` and record `msg.url`. Then `fill('input', 'localhost:3000')`, press Enter, wait for
the recorded URL, and assert that it starts with `http://localhost:3000`. Next, query
`app.datastore.queryItems` (as other desktop specs do) and assert that at least one item URL starts
with `http://localhost:3000` and none starts with `https://localhost`. Close the opened window and
the panel in cleanup. Nothing listens on port 3000; the hybrid open path still builds the window and
publishes `window:opened` when the first load fails (see the comment in the existing
`'pressing Enter on ghost suggestion opens the host-level URL'` test). Before the fix, the recorded
URL is `https://localhost:3000`.

No existing assertion changes. `cmd-url-window-reuse.spec.ts` types `example.com` and is unaffected.

## Verify

The repo gate covers the unit tests:

```
yarn test:unit
```

It passes, including the new `isLoopbackAddress` / `withDefaultScheme` cases. The Playwright tests
are not in the gate. Run both of the following from the repo root and record
collected/passed/failed counts under `**Result**` in the handoff:

```
HEADLESS=1 BACKEND=electron ./scripts/playwright-with-display.sh test --config apps/desktop/playwright.config.ts --project=components --grep 'loopback'
yarn workspace @peek/desktop test:grep "loopback"
```

Each must collect exactly the one new test and report it passed. `yarn test:grep` only runs the
`desktop` project, so the components test needs the explicit `--project=components` invocation.
The pattern is `loopback`, not `localhost`, because `localhost` already matches unrelated desktop
specs. Also run `yarn workspace @peek/desktop test:grep "cmd URL"` to confirm the existing ghost,
lane and trailing-space describes still pass.

## Working rules

Run one command per Bash call.
