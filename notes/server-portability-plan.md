# Server Portability Plan

## Executive Summary

This plan covers three architectural changes to make the Peek server portable across different hosting environments:

1. **SQL Abstraction Layer** - Abstract `better-sqlite3` to support Cloudflare Durable Objects SQLite API
2. **Image Storage Abstraction** - Abstract filesystem storage to support R2/S3
3. **User Registry Decoupling** - Enable single-user mode for simplified self-hosting

---

## Current Architecture Analysis

### Database Layer (`backend/server/db.js`)

**SQLite-specific APIs currently used:**

| API | Usage |
|-----|-------|
| `new Database(path)` | Connection creation |
| `db.pragma("journal_mode = WAL")` | Write-ahead logging |
| `db.exec(sql)` | DDL and multi-statement execution |
| `db.prepare(sql).run(...)` | Parameterized writes |
| `db.prepare(sql).get(...)` | Single row reads |
| `db.prepare(sql).all(...)` | Multi-row reads |
| `db.transaction(fn)()` | Atomic table rebuilds |

**Connection pool pattern:**
```javascript
const connections = new Map();  // keyed by `${userId}:${profileId}`
```

**Path structure:**
```
DATA_DIR/{userId}/profiles/{profileId}/datastore.sqlite
```

### User Registry (`backend/server/users.js`)

- Separate `system.db` at `DATA_DIR/system.db`
- Tables: `users` (id, api_key_hash, created_at) and `profiles` (id, user_id, slug, name, ...)
- API key auth: SHA-256 hash lookup
- Profile resolution handles both UUIDs and legacy slugs

### Image Storage (`backend/server/db.js`)

- Filesystem path: `DATA_DIR/{userId}/profiles/{profileId}/images/`
- Content-hash deduplication: files named `{sha256}.{ext}`
- Metadata in `items` table (type='image', metadata JSON with hash/mime/size)
- Functions: `saveImage`, `getImagePath`, `getUserImagesDir`

---

## 1. SQL Abstraction Layer

### Proposed Interface

```typescript
// backend/server/sql/types.ts

interface RunResult {
  changes: number;
  lastInsertRowid?: number;
}

interface SqlAdapter {
  // Core query methods
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): RunResult;
  get<T = unknown>(sql: string, params?: unknown[]): T | null;
  all<T = unknown>(sql: string, params?: unknown[]): T[];

  // Transaction support
  transaction<T>(fn: () => T): T;

  // Lifecycle
  close(): void;
}

interface SqlAdapterFactory {
  open(path: string, options?: { readonly?: boolean }): SqlAdapter;
  init(adapter: SqlAdapter): void;  // Platform-specific setup (WAL mode)
}
```

### better-sqlite3 Adapter Implementation

```typescript
// backend/server/sql/better-sqlite3-adapter.ts

import Database from 'better-sqlite3';
import type { SqlAdapter, SqlAdapterFactory, RunResult } from './types';

class BetterSqlite3Adapter implements SqlAdapter {
  private db: Database.Database;
  private stmtCache = new Map<string, Database.Statement>();

  constructor(db: Database.Database) {
    this.db = db;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, params: unknown[] = []): RunResult {
    const stmt = this.getOrPrepare(sql);
    const result = stmt.run(...params);
    return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
  }

  get<T>(sql: string, params: unknown[] = []): T | null {
    return (this.getOrPrepare(sql).get(...params) as T) ?? null;
  }

  all<T>(sql: string, params: unknown[] = []): T[] {
    return this.getOrPrepare(sql).all(...params) as T[];
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }

  private getOrPrepare(sql: string): Database.Statement {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmtCache.set(sql, stmt);
    }
    return stmt;
  }
}

export const factory: SqlAdapterFactory = {
  open(path: string): SqlAdapter {
    return new BetterSqlite3Adapter(new Database(path));
  },
  init(adapter: SqlAdapter): void {
    adapter.exec("PRAGMA journal_mode = WAL");
  }
};
```

### Cloudflare DO SQLite Adapter

```typescript
// backend/server/sql/do-sqlite-adapter.ts

import type { SqlAdapter, RunResult } from './types';

class DoSqliteAdapter implements SqlAdapter {
  private sql: SqlStorage;

  constructor(storage: SqlStorage) {
    this.sql = storage;
  }

  exec(sql: string): void {
    this.sql.exec(sql);
  }

  run(sql: string, params: unknown[] = []): RunResult {
    const cursor = this.sql.exec(sql, ...params);
    return { changes: cursor.rowsWritten, lastInsertRowid: cursor.lastRowId };
  }

  get<T>(sql: string, params: unknown[] = []): T | null {
    const rows = this.sql.exec(sql, ...params).toArray();
    return rows.length > 0 ? (rows[0] as T) : null;
  }

  all<T>(sql: string, params: unknown[] = []): T[] {
    return this.sql.exec(sql, ...params).toArray() as T[];
  }

  transaction<T>(fn: () => T): T {
    return fn();  // DO transactions are implicit
  }

  close(): void {
    // No-op for DO
  }
}

export function createFromStorage(storage: SqlStorage): SqlAdapter {
  return new DoSqliteAdapter(storage);
}
```

### Migration Strategy for db.js

**Before (current):**
```javascript
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS items (...)`);
const row = db.prepare("SELECT id FROM items WHERE id = ?").get(id);
db.prepare("INSERT INTO items (...) VALUES (...)").run(v1, v2, v3);
```

**After (with adapter):**
```javascript
const adapter = factory.open(dbPath);
factory.init(adapter);
adapter.exec(`CREATE TABLE IF NOT EXISTS items (...)`);
const row = adapter.get("SELECT id FROM items WHERE id = ?", [id]);
adapter.run("INSERT INTO items (...) VALUES (?, ?, ?)", [v1, v2, v3]);
```

### Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `backend/server/sql/types.ts` | Create | Interface definitions |
| `backend/server/sql/better-sqlite3-adapter.ts` | Create | Current platform adapter |
| `backend/server/sql/do-sqlite-adapter.ts` | Create | Cloudflare adapter (future) |
| `backend/server/sql/index.ts` | Create | Factory selection based on config |
| `backend/server/db.js` | Modify | Replace 50+ direct better-sqlite3 calls |
| `backend/server/users.js` | Modify | Replace 15+ direct calls for system.db |
| `backend/server/backup.js` | Modify | Handle `VACUUM INTO` (not available on DO) |

---

## 2. Image Storage Abstraction

### Proposed Interface

```typescript
// backend/server/storage/types.ts

interface StorageAdapter {
  put(key: string, data: Buffer, metadata?: Record<string, string>): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  list(prefix?: string): Promise<string[]>;
}

interface StorageConfig {
  type: 'filesystem' | 'r2' | 's3';
  // Filesystem
  basePath?: string;
  // R2/S3
  bucket?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  endpoint?: string;
}
```

### Filesystem Adapter

```typescript
// backend/server/storage/filesystem-adapter.ts

import * as fs from 'fs';
import * as path from 'path';
import type { StorageAdapter } from './types';

export class FilesystemAdapter implements StorageAdapter {
  constructor(private basePath: string) {}

  async put(key: string, data: Buffer): Promise<void> {
    const fullPath = path.join(this.basePath, key);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(fullPath)) fs.writeFileSync(fullPath, data);  // Dedup
  }

  async get(key: string): Promise<Buffer | null> {
    const fullPath = path.join(this.basePath, key);
    return fs.existsSync(fullPath) ? fs.readFileSync(fullPath) : null;
  }

  async delete(key: string): Promise<void> {
    const fullPath = path.join(this.basePath, key);
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  }

  async exists(key: string): Promise<boolean> {
    return fs.existsSync(path.join(this.basePath, key));
  }

  async list(prefix?: string): Promise<string[]> {
    // Recursive directory walk
  }
}
```

### R2 Adapter (for Workers)

```typescript
// backend/server/storage/r2-adapter.ts

import type { StorageAdapter } from './types';

export class R2Adapter implements StorageAdapter {
  constructor(private bucket: R2Bucket) {}

  async put(key: string, data: Buffer, metadata?: Record<string, string>): Promise<void> {
    await this.bucket.put(key, data, { customMetadata: metadata });
  }

  async get(key: string): Promise<Buffer | null> {
    const obj = await this.bucket.get(key);
    return obj ? Buffer.from(await obj.arrayBuffer()) : null;
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.bucket.head(key)) !== null;
  }

  async list(prefix?: string): Promise<string[]> {
    const results: string[] = [];
    let cursor: string | undefined;
    do {
      const resp = await this.bucket.list({ prefix, cursor });
      results.push(...resp.objects.map(o => o.key));
      cursor = resp.truncated ? resp.cursor : undefined;
    } while (cursor);
    return results;
  }
}
```

### Key Format

Storage key format:
```
{userId}/{profileId}/images/{hash}.{ext}
```

### Files to Create/Modify

| File | Action |
|------|--------|
| `backend/server/storage/types.ts` | Create |
| `backend/server/storage/filesystem-adapter.ts` | Create |
| `backend/server/storage/r2-adapter.ts` | Create |
| `backend/server/storage/s3-adapter.ts` | Create (optional) |
| `backend/server/storage/index.ts` | Create (factory) |
| `backend/server/db.js` | Modify (saveImage, getImagePath) |
| `backend/server/index.js` | Modify (image serving) |

---

## 3. User Registry Decoupling

### Single-User Mode Design

```typescript
// backend/server/config.ts

interface ServerConfig {
  mode: 'multi-user' | 'single-user';
  singleUser?: {
    userId: string;      // default: "default"
    token?: string;      // optional bearer token
  };
}

export function loadConfig(): ServerConfig {
  if (process.env.SINGLE_USER_MODE === 'true') {
    return {
      mode: 'single-user',
      singleUser: {
        userId: process.env.SINGLE_USER_ID || 'default',
        token: process.env.SINGLE_USER_TOKEN
      }
    };
  }
  return { mode: 'multi-user' };
}
```

### Auth Middleware Factory

```typescript
// backend/server/auth.ts

export function createAuthMiddleware(config: ServerConfig) {
  if (config.mode === 'single-user') {
    return singleUserMiddleware(config.singleUser!);
  }
  return multiUserMiddleware();
}

function singleUserMiddleware({ userId, token }) {
  return async (c, next) => {
    if (c.req.path === '/') return next();

    if (token) {
      const auth = c.req.header('Authorization');
      if (!auth || auth !== `Bearer ${token}`) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
    }

    c.set('userId', userId);
    return next();
  };
}
```

### Path Simplification in Single-User Mode

**Multi-user (current):**
```
DATA_DIR/
├── system.db
├── {userId}/
│   └── profiles/
│       └── {profileId}/
│           ├── datastore.sqlite
│           └── images/
```

**Single-user:**
```
DATA_DIR/
├── profiles/
│   └── {profileId}/
│       ├── datastore.sqlite
│       └── images/
```

### Config Flag Behavior

| Config | system.db | User lookup | Path prefix |
|--------|-----------|-------------|-------------|
| `SINGLE_USER_MODE=false` | Required | API key hash | `{userId}/profiles/{profileId}` |
| `SINGLE_USER_MODE=true` | Not created | Skip | `profiles/{profileId}` |

### Files to Create/Modify

| File | Action |
|------|--------|
| `backend/server/config.ts` | Create |
| `backend/server/auth.ts` | Create |
| `backend/server/index.js` | Modify (use auth factory) |
| `backend/server/db.js` | Modify (getConnection path logic) |
| `backend/server/backup.js` | Modify (single-user backup path) |

---

## Implementation Order

### Phase 1: SQL Abstraction
1. Create `sql/` directory with types and adapters
2. Refactor `db.js` incrementally (keep tests passing)
3. Refactor `users.js`
4. Refactor `backup.js`
5. All existing tests must pass

### Phase 2: Storage Abstraction
1. Create `storage/` directory with adapters
2. Add `getImageKey()` helper to db.js
3. Refactor `saveImage()` to use storage adapter
4. Refactor image serving in `index.js`
5. Test with filesystem adapter (identical behavior)

### Phase 3: User Registry Decoupling
1. Create `config.ts` and `auth.ts`
2. Modify `index.js` to use auth middleware factory
3. Add path logic for single-user mode in `db.js`
4. Test single-user mode end-to-end
5. Update documentation

---

## Testing Approach

### Unit Tests (New)

```javascript
// sql/better-sqlite3-adapter.test.js
describe('BetterSqlite3Adapter', () => {
  it('exec() runs DDL', () => {});
  it('run() returns changes count', () => {});
  it('get() returns single row or null', () => {});
  it('all() returns array', () => {});
  it('transaction() is atomic', () => {});
});
```

### Integration Tests (Existing)

All 92 existing tests in `backend/server/test.js` must pass after each phase.

---

## Configuration Summary

```bash
# Current (multi-user, filesystem)
# No changes needed

# Single-user mode
SINGLE_USER_MODE=true
SINGLE_USER_TOKEN=secret-token  # Optional

# Future: R2 storage
STORAGE_BACKEND=r2
R2_BUCKET=peek-images

# Future: DO SQLite (Cloudflare Workers only)
SQL_ADAPTER=do-sqlite
```

---

## Resolved Questions

1. **Backup with DO SQLite**: `VACUUM INTO` not available. Export to R2 as JSON?
   - **Answer**: Yes, but just add a TODO for now - not deploying to Cloudflare yet.

2. **Image URLs**: Direct R2 URLs or proxy through worker?
   - **Answer**: Put hash in URL so we can easily switch between backends later.

3. **Profiles in single-user**: Keep for workspaces or remove entirely?
   - **Answer**: Single-user will always have profiles - only removing multi-user from the base.

4. **Migration path**: How to migrate existing multi-user data to single-user?
   - **Answer**: Only one real user currently. At deployment time, find the one active account and migrate by uplifting one dir into another.
