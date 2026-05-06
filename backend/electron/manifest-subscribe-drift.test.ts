/**
 * Drift detection: every `pubsub.subscribe('topic', ...)` call site
 * inside a feature's JS files must have a matching entry (or covering
 * wildcard) in that feature's `manifest.json` `pubsub.topics`
 * allowlist.
 *
 * Why: the IPC gate silently drops `tile:pubsub:subscribe` frames
 * whose topic isn't in the grant's topic allowlist (which mirrors the
 * manifest). Without this test, a renderer can call
 * `api.pubsub.subscribe('rules:changed', cb)` and the subscription
 * disappears into the void — code looks live, no events ever fire.
 * The whole reactivity audit found this exact pattern repeatedly
 * (search, pagestream, lists, all missing `rules:changed` in their
 * manifests despite calling `subscribe('rules:changed', ...)`).
 *
 * Wildcard semantics: a manifest entry `foo:*` covers any subscribe
 * whose topic starts with `foo:`. Bare `*` covers everything.
 *
 * Scope: only feature renderers (`features/<id>/*.js`). The audit is
 * not applied to backend/electron/* (main process can subscribe
 * freely to any topic), to app/* shared libs (their subscribe calls
 * are inherited by whichever feature imports them — covered by that
 * feature's manifest), or to extensions/* (third-party).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

interface Manifest {
  id?: string;
  capabilities?: {
    pubsub?: { topics?: string[] };
  };
}

function repoRoot(): string {
  // The unit suite runs from the repo root via test:unit.
  return process.cwd();
}

function listFeatureDirs(featuresDir: string): string[] {
  if (!fs.existsSync(featuresDir)) return [];
  return fs.readdirSync(featuresDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => path.join(featuresDir, d.name));
}

function readManifest(featureDir: string): Manifest | null {
  const manifestPath = path.join(featureDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Manifest;
  } catch {
    return null;
  }
}

/** Recursively collect every `.js` / `.cjs` / `.mjs` under a dir. */
function jsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        stack.push(full);
      } else if (e.isFile() && /\.(js|cjs|mjs)$/.test(e.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Extract topic names that the source effectively subscribes to:
 *
 *  - direct `pubsub.subscribe('topic', ...)` / `api.subscribe('topic', ...)`
 *  - indirect `liveQuery({ topics: ['a', 'b'], ... })` (the helper subscribes
 *    via `api.pubsub.subscribe(topic, ...)` with a variable, so the direct
 *    regex misses these — we have to crack the array open ourselves).
 *
 * Quoted-literal only — dynamic topics can't be statically validated and
 * are skipped (the runtime gate handles those).
 */
function extractSubscribedTopics(source: string): string[] {
  const out: string[] = [];

  // 1. direct subscribe('topic', ...) — covers api.pubsub.subscribe,
  //    api.subscribe, and subscribeImpl call sites.
  const direct = /\bsubscribe\s*\(\s*(['"`])([^'"`\n]+?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = direct.exec(source)) !== null) {
    out.push(m[2]);
  }

  // 2. liveQuery({ topics: [...] }) — capture the array body, then pull
  //    every quoted literal out of it. Lazy `[\s\S]*?` keeps the match
  //    tight to the first closing bracket.
  const liveQueryRe = /\bliveQuery\s*\(\s*\{[\s\S]*?topics\s*:\s*\[([\s\S]*?)\]/g;
  while ((m = liveQueryRe.exec(source)) !== null) {
    const body = m[1];
    const stringRe = /(['"`])([^'"`\n]+?)\1/g;
    let s: RegExpExecArray | null;
    while ((s = stringRe.exec(body)) !== null) {
      out.push(s[2]);
    }
  }

  return out;
}

/** Manifest allowlist match — exact OR wildcard. `foo:*` covers
 *  everything starting with `foo:`. Bare `*` covers all. */
function manifestAllows(allowlist: string[], topic: string): boolean {
  for (const entry of allowlist) {
    if (entry === '*' || entry === topic) return true;
    if (entry.endsWith(':*')) {
      const prefix = entry.slice(0, -1); // keep the trailing colon
      if (topic.startsWith(prefix)) return true;
    }
  }
  return false;
}

/**
 * Topics that are known producer-only (other features publish them
 * for our renderers to receive — but we never subscribe). Keeping a
 * small ignore list avoids forcing manifests to declare topics they
 * only publish, since the audit is on subscribe sites.
 *
 * Currently empty — every observed gap is a real subscription that
 * needs allowlisting. Add here only after confirming the topic is
 * publish-only in the feature.
 */
const SUBSCRIBE_IGNORE: ReadonlySet<string> = new Set<string>();

describe('manifest / pubsub-subscribe drift detection', () => {
  it('every subscribed topic appears in the feature manifest pubsub.topics allowlist', () => {
    const featuresDir = path.join(repoRoot(), 'features');
    const dirs = listFeatureDirs(featuresDir);
    if (dirs.length === 0) {
      console.warn('[manifest-subscribe-drift] features/ not found from cwd, skipping');
      return;
    }

    const offenders: string[] = [];

    for (const dir of dirs) {
      const m = readManifest(dir);
      if (!m) continue;
      const allowlist = m.capabilities?.pubsub?.topics ?? [];
      const featureId = m.id ?? path.basename(dir);

      const files = jsFilesUnder(dir);
      for (const file of files) {
        const source = fs.readFileSync(file, 'utf-8');
        const subscribed = extractSubscribedTopics(source);
        for (const topic of subscribed) {
          if (SUBSCRIBE_IGNORE.has(topic)) continue;
          if (manifestAllows(allowlist, topic)) continue;
          offenders.push(
            `${featureId}: ${path.relative(repoRoot(), file)} subscribes to "${topic}" — not in manifest pubsub.topics`,
          );
        }
      }
    }

    assert.deepStrictEqual(
      offenders, [],
      `Some features subscribe to pubsub topics not declared in their manifest's ` +
      `\`capabilities.pubsub.topics\` allowlist. The IPC gate silently drops ` +
      `subscriptions whose topic isn't allowlisted, so these subscribers never ` +
      `fire. Either add the topic to the manifest or wrap with a manifest-level ` +
      `wildcard like \`foo:*\`.\n\nOffenders:\n  ${offenders.join('\n  ')}`,
    );
  });
});
