# /test — Run tests

When the user invokes /test:

1. Determine which test suite to run based on argument. Commands follow the
   `test:{environment}:{implementation}` system.

   | Argument | Command | Notes |
   |----------|---------|-------|
   | (none) or `full` / `desktop` | `yarn test:desktop:electron:bg` | **Canonical full suite — all 6 runners, ~3300+ tests**, ~10 min, bg, logs to `/tmp/test-electron.log` |
   | `unit` | `yarn test:unit` | unit runners only (main-process + node, ~2600), background. A *subset* of the full suite |
   | `grep` / single | `yarn test:grep "<pattern>"` | one test, source-only, fast inner loop |
   | `tauri` | `yarn test:desktop:tauri` | off-critical-path Tauri desktop full suite (frontend + Rust) |

2. Run the test command via Bash with `run_in_background=true` for long-running suites.

3. When complete, report:
   - Per-runner counts (main-unit, node-unit, desktop, desktop-serial, components, editor) AND the grand total — never just the last project's tail
   - Pass/fail counts
   - Any failures with file path, test name, and error details

## CRITICAL rules

- **NEVER run `npx playwright test` directly** — it steals focus and blocks the user
- The full gate is **`yarn test:desktop:electron`** (or `:bg`). It runs the **packaged** build (`electron-builder --dir`) and **all six runners** — unit, components, and editor included. The Playwright `desktop`+`desktop-serial` pair alone (~549) is **~17% of the suite**, not the suite; never report it as "full".
- Always use `yarn test:desktop:electron:bg` for the full background run (logs to `/tmp/test-electron.log`); read that log with the Read tool.
- Use `yarn test:desktop:electron:x` if the user wants stop-on-first-failure mode.
- Source-only escape hatch (no packaging, runners 3+4 only): `yarn test:desktop:electron:source`. Single-test fast iteration: `yarn test:grep "<pattern>"` (source).
- There is **no bare `yarn test`** — always name environment + implementation.

## Usage

```
/test            # full desktop (electron) suite — all 6 runners
/test full       # same
/test unit       # unit runners only (subset)
/test grep "<pattern>"
/test tauri      # off-critical-path Tauri suite
```
