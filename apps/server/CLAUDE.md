# Sync Server — Agent Guide

This is the Peek webhook/sync server: a Node.js/Hono app that receives URLs, texts, tagsets, and images from the mobile app and stores them in SQLite. It supports both multi-user (hosted) and single-user (self-hosted) deployments.

Code lives under `apps/server/`. Key files:
- `index.js` — main HTTP server (Hono)
- `db.js` — database layer
- `auth.js` / `users.js` — auth and user management
- `backup.js` — backup logic
- `sql/` — SQLite adapter abstraction
- `storage/` — blob/image storage abstraction
- `railway.json` — Railway deployment config

For cross-cutting rules (git workflow, subagent dispatch, Bash discipline), see the root `CLAUDE.md`.

---

## Testing

```bash
yarn server:test            # Unit tests (run from repo root)
yarn test:sync:e2e          # Sync E2E tests (13 tests)
```

Or from `apps/server/` directly:
```bash
npm test                    # Unit tests
npm run test:api:local      # Test against local server (requires PEEK_LOCAL_KEY env var)
npm run test:api:prod       # Test against production (requires PEEK_PROD_KEY + PEEK_PROD_URL)
```

### No native-module ABI concern here — the server runs on `node:sqlite`

The server's SQL layer (`sql/node-sqlite-adapter.js`) is backed by Node's
built-in `node:sqlite` (`DatabaseSync`), not the native `better-sqlite3`
module — so there is no compiled binary to match against whatever Node runs
the tests, and no dependency on the root `node_modules/better-sqlite3` build
(that native module still exists at the repo root for the desktop app under
Electron's ABI — see `apps/desktop/CLAUDE.md` — but the server never touches
it). A fresh checkout just needs `apps/server`'s plain JS dependencies
(`hono` / `archiver` / `@hono/node-server`, installed by `yarn install` at
the repo root, since apps/server is a yarn workspace) — no rebuild, no ABI matching, and running
`npm rebuild` at the repo root (still forbidden — see the desktop guide) has
no effect on the server either way.

---

## Deployment

Deploys are manual, against Railway directly. See `docs/server-backup-and-deploy.md` for the
procedure and its constraints.

**Important:** Railway uses Nixpacks with npm. **Do not add `yarn.lock` to `apps/server/`** — Nixpacks will detect it and switch to yarn, which breaks the build.

### Railway Setup
1. Attach a volume, set `DATA_DIR` to the mount path
2. Create users via admin commands (see `apps/server/README.md`)

---

## Operating the live server (logs / status / env)

The `railway` CLI is installed and authenticated (`me@burrito.space`). You **do**
have read/diagnostic access — don't tell the user you can't reach Railway. The
peek server is Railway project **`amusing-courtesy`**, service **`peek-node`**
(`peek-node.up.railway.app`, volume at `/app/data`). The repo root is linked to
it; pass `--service peek-node` anyway so it works regardless of link state.

Read-only — go ahead:

```bash
railway logs --service peek-node --lines 200     # runtime logs (recent, no stream)
railway logs --service peek-node --build         # last build logs
railway status --json                            # deploy state, domain, volume
railway variables --service peek-node            # env vars
```

State-changing — **confirm with the user first** (production mutation):

```bash
railway redeploy --service peek-node             # re-run last deploy
railway restart --service peek-node
railway variables --service peek-node --set KEY=value
```

**Deploy is a manual `railway up` upload**, not one of the read-only commands above — see
`docs/server-backup-and-deploy.md` for the invocation. It mutates production, so it needs
explicit user authorization like the other state-changing commands. "I can't deploy without
asking" is correct; "I can't read logs" is not.

---

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | SQLite + blob storage root |
| `API_KEY` | — | Legacy single-user key (auto-migrates) |

For test scripts, copy `apps/server/.env.example` to `.env` and fill in:
- `PEEK_LOCAL_KEY` — local dev API key
- `PEEK_PROD_KEY` / `PEEK_PROD_URL` — production testing

---

## Architecture Notes

The server uses abstraction layers so it can run on different SQLite backends (currently node:sqlite) and different storage backends (currently filesystem). See `apps/server/ARCHITECTURE.md` for the full interface contracts.

`SINGLE_USER_MODE=true yarn server:test` exercises the single-user deployment path.

---

## Key Pitfalls

- This server is a simple webhook receiver, **not** the portable.agency service. The portable-agency-ops skill is about a different project (Bluesky OAuth). Do not apply its Railway/OAuth patterns here unless specifically instructed.
- Never commit `yarn.lock` to `apps/server/` — it breaks Railway Nixpacks.
