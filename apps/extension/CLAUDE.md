# Browser Extension — Agent Guide

The Peek browser extension is a Manifest V3 extension (Chrome/Firefox) that provides storage, sync, and profile management in the browser. It is not a build-step artifact — the source files in `apps/extension/` are loaded directly as extension source.

Key files:
- `manifest.json` — MV3 manifest (Chrome + Firefox/Gecko)
- `background.js` — service worker
- `popup.html` / `popup.js` — command bar popup (Alt+P)
- `options.html` / `options.js` — settings page
- `datastore.js`, `history.js`, `bookmarks.js`, `tabs.js` — core modules
- `sync -> ../../sync` — symlink to shared sync code
- `tests/` — Node.js unit tests + E2E sync test

For cross-cutting rules (jj workflow, subagent dispatch, Bash discipline), see the root `CLAUDE.md`.

---

## Testing

### Unit tests (Node.js `--test` runner, no browser needed)

```bash
yarn test:extension              # All unit tests
```

Tests use `fake-indexeddb` and `linkedom` to run without a real browser. Tests live in `apps/extension/tests/*.test.js`.

### Browser E2E tests (Playwright + extension fixture, Chrome only)

Extension Playwright tests live in `apps/desktop/tests/extension/` (not `apps/extension/tests/`). They use the `extension-chrome` project in `apps/desktop/playwright.config.ts` and a custom fixture that launches Chrome with the extension loaded.

```bash
yarn test:extension:browser          # Chrome E2E (automated, HEADLESS)
yarn test:extension:browser:visible  # Chrome E2E (headed, for debugging)
```

**Firefox Playwright extension testing is not supported.** Firefox limits how Playwright installs extensions. Use manual testing for Firefox:

```bash
yarn extension:firefox    # web-ext run, manual testing
```

### Sync E2E tests

```bash
yarn test:extension:e2e            # Sync E2E (needs local server running)
yarn test:extension:e2e:verbose    # With verbose output
```

---

## Running Locally

```bash
yarn extension:chrome    # Launch Chrome with extension loaded (scripts/launch-chrome.sh)
yarn extension:firefox   # Launch Firefox with extension (web-ext run)
```

---

## Packaging

```bash
yarn extension:package:firefox   # Build Firefox XPI (output: out/extension/)
```

The Firefox package excludes `tests/` and `scripts/` directories. Chrome packaging is done via the Chrome Web Store developer dashboard (manual upload).

---

## Manifest Notes

- `manifest_version: 3` (MV3). No MV2 fallback — the old MV2 extension is in `old-extension/` at repo root and is not maintained.
- Permissions: `storage`, `alarms`, `bookmarks`, `tabs`, `tabGroups`, `history`
- Firefox Gecko ID: `peek@burrito.space`, minimum version 109.0
- Background runs as a service worker (`background.js`)

---

## Key Pitfalls

- The extension shares the `sync/` module via a symlink (`apps/extension/sync -> ../../packages/sync`). Changes to `sync/` affect both the extension and other consumers. Run `yarn test:extension` after any sync change.
- Extension Playwright tests are in `apps/desktop/tests/extension/`, not `apps/extension/tests/`. The two test directories serve different purposes (browser E2E vs unit).
- `chrome.runtime.sendMessage` polyfill is committed but the Proton-auth bug fix is NOT. Check before relying on the polyfill for auth flows.
- Do not use `npx playwright` directly — always use the yarn scripts.
