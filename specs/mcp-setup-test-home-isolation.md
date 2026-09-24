---
enabled: true
touches: [apps/desktop/features/mcp-server/setup.test.js]
depends-on: []
---

# Isolate HOME in every setup.test.js helper so no test can read or rewrite the real ~/.claude.json

Running `apps/desktop/features/mcp-server/setup.test.js` rewrites the developer's real user-scope
Peek MCP entry in `~/.claude.json` and breaks their Peek MCP connection. Three module-level helpers
spawn `setup.js` with the invoking shell's real HOME. The other describes in the file already
point HOME at a temp dir.

## What the code does now

`setup.test.js` module-level helpers:

- `runSetup(projDir, dbPath, extraArgs)` runs `setup.js --scope testscope --mcp-json` with
  `env: { ...process.env, PEEK_DB_PATH: dbPath }`.
- `scaffoldProject(extraArgs)` calls `makeTmpProject()`, then runs `setup.js --mcp-json ...extraArgs`
  with the same env.
- `runRefresh(projDir, dbPath)` runs bare `setup.js` (no `--scope`, i.e. refresh mode) with the
  same env.

None of the three sets `HOME`, so the child's `homedir()` is the developer's real home.

In `setup.js`, `main()` with no `--scope` calls `detectExistingInstall(process.cwd())`. That checks
`<cwd>/.mcp.json`, then `join(homedir(), '.claude.json')`, and returns the first `mcpServers.peek`
entry with a `PEEK_MCP_SCOPE_TAG`. When the entry came from `~/.claude.json` (`dest: 'global'`),
`main()` leaves `opts.mcpJson` false. It then sets `settingsPath = join(homedir(), '.claude.json')`
and writes the rebuilt snippet back there. For a remote install the rebuilt snippet carries
`${PEEK_SYNC_URL}` / `${PEEK_MCP_TOKEN}` references instead of whatever was there before.

The describe `'setup.js refresh mode'` test `'refresh: errors when no existing install'` runs
`runRefresh()` in a fresh `makeTmpProject()` dir with no `.mcp.json`. On a machine with a
user-scope Peek install:

- `detectExistingInstall()` finds the real `~/.claude.json` entry.
- `setup.js` rewrites the real entry and exits 0.
- The test fails its `threw` assertion, and the developer's MCP connection is now broken.

`scaffoldProject()` and `runSetup()` always pass `--mcp-json`, so today they only read HOME
indirectly. The later refresh runs in those projects stop at `<cwd>/.mcp.json`. They still inherit
the real HOME, and any change to `setup.js` that consults `homedir()` on the project path would
reach it.

Already isolated, for reference:

- `'setup.js default destination (user scope)'` → `runGlobal()` passes
  `{ ...process.env, HOME: homeDir, PEEK_DB_PATH: dbPath }` with a `mkdtempSync` home.
- The user-scope test in `'setup.js allow-list destination (settings.local.json)'` passes
  `HOME: home`.
- `'setup.js --remote'`: `makeRemoteProject()` / `runRemoteSetup()` and each direct `execFileSync`
  call in that describe pass `HOME: home`.

The last test in the `'setup.js --remote'` describe, `'local (non-remote) scaffold has no remote
paragraph — unaffected by this feature'`, goes through `scaffoldProject()` and inherits the gap.

## Change (setup.test.js only)

1. `makeTmpProject()` also creates an empty home dir inside the project,
   `join(projDir, 'home')` (`mkdirSync`), and returns it as `home` alongside `projDir` / `dbPath`.
   Because it sits inside `projDir`, every existing `tmpDirs.push(projDir)` already cleans it up.
   No call site needs a new push.
2. Add one module-level env builder next to the helpers:
   `isolatedEnv(home, overrides)` → `{ ...process.env, HOME: home, ...overrides }`.
3. `runSetup()`, `scaffoldProject()` and `runRefresh()` spawn with
   `env: isolatedEnv(join(projDir, 'home'), { PEEK_DB_PATH: dbPath })`. They derive HOME from
   `projDir`, so every existing caller keeps its signature and none can forget to pass it.
   Create the home dir if it is missing (`mkdirSync(..., { recursive: true })`) so the helpers
   also work on a `projDir` that did not come from `makeTmpProject()`.
4. Add a comment above the helpers stating the rule: every `setup.js` spawn in this file sets
   `HOME` to a temp dir, because refresh mode and the default destination read and write
   `join(homedir(), '.claude.json')`.

The fix lives only in the test file. `setup.js` and `detectExistingInstall()` are correct as
written: falling back to the user-scope file on refresh is the documented behaviour.

## What stays

- The already-isolated spawns listed above (`runGlobal()`, the allow-list user-scope test,
  `makeRemoteProject()` / `runRemoteSetup()` and the direct `execFileSync` calls in
  `'setup.js --remote'`). They may be routed through `isolatedEnv()` for consistency, but
  their HOME and `PEEK_DB_PATH` handling must not change. `runRemoteSetup()` keeps
  `delete opts.env.PEEK_DB_PATH`.
- Every existing assertion. With HOME isolated, `'refresh: errors when no existing install'`
  passes as written: the temp project has no `.mcp.json` and the temp home has no
  `.claude.json`, so `setup.js` exits 2.
- `server.test.js`, `store/remote-store.test.js` and `tests/unit/mcp-write-response-shape.test.js`
  are out of scope; they are already isolated. `server.test.js` `McpClient` and
  `spawnServerWithCwd()` spawn `server.js` with `HOME` set to a temp dir, and its in-process
  `withEnv()` cases pass a temp `HOME` wherever they read the credential file and never write to
  HOME. `remote-store.test.js` neither spawns anything nor touches `homedir()`.
  `main/mcp-config.test.ts` exercises only the pure `applyMcpConfigMigration()`. No other test
  spawns `setup.js`.

## Tests

Add a describe `'setup.test.js helpers — HOME isolation'` to `setup.test.js` with one test that
fails against the current helpers:

- Create a sentinel home with `mkdtempSync` (pushed to that describe's `tmpDirs`) containing
  `.claude.json`. Its content is a user-scope remote Peek install plus an unrelated key:
  `{ sentinel: true, mcpServers: { peek: { command: 'node', args: ['/sentinel/server.js'],
  env: { PEEK_MCP_SCOPE_TAG: 'sentinel', PEEK_MCP_REMOTE_URL: 'https://sentinel.example.invalid' } } } }`.
  Record the file's exact bytes.
- Save `process.env.HOME`, set it to the sentinel home, and in a `try` run:
  - `runSetup()` on a fresh `makeTmpProject()`
  - `scaffoldProject(['--scope', 'isolated', '--writes'])` followed by `runRefresh()` on that
    project
  - `runRefresh()` on a bare `makeTmpProject()`, asserting that it throws
- In `finally`, restore `process.env.HOME` (delete it if it was unset).
- Assert that the sentinel `.claude.json` bytes are identical to the recorded bytes, and that
  `readdirSync(sentinelHome)` is exactly `['.claude.json']` (no `.claude/`, no `.config/`).

Against the current helpers the bare refresh finds the sentinel entry, rewrites it into the
`${PEEK_SYNC_URL}` / `${PEEK_MCP_TOKEN}` form and exits 0. The test then fails on both the throw
and the byte comparison, the same failure as on a developer machine. After the change the helpers
ignore the inherited HOME and the sentinel stays untouched.

## Verify

`setup.test.js` is in no package.json script and outside the repo gate's glob
(`NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js`, also the node-unit runner of
`yarn test:unit` and `yarn test:desktop:electron`). Run it directly from the repo root. It
resolves `setup.js` from `import.meta.url`, so cwd does not matter.

Do not run the full unfixed file to reproduce the bug: it rewrites the real `~/.claude.json`.
To show the new test failing first, add it before changing the helpers and run only that test:

```
node --test --test-name-pattern 'HOME isolation' apps/desktop/features/mcp-server/setup.test.js
```

After the change:

```
node --test apps/desktop/features/mcp-server/setup.test.js
NODE_ENV=test node --test apps/desktop/tests/unit/*.test.js
```

Done when:

- The name-filtered run fails before the helper change and passes after it.
- The full `setup.test.js` run reports `fail 0` with one more test than before, including
  `'refresh: errors when no existing install'`.
- The `mcpServers.peek` entry in the real `~/.claude.json` is identical before and after the full
  run (compare `jq '.mcpServers.peek'` output; the file's mtime is not a signal, since Claude Code
  writes the file constantly). Record both under `**Result**` in the handoff.
- The gate passes unchanged.

## Working rules

`apps/desktop/CLAUDE.md` governs the desktop app. Read it before editing. Run one command per
Bash call.
