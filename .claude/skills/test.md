# /test — Run tests

When the user invokes /test:

1. Determine which test suite to run based on argument:

   | Argument | Command | Notes |
   |----------|---------|-------|
   | (none) or `unit` | `yarn test:unit` | 1196+ unit tests, run in background |
   | `electron` or `e2e` | `yarn test:electron:bg` | 212+ Playwright tests, headless background, logs to `/tmp/test-electron.log` |
   | `cmd` | `yarn test:cmd` | Cmd state machine + chaining + param mode tests |
   | `all` | `yarn test:unit` then `yarn test:electron:bg` | Run sequentially |

2. Run the test command via Bash with `run_in_background=true` for long-running suites.

3. When complete, report:
   - Total tests run
   - Pass/fail counts
   - Any failures with file path, test name, and error details

## CRITICAL rules

- **NEVER run `npx playwright test` directly** — it steals focus and blocks the user
- Always use `yarn test:electron:bg` for Playwright tests (logs to `/tmp/test-electron.log`)
- For electron test results, read `/tmp/test-electron.log` with the Read tool
- Use `yarn test:electron:x` if user wants stop-on-first-failure mode

## Usage

```
/test
/test unit
/test electron
/test cmd
/test all
```
