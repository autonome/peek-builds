/**
 * Regression guard: the `open entities` command must be declared in the
 * entities feature manifest as a `window` action.
 *
 * Why this exists: the entities home tile is `lazy: true` with no boot
 * wake, so the `open entities` command it registers via the noun
 * (`features/entities/home.js` → registerNoun browse) is NOT registered
 * at startup. Before this guard, `open entities` only ever appeared in
 * the command bar because a PRIOR session had opened the tile and the
 * command got persisted into the cmd command-cache. Any cache
 * invalidation (a packaged build bumps a feature version → extension
 * drift clears the cache) dropped `open entities` entirely, and the
 * lazy tile never reloaded to repopulate it — the exact prod
 * regression this test defends against.
 *
 * The fix is to declare `open entities` as a manifest command, which is
 * announced at boot via lazy-tile arming (like `extract entities`
 * already is), independent of the tile ever loading or the cache
 * surviving. Singletoning is via `action.options.key` matching the
 * home tile's `key`.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

interface TileCommand {
  name?: string;
  action?: {
    type?: string;
    url?: string;
    options?: { key?: string };
  };
}

function repoRoot(): string {
  // The unit suite runs from the repo root via test:unit.
  return process.cwd();
}

describe('entities / open-command manifest declaration', () => {
  it('declares `open entities` as a boot-safe window action, not a lazy-noun-only command', () => {
    const manifestPath = path.join(
      repoRoot(), 'apps', 'desktop', 'features', 'entities', 'manifest.json',
    );
    if (!fs.existsSync(manifestPath)) {
      console.warn('[entities-open-command] entities manifest not found from cwd, skipping');
      return;
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
      commands?: TileCommand[];
      tiles?: Array<{ id?: string; key?: string }>;
    };
    const commands = manifest.commands ?? [];
    const openCmd = commands.find(c => c.name === 'open entities');

    assert.ok(
      openCmd,
      '`open entities` must be a manifest-declared command so it survives cmd-cache ' +
      'invalidation and appears at boot without loading the lazy entities home tile.',
    );
    assert.strictEqual(
      openCmd!.action?.type, 'window',
      '`open entities` must be a `window` action so the command bar can open it ' +
      'declaratively (bypassing tile boot).',
    );

    // Singleton reuse is driven ONLY by action.options.key (findWindowsByKey),
    // and must match the entities home tile's key so repeat invocations reuse
    // the same window instead of spawning duplicates.
    const homeTile = (manifest.tiles ?? []).find(t => t.id === 'home');
    assert.ok(homeTile?.key, 'entities home tile must declare a key for singleton reuse');
    assert.strictEqual(
      openCmd!.action?.options?.key, homeTile!.key,
      '`open entities` action.options.key must match the home tile key so the ' +
      'declarative open singletons onto the existing entities window.',
    );
  });
});
