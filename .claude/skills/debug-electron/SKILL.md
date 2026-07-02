---
name: debug-electron
description: Drive scripts/debug-electron-page.mjs to debug chrome-extension pages and service workers under Electron — capture console output/errors from a BrowserWindow URL, evaluate JS from the CLI. Use when debugging extension pages or iterating on extension-API shims.
---

Programmatically debug Electron BrowserWindow content (extension pages, app pages, any URL) by capturing console output, errors, DOM state, and evaluating arbitrary JS -- all from stdout.

## Script Location

`scripts/debug-electron-page.mjs`

## Quick Start

```bash
npx electron scripts/debug-electron-page.mjs \
  --url "https://example.com" \
  --eval "document.title" \
  --timeout 5000
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--url <url>` | URL to load | Extension popup if `--extension` given |
| `--extension <path>` | Chrome extension directory to load | none |
| `--eval <js>` | JS to evaluate after page load (repeatable) | none |
| `--timeout <ms>` | Total time before exit | 5000 |
| `--session <partition>` | Electron session partition | default |
| `--wait-sw <ms>` | Wait time for service worker startup | 2000 |
| `--preload <path>` | Preload script path | none |
| `--show` | Make window visible | hidden |

The `--eval` flag can be used multiple times to evaluate several expressions.

The magic string `EXTENSION_ID` in `--url` is replaced with the loaded extension's actual ID.

## Common Scenarios

### Debug a Chrome extension's settings page

```bash
npx electron scripts/debug-electron-page.mjs \
  --extension resources/chrome-extensions/proton-pass \
  --url "chrome-extension://EXTENSION_ID/settings.html" \
  --eval "typeof chrome.runtime" \
  --eval "typeof chrome.storage.session" \
  --eval "document.querySelector('#root')?.innerHTML.length"
```

### Check if extension APIs are available

```bash
npx electron scripts/debug-electron-page.mjs \
  --extension resources/chrome-extensions/proton-pass \
  --url "chrome-extension://EXTENSION_ID/popup.html" \
  --eval "Object.keys(chrome).join(', ')" \
  --eval "typeof chrome.storage.local" \
  --eval "typeof chrome.alarms"
```

### Debug a web page with console capture

```bash
npx electron scripts/debug-electron-page.mjs \
  --url "https://example.com" \
  --eval "document.querySelectorAll('a').length" \
  --eval "performance.timing.loadEventEnd - performance.timing.navigationStart" \
  --timeout 8000
```

### Debug a local app page

```bash
npx electron scripts/debug-electron-page.mjs \
  --url "file:///path/to/app/page/index.html" \
  --eval "document.body.childElementCount"
```

### Inspect service worker status only

```bash
npx electron scripts/debug-electron-page.mjs \
  --extension resources/chrome-extensions/proton-pass \
  --url "chrome-extension://EXTENSION_ID/popup.html" \
  --wait-sw 5000 \
  --timeout 8000
```

## Output Tags Reference

| Tag | Meaning |
|-----|---------|
| `[CONSOLE:error]` | Console.error from the page |
| `[CONSOLE:warning]` | Console.warn from the page |
| `[CONSOLE:log]` | Console.log from the page |
| `[CONSOLE:debug]` | Console.debug from the page |
| `[PAGE:url]` | The final URL after load/redirects |
| `[PAGE:title]` | The page title |
| `[PAGE:loading]` | URL being loaded |
| `[PAGE:fail]` | Page failed to load (with error code) |
| `[PAGE:crash]` | Renderer process crashed |
| `[SW:running]` | Service worker is active |
| `[SW:stopped]` | No service workers found |
| `[SW:console]` | Console output from a service worker |
| `[SW:waiting]` | Waiting for SW startup |
| `[SW:final]` | Final SW status before exit |
| `[EXT:loaded]` | Extension loaded (with ID) |
| `[EXT:error]` | Extension failed to load |
| `[EVAL]` | Successful eval result |
| `[EVAL:error]` | Eval expression threw an error |
| `[DOM]` | DOM snapshot information |
| `[DOM:error]` | DOM inspection failed |
| `[ERROR]` | Fatal/uncaught error |
| `[EXIT]` | Script exit info |

## Iterative Debugging Workflow

The key pattern for agent-driven debugging:

1. **Run the script** to capture all console errors and page state
2. **Read the output** -- focus on `[CONSOLE:error]` and `[EVAL:error]` lines
3. **Identify the root cause** from error messages and stack traces
4. **Apply a fix** to the relevant source file
5. **Re-run the script** to verify the fix worked
6. **Repeat** until no errors remain

### Example iteration

```
# Step 1: See what's broken
npx electron scripts/debug-electron-page.mjs \
  --extension resources/chrome-extensions/proton-pass \
  --url "chrome-extension://EXTENSION_ID/settings.html" \
  --eval "document.querySelector('#root').innerHTML.length"

# Output shows:
# [CONSOLE:error] Cannot read properties of undefined (reading 'addListener') (background.js:1234)
# [EVAL] document.querySelector('#root').innerHTML.length = 0

# Step 2: Fix the missing API (e.g., add a shim)
# ... edit the file ...

# Step 3: Verify
npx electron scripts/debug-electron-page.mjs \
  --extension resources/chrome-extensions/proton-pass \
  --url "chrome-extension://EXTENSION_ID/settings.html" \
  --eval "document.querySelector('#root').innerHTML.length"

# Output shows:
# [EVAL] document.querySelector('#root').innerHTML.length = 4523
# No more CONSOLE:error lines -- fixed!
```

## Tips

- Use `--timeout 10000` or higher for slow-loading pages
- Use `--wait-sw 5000` if the extension's service worker takes time to initialize
- The `EXTENSION_ID` placeholder in `--url` is auto-replaced with the real extension ID
- Multiple `--eval` flags run in order; use them to build up context
- The script always exits cleanly (no hanging processes)
- All output includes timestamps for correlating events
- DOM snapshot runs automatically and reports body/root element stats
