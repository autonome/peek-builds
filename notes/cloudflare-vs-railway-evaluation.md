# Cloudflare vs Railway: Server Architecture Evaluation

**Date:** 2026-02-02
**Status:** Research
**Author:** Architecture Review

---

## Executive Summary

This document evaluates two deployment strategies for the Peek sync server:

1. **Cloudflare Edge Stack**: Workers + Durable Objects + R2
2. **Railway (Current)**: Full Node.js container with persistent storage

**Recommendation:** Stay on Railway for now, but architect for future portability. The current server is simple enough that Cloudflare migration would add complexity without proportional benefit at current scale. However, if user growth demands global low-latency sync or Railway costs become prohibitive, Cloudflare offers a compelling edge-native model.

---

## Part 1: Cirrus Architecture Summary

### What Cirrus Does

[Cirrus](https://github.com/ascorbic/cirrus) is a single-user AT Protocol Personal Data Server (PDS) optimized for edge deployment. It demonstrates a clean architecture for running per-user SQLite databases on Cloudflare's edge infrastructure.

### Cirrus Architecture

| Component | Role |
|-----------|------|
| **Worker** | Stateless edge handler for routing, authentication, DID document serving |
| **Durable Object** | Single-instance SQLite storage for AT Protocol repository (per user) |
| **R2** | Object storage for blobs (images, videos) |

### Key Design Decisions

1. **Single-User per Durable Object**: Each user's entire AT Protocol repository lives in one Durable Object. This eliminates distributed consensus complexity - the DO is the authoritative state holder.

2. **Separation of Concerns**:
   - Structured data (posts, follows, profile) in SQLite within DO
   - Binary data (images, videos) in R2 object storage
   - Routing logic in stateless Worker

3. **Edge-Native Authentication**: OAuth 2.1 (PKCE, DPoP, PAR) and passkey support built into the edge layer.

4. **Pay-Per-Use**: Cloudflare's pricing model means costs scale with actual usage rather than reserved capacity.

### What We Can Learn

- **Per-user DO isolation is viable**: One DO per user with embedded SQLite works well for personal data sync.
- **R2 for blobs**: Keeping binary content out of SQLite simplifies sync and reduces DO storage costs.
- **Stateless routing layer**: Workers handle auth and routing without maintaining state, making horizontal scaling trivial.

---

## Part 2: Our Current Server Architecture

### Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 22+ |
| Framework | Hono (Express-like, but faster) |
| Database | SQLite via better-sqlite3 |
| Deployment | Railway (Nixpacks container) |
| Storage | Persistent volume at `DATA_DIR` |

### Data Model

```
data/
  system.db                  # User registry, profile metadata
  {userId}/
    profiles/
      {profileId}/
        datastore.sqlite     # Items, tags, item_tags, settings
        images/
          {hash}.{ext}       # Deduplicated image files
```

### Key Components

**`db.js`** - Data Layer (~1100 lines)
- Connection pool (one SQLite connection per user:profile)
- Schema migrations with column renames (snake_case to camelCase)
- Unified `saveItem()` with syncId-based deduplication
- Soft deletes with `deletedAt` timestamps
- Image storage with content-hash deduplication
- Incremental sync via `getItemsSince(timestamp)`

**`users.js`** - Multi-User Auth (~420 lines)
- SHA-256 hashed API keys in system.db
- Profile management (UUID-based folder naming)
- Legacy migration support

**`index.js`** - HTTP API (~770 lines)
- Hono routes for items, tags, images, profiles, backups
- Version compatibility middleware (HTTP 409 on mismatch)
- Auth middleware (Bearer token lookup)
- Automatic migrations and dedup on startup

### Current Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /items` | Create/update items (sync push) |
| `GET /items/since/:timestamp` | Incremental pull |
| `POST /images` | Upload images (multipart or base64) |
| `GET /images/:id` | Serve image binary |
| `GET /profiles` | List user profiles |
| `POST /backups` | Trigger backup |

### Strengths of Current Design

1. **Simple deployment**: Single container, one persistent volume
2. **Proven stack**: Node.js + SQLite is battle-tested
3. **Clean data isolation**: Each user/profile has isolated database
4. **Incremental sync**: `updatedAt`-based change detection works
5. **Hot reload**: `npm run dev` for local development

### Pain Points

1. **Single region**: Railway hosts in one region; latency for distant users
2. **Vertical scaling only**: One container handles all users
3. **Cold starts**: Container can be evicted, slow restart
4. **Image serving**: Binary files served through Node.js, not CDN

---

## Part 3: What Would Need to Change for Cloudflare

### Architecture Mapping

| Current (Railway) | Cloudflare Equivalent |
|-------------------|----------------------|
| Node.js container | Worker (JavaScript runtime) |
| SQLite file per user | Durable Object with SQLite API |
| Filesystem images | R2 bucket |
| Railway volume | Not needed (DO + R2 are persistent) |
| Single instance | Edge instances globally |

### Required Changes

#### 1. HTTP Framework Migration

```javascript
// Current: Hono with Node.js adapter
const { serve } = require("@hono/node-server");
serve({ fetch: app.fetch, port });

// Cloudflare: Hono runs natively in Workers
export default app;
```

Hono already supports Workers natively - this is a minimal change.

#### 2. Database Layer Rewrite

**Current** (better-sqlite3):
```javascript
const db = new Database(dbPath);
db.prepare("SELECT * FROM items WHERE id = ?").get(id);
```

**Cloudflare** (DO SQLite):
```javascript
export class UserStore extends DurableObject {
  async fetch(request) {
    const db = this.ctx.storage.sql;
    const result = db.exec("SELECT * FROM items WHERE id = ?", id);
    return Response.json(result.toArray());
  }
}
```

**Migration Complexity: HIGH**

- DO's SQLite API is slightly different (D1-style)
- Connection pool becomes DO instantiation
- Each request routes to the correct DO by user ID
- All db.js functions need rewriting

#### 3. Image Storage Migration

**Current**: Filesystem in `data/{userId}/profiles/{profileId}/images/`

**Cloudflare R2**:
```javascript
// Upload
await env.BUCKET.put(`${userId}/${hash}.${ext}`, imageBuffer, {
  httpMetadata: { contentType: mimeType }
});

// Serve
const object = await env.BUCKET.get(`${userId}/${hash}.${ext}`);
return new Response(object.body, {
  headers: { 'Content-Type': object.httpMetadata.contentType }
});
```

**Migration Complexity: MEDIUM**

- R2 API is straightforward
- Need to migrate existing images (one-time script)
- Can serve directly from R2 or through Worker

#### 4. User Registry

**Current**: `system.db` SQLite file shared across all users

**Cloudflare Options**:
1. **D1**: Cloudflare's managed SQLite (good for small tables)
2. **KV**: Key-value store (fast lookup by API key hash)
3. **Dedicated DO**: One DO for user registry

**Recommended**: D1 for user table, or KV for API key -> userId lookup.

#### 5. Routing Layer

Worker needs to:
1. Authenticate via API key (lookup in D1/KV)
2. Parse userId from auth
3. Get/create DO stub for that user
4. Forward request to DO

```javascript
export default {
  async fetch(request, env) {
    const apiKey = request.headers.get('Authorization')?.slice(7);
    const userId = await env.USERS.get(hashKey(apiKey));
    if (!userId) return new Response('Unauthorized', { status: 401 });

    const doId = env.USER_STORES.idFromName(userId);
    const stub = env.USER_STORES.get(doId);
    return stub.fetch(request);
  }
};
```

#### 6. Migrations and Schema

DO's SQLite doesn't have automatic migrations. Options:
- Check schema version on first request, run migrations
- Use DO's `alarm()` for background migration
- Store schema version in DO storage

---

## Part 4: Pros and Cons Comparison

### Railway (Current)

| Pros | Cons |
|------|------|
| Simple single-container model | Single region (latency for distant users) |
| Standard Node.js - familiar stack | Vertical scaling only |
| Filesystem access for images | Cold start after inactivity |
| Easy local development (`npm run dev`) | Images served through Node.js (not CDN) |
| Persistent volume (data survives redeploys) | $5/mo minimum even idle |
| Full npm ecosystem | Container size affects cold start |

**Cost Model**:
- $5/mo hobby tier (512MB RAM, shared CPU)
- $20/mo pro for more resources
- Persistent volumes included
- Predictable monthly cost

### Cloudflare (Durable Objects + R2)

| Pros | Cons |
|------|------|
| Global edge - low latency everywhere | More complex architecture |
| Per-user isolation via DO | DO's SQLite API differs from better-sqlite3 |
| R2 + CDN for images | Limited Node.js API compatibility |
| Auto-scales to zero (pay only for usage) | Debugging is harder (distributed) |
| No cold start for Workers | 30-second wall-clock limit per request |
| Built-in DDoS protection | Vendor lock-in (DO is Cloudflare-only) |

**Cost Model**:
- Workers: 10M free requests/mo, then $0.50/M
- Durable Objects: $0.15/GB-month storage, $0.50/M requests
- R2: $0.015/GB-month storage, free egress
- Could be cheaper at low scale, more expensive at high scale

### Head-to-Head

| Factor | Railway | Cloudflare |
|--------|---------|------------|
| **Latency** | Single region (US) | Global edge |
| **Complexity** | Low | Medium-High |
| **Migration Effort** | N/A (current) | 2-3 weeks solid work |
| **Vendor Lock-in** | Low (standard container) | High (Durable Objects) |
| **Cost at Low Scale** | $5-20/mo fixed | ~$0-5/mo (usage-based) |
| **Cost at High Scale** | Predictable | Can grow unexpectedly |
| **Local Dev** | Native Node.js | Wrangler + Miniflare |
| **Debugging** | Standard logs | Distributed tracing needed |
| **Image Serving** | Through app | R2 + CDN |

---

## Part 5: Recommendation

### Short-Term (Next 6 Months): Stay on Railway

**Rationale:**

1. **Current scale doesn't justify complexity**: With a handful of users, single-region latency is acceptable.

2. **Development velocity matters more**: Spending 2-3 weeks rewriting for Cloudflare delays features.

3. **Railway is working**: No reported issues with current deployment.

4. **Migration risk**: Cloudflare DO's SQLite API quirks could cause subtle bugs.

### Medium-Term: Architect for Portability

**Actions:**

1. **Abstract the storage layer**: Create a clean interface that could have Railway and Cloudflare implementations.

```javascript
// storage/interface.js
export interface StorageBackend {
  getItem(userId, profileId, itemId): Promise<Item>;
  saveItem(userId, profileId, item): Promise<string>;
  getItemsSince(userId, profileId, timestamp): Promise<Item[]>;
  // ... etc
}
```

2. **Move images to R2 now**: Even staying on Railway, images could be served from R2/CDN. This improves latency and reduces server load.

3. **Separate auth from data**: User registry could move to a shared service (D1, Turso, or even Cloudflare KV) while keeping data on Railway.

### Long-Term Triggers for Cloudflare Migration

Migrate when:
- User count exceeds ~1000 active users
- Latency complaints from non-US users become frequent
- Railway costs exceed $50/mo
- You want to eliminate cold starts for better UX

---

## Part 6: Migration Path (If/When Needed)

### Phase 1: Decouple Images (1 week)

1. Set up R2 bucket
2. Modify image upload to write to both filesystem and R2
3. Modify image serving to read from R2
4. Write migration script for existing images
5. Deploy, test, then remove filesystem path

### Phase 2: Abstract Storage (1 week)

1. Create `StorageBackend` interface
2. Implement `RailwayStorageBackend` wrapping current db.js
3. Refactor index.js to use interface
4. Test everything still works

### Phase 3: Build Cloudflare Backend (2 weeks)

1. Create `CloudflareStorageBackend` implementing same interface
2. Build Worker routing layer
3. Build Durable Object with SQLite schema
4. Set up local development with Wrangler/Miniflare
5. Test extensively with synthetic data

### Phase 4: Parallel Run (1 week)

1. Deploy Cloudflare version alongside Railway
2. Run both in parallel, comparing results
3. Use feature flag to route percentage of traffic
4. Monitor for discrepancies

### Phase 5: Cutover (1 day)

1. Put Railway in read-only mode
2. Migrate any remaining data
3. Update DNS/client config
4. Monitor closely for 24 hours
5. Decommission Railway

### Supporting Both Simultaneously

If you want to support Railway AND Cloudflare (e.g., self-hosted vs managed):

1. Keep both backends in the codebase
2. Use environment detection to pick backend
3. Maintain feature parity tests
4. Document deployment options

---

## Appendix: Reference Links

- [Cirrus GitHub](https://github.com/ascorbic/cirrus)
- [Cloudflare Durable Objects SQLite](https://developers.cloudflare.com/durable-objects/sqlite/)
- [Cloudflare R2 Documentation](https://developers.cloudflare.com/r2/)
- [Railway Persistent Volumes](https://docs.railway.app/reference/volumes)
- [Hono on Cloudflare Workers](https://hono.dev/docs/getting-started/cloudflare-workers)

---

## Appendix: Cost Modeling

### Scenario: 100 Active Users, 10 syncs/day each

**Railway:**
- $5/mo hobby tier (probably sufficient)
- Total: **$5/mo**

**Cloudflare:**
- Workers: 100 * 10 * 30 = 30,000 requests/mo (free tier)
- DO: 100 users * ~1MB each = 100MB storage ($0.015/mo) + 30,000 requests ($0.015)
- R2: 100 users * 50MB images = 5GB ($0.075/mo)
- Total: **~$0.10/mo**

### Scenario: 10,000 Active Users, 10 syncs/day each

**Railway:**
- $20/mo pro tier
- May need vertical scaling
- Total: **$20-50/mo**

**Cloudflare:**
- Workers: 3M requests/mo (free tier covers)
- DO: 10GB storage ($1.50) + 3M requests ($1.50)
- R2: 500GB images ($7.50/mo)
- Total: **~$10-15/mo**

**Conclusion**: Cloudflare is cheaper at scale, Railway is simpler at small scale.
