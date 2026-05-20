/**
 * Drift detection: invariants the rule engine assumes about feature
 * manifests. These are standing regressions per
 * `feedback_drift_detection_tests.md` — when a recurring class of bug
 * could re-emerge, encode the invariant as a test.
 *
 * Stage 1 invariant (peek MCP plan 3d7d9239):
 *   A feature MUST NOT declare both `resident: true` (on any tile
 *   entry) AND `rules: [...]` (top-level). The whole point of the
 *   rule engine is to let features participate in event pipelines
 *   without being permanently resident — the two declarations
 *   together would mean we're still booting that feature on every
 *   start, defeating the migration. Catch it at build time so an
 *   author who lifts old code into a new feature gets a loud failure
 *   instead of silently undoing the work.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import type { TileManifest } from './tile-manifest.js';

function repoRoot(): string {
  // Test runs from the dist/ build. process.cwd() is the repo root
  // when invoked via `yarn test:unit` from the project root.
  return process.cwd();
}

function listFeatureDirs(featuresDir: string): string[] {
  if (!fs.existsSync(featuresDir)) return [];
  return fs.readdirSync(featuresDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => path.join(featuresDir, d.name));
}

function readManifest(featureDir: string): (TileManifest & { rules?: unknown[] }) | null {
  const manifestPath = path.join(featureDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as TileManifest & { rules?: unknown[] };
  } catch {
    return null;
  }
}

describe('rules: drift detection', () => {
  it('no feature declares both resident:true and a non-empty rules:[]', () => {
    const featuresDir = path.join(repoRoot(), 'apps', 'desktop', 'features');
    const dirs = listFeatureDirs(featuresDir);
    if (dirs.length === 0) {
      // Test runner cwd is not the repo root — skip rather than false-pass.
      console.warn('[rules-drift] features/ not found from cwd, skipping');
      return;
    }

    const offenders: string[] = [];
    for (const dir of dirs) {
      const m = readManifest(dir);
      if (!m) continue;
      const hasRules = Array.isArray(m.rules) && m.rules.length > 0;
      if (!hasRules) continue;
      const tiles = Array.isArray(m.tiles) ? m.tiles : [];
      const hasResident = tiles.some(t => t && (t as { resident?: boolean }).resident === true);
      if (hasResident) {
        offenders.push(path.basename(dir));
      }
    }

    assert.deepStrictEqual(
      offenders, [],
      `These features declare both resident:true and rules:[...] — pick one. ` +
      `Manifest rules are designed for non-resident features that participate in ` +
      `event pipelines on demand. If a feature genuinely needs to stay live, drop ` +
      `the rules block; if it can go lazy, drop resident. Offenders: ${offenders.join(', ')}`,
    );
  });
});
