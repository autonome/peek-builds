/**
 * Standing regression test for the `tile:features:list` enrichment —
 * the pure join of manifest-cache rows onto feature-registry entries,
 * plus the open-command rule that decides whether a feature card gets
 * an "Open" button.
 *
 * Same shape (and same reasoning) as chrome-extensions-ui-entries.test.ts:
 * the real handler needs a session, a token grant and a SQLite handle, so
 * the decision logic is extracted as a pure helper and asserted here.
 *
 * Key invariants:
 *   - A feature declaring a `type: 'window'` command with a url produces
 *     EXACTLY ONE open command — never zero (button missing), never two
 *     (duplicate buttons). If the openable count drops to 0, the Open
 *     button is gone from the Features Manager.
 *   - Enrichment is ADDITIVE — every registry field survives the join, so
 *     existing consumers (which read named fields) keep working.
 *   - FeatureRegistryEntry itself is never widened: manifest data must not
 *     round-trip into registry.json.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  pickOpenCommand,
  enrichFeatureEntries,
  normalizeCommandAction,
  collectLoadErrors,
  type FeatureCommandSummary,
  type ManifestCacheRowLike,
  type FeatureLoadOutcome,
} from './feature-list-entries.js';
import type { FeatureRegistryEntry } from './feature-registry.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

function entry(id: string, over: Partial<FeatureRegistryEntry> = {}): FeatureRegistryEntry {
  return {
    id,
    name: id,
    path: `/apps/desktop/features/${id}`,
    source: { type: 'builtin' },
    grantedCapabilities: {},
    userApproved: true,
    installedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function windowCmd(name: string, url: string, options?: Record<string, unknown>): FeatureCommandSummary {
  return { name, action: { type: 'window', url, options } };
}

function executeCmd(name: string): FeatureCommandSummary {
  return { name, action: { type: 'execute' } };
}

// ── pickOpenCommand ─────────────────────────────────────────────────────────

describe('pickOpenCommand — not openable', () => {
  it('returns null when commands is undefined', () => {
    assert.strictEqual(pickOpenCommand('tags', 'tags', undefined), null);
  });

  it('returns null when the feature declares no commands', () => {
    assert.strictEqual(pickOpenCommand('tags', 'tags', []), null);
  });

  it('returns null for a feature whose commands are all type:execute (the `windows` shape)', () => {
    // Real fixture: every `windows` manifest command is type:'execute'.
    // It must NOT get an Open button.
    const commands = [
      executeCmd('windows'),
      executeCmd('center window'),
      executeCmd('fullscreen'),
    ];
    assert.strictEqual(pickOpenCommand('windows', 'windows', commands), null);
  });

  it('returns null for a type:window command with no url — nothing to open', () => {
    const commands: FeatureCommandSummary[] = [{ name: 'open x', action: { type: 'window' } }];
    assert.strictEqual(pickOpenCommand('x', 'x', commands), null);
  });

  it('returns null for type:publish commands', () => {
    const commands: FeatureCommandSummary[] = [
      { name: 'ping', action: { type: 'publish', topic: 'a:b' } },
    ];
    assert.strictEqual(pickOpenCommand('p', 'p', commands), null);
  });
});

describe('pickOpenCommand — rule 1: command named exactly for the feature', () => {
  it('picks the command whose name equals the feature id (the `dropzone` shape)', () => {
    const commands = [
      executeCmd('clear dropzone'),
      windowCmd('dropzone', 'peek://dropzone/dropzone.html', { key: 'dropzone' }),
      windowCmd('dropzone history', 'peek://dropzone/history.html'),
    ];
    const open = pickOpenCommand('dropzone', 'dropzone', commands);
    assert.ok(open);
    assert.strictEqual(open.name, 'dropzone');
    assert.strictEqual(open.url, 'peek://dropzone/dropzone.html');
    assert.deepStrictEqual(open.options, { key: 'dropzone' });
  });

  it('matches on manifest shortname when it differs from the id', () => {
    const commands = [
      windowCmd('other', 'peek://x/other.html'),
      windowCmd('zone', 'peek://x/zone.html'),
    ];
    const open = pickOpenCommand('some-long-id', 'zone', commands);
    assert.ok(open);
    assert.strictEqual(open.name, 'zone');
  });

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    const commands = [windowCmd('  DropZone  ', 'peek://dropzone/dropzone.html')];
    const open = pickOpenCommand('dropzone', 'dropzone', commands);
    assert.ok(open);
    assert.strictEqual(open.url, 'peek://dropzone/dropzone.html');
  });

  it('exact-name match beats an `open <id>` command declared earlier', () => {
    const commands = [
      windowCmd('open tags', 'peek://tags/browser.html'),
      windowCmd('tags', 'peek://tags/home.html'),
    ];
    const open = pickOpenCommand('tags', 'tags', commands);
    assert.ok(open);
    assert.strictEqual(open.name, 'tags', 'rule 1 must take precedence over rule 2');
  });
});

describe('pickOpenCommand — rule 2: `open <id>` convention', () => {
  // The dominant convention across builtins: open tags, open feeds,
  // open spaces, open groups, open scripts, open entities.
  for (const id of ['tags', 'feeds', 'spaces', 'groups', 'scripts', 'entities']) {
    it(`picks "open ${id}" for the ${id} feature`, () => {
      const commands = [
        executeCmd(`refresh ${id}`),
        windowCmd(`open ${id}`, `peek://${id}/home.html`, { key: `${id}-home`, width: 900 }),
      ];
      const open = pickOpenCommand(id, id, commands);
      assert.ok(open, `${id} must be openable`);
      assert.strictEqual(open.name, `open ${id}`);
      assert.strictEqual(open.url, `peek://${id}/home.html`);
      assert.deepStrictEqual(open.options, { key: `${id}-home`, width: 900 });
    });
  }

  it('prefers `open <id>` over an unrelated window command declared first', () => {
    const commands = [
      windowCmd('tag settings', 'peek://tags/settings.html'),
      windowCmd('open tags', 'peek://tags/home.html'),
    ];
    const open = pickOpenCommand('tags', 'tags', commands);
    assert.ok(open);
    assert.strictEqual(open.name, 'open tags');
  });
});

describe('pickOpenCommand — rule 3: first window command in manifest order', () => {
  it('picks the first window command for features-manager (declares 4 of them)', () => {
    // Real fixture: features-manager declares features / manage features /
    // browse features / publish feature — none matches its id, so manifest
    // order decides, and it lists its primary entry point first.
    const commands = [
      windowCmd('features', 'peek://features-manager/manage.html', { key: 'features-manage' }),
      windowCmd('manage features', 'peek://features-manager/manage.html'),
      windowCmd('browse features', 'peek://features-manager/browse.html'),
      windowCmd('publish feature', 'peek://features-manager/publish.html'),
      executeCmd('list features'),
    ];
    const open = pickOpenCommand('features-manager', 'features-manager', commands);
    assert.ok(open);
    assert.strictEqual(open.name, 'features');
    assert.strictEqual(open.url, 'peek://features-manager/manage.html');
  });

  it('picks "accounts" for wonderwall (no id-derived name matches)', () => {
    const commands = [windowCmd('accounts', 'peek://wonderwall/accounts.html')];
    const open = pickOpenCommand('wonderwall', 'wonderwall', commands);
    assert.ok(open);
    assert.strictEqual(open.name, 'accounts');
  });

  it('skips non-window commands when falling back to first', () => {
    const commands = [
      executeCmd('do a thing'),
      executeCmd('do another thing'),
      windowCmd('some window', 'peek://x/w.html'),
    ];
    const open = pickOpenCommand('x', undefined, commands);
    assert.ok(open);
    assert.strictEqual(open.name, 'some window');
  });

  it('tolerates a missing shortname', () => {
    const commands = [windowCmd('open x', 'peek://x/home.html')];
    const open = pickOpenCommand('x', undefined, commands);
    assert.ok(open);
    assert.strictEqual(open.name, 'open x');
  });
});

describe('pickOpenCommand — exactly one button per feature', () => {
  it('returns a single command even when four window commands are declared', () => {
    const commands = [
      windowCmd('features', 'peek://features-manager/manage.html'),
      windowCmd('manage features', 'peek://features-manager/manage.html'),
      windowCmd('browse features', 'peek://features-manager/browse.html'),
      windowCmd('publish feature', 'peek://features-manager/publish.html'),
    ];
    const open = pickOpenCommand('features-manager', 'features-manager', commands);
    assert.ok(
      open,
      'REGRESSION: no open command resolved — the Open button will not render on the feature card',
    );
    // A single object, not a list — the card renders one button by construction.
    assert.strictEqual(typeof open.name, 'string');
    assert.ok(open.url.length > 0, 'open command must carry a non-empty url for api.window.open');
  });
});

// ── normalizeCommandAction ──────────────────────────────────────────────────

describe('normalizeCommandAction — narrows the cache\'s unknown action', () => {
  it('returns undefined for null / non-objects', () => {
    assert.strictEqual(normalizeCommandAction(null), undefined);
    assert.strictEqual(normalizeCommandAction(undefined), undefined);
    assert.strictEqual(normalizeCommandAction('window'), undefined);
    assert.strictEqual(normalizeCommandAction(42), undefined);
  });

  it('carries type / url / options through', () => {
    const a = normalizeCommandAction({
      type: 'window',
      url: 'peek://tags/home.html',
      options: { key: 'tags-home', width: 900 },
    });
    assert.deepStrictEqual(a, {
      type: 'window',
      url: 'peek://tags/home.html',
      topic: undefined,
      options: { key: 'tags-home', width: 900 },
    });
  });

  it('drops non-string type/url rather than trusting them', () => {
    const a = normalizeCommandAction({ type: 3, url: { evil: true } });
    assert.strictEqual(a?.type, undefined);
    assert.strictEqual(a?.url, undefined);
  });
});

// ── enrichFeatureEntries ────────────────────────────────────────────────────

describe('enrichFeatureEntries — the join', () => {
  const TAGS_ROW: ManifestCacheRowLike = {
    featureId: 'tags',
    manifest: { description: 'Tag things', shortname: 'tags' },
    commands: [
      { name: 'tag', action: { type: 'execute' } },
      {
        name: 'open tags',
        description: 'Open the tags browser',
        action: {
          type: 'window',
          url: 'peek://tags/home.html',
          options: { key: 'tags-home', width: 900, height: 700, title: 'Tags' },
        },
      },
    ],
  };

  it('attaches description, commands and openCommand from the cache row', () => {
    const [out] = enrichFeatureEntries([entry('tags')], [TAGS_ROW]);
    assert.strictEqual(out.description, 'Tag things');
    assert.strictEqual(out.commands?.length, 2);
    assert.ok(out.openCommand, 'tags declares a window command and must be openable');
    assert.strictEqual(out.openCommand.name, 'open tags');
    assert.strictEqual(out.openCommand.url, 'peek://tags/home.html');
    assert.deepStrictEqual(out.openCommand.options, {
      key: 'tags-home', width: 900, height: 700, title: 'Tags',
    });
  });

  it('exposes each command\'s name AND action (the contract the card renders from)', () => {
    const [out] = enrichFeatureEntries([entry('tags')], [TAGS_ROW]);
    const open = out.commands?.find(c => c.name === 'open tags');
    assert.ok(open);
    assert.strictEqual(open.action?.type, 'window');
    assert.strictEqual(open.action.url, 'peek://tags/home.html');
    assert.strictEqual(open.description, 'Open the tags browser');
  });

  it('is additive — every registry field survives the join untouched', () => {
    const src = entry('tags', {
      source: { type: 'atproto', publisher: 'did:plc:abc', publisherName: 'alice.test', version: '2.1.0' },
      disabled: true,
      updatePolicy: 'pinned',
      pinnedVersion: '2.0.0',
      availableVersion: '3.0.0',
      manifestCid: 'bafy123',
    });
    const [out] = enrichFeatureEntries([src], [TAGS_ROW]);
    for (const key of Object.keys(src) as Array<keyof FeatureRegistryEntry>) {
      assert.deepStrictEqual(out[key], src[key], `registry field "${key}" must survive enrichment`);
    }
    // …and the renderer's restored affordances read these live fields.
    assert.strictEqual(out.source.publisherName, 'alice.test');
    assert.strictEqual(out.path, '/apps/desktop/features/tags');
  });

  it('does not mutate the input registry entry (no manifest data leaks toward registry.json)', () => {
    const src = entry('tags');
    enrichFeatureEntries([src], [TAGS_ROW]);
    const raw = src as unknown as Record<string, unknown>;
    assert.strictEqual(raw.description, undefined);
    assert.strictEqual(raw.commands, undefined);
    assert.strictEqual(raw.openCommand, undefined);
  });

  it('carries the declared settingsSchema PATH — the Options toggle gate, no disk read', () => {
    const [out] = enrichFeatureEntries(
      [entry('peeks')],
      [{
        featureId: 'peeks',
        manifest: { description: 'Peeks', shortname: 'peeks', settingsSchema: './settings-schema.json' },
        commands: [],
      }],
    );
    assert.strictEqual(out.settingsSchema, './settings-schema.json');
  });

  it('leaves settingsSchema undefined for features that declare none', () => {
    const [out] = enrichFeatureEntries([entry('tags')], [TAGS_ROW]);
    assert.strictEqual(
      out.settingsSchema,
      undefined,
      'a feature with no declared schema must not render an Options toggle',
    );
  });

  it('passes entries through unenriched when no cache row exists', () => {
    const src = entry('broken-manifest');
    const [out] = enrichFeatureEntries([src], []);
    assert.strictEqual(out.id, 'broken-manifest');
    assert.strictEqual(out.description, undefined);
    assert.strictEqual(out.openCommand, undefined);
    assert.strictEqual(out.path, src.path, 'a feature with an unparseable manifest must still list');
  });

  it('attaches loadError when present (normal, with-cache-row path)', () => {
    const loadErrors = new Map([['tags', 'Manifest not available for tags (cache miss + disk parse failed)']]);
    const [out] = enrichFeatureEntries([entry('tags')], [TAGS_ROW], loadErrors);
    assert.strictEqual(out.loadError, 'Manifest not available for tags (cache miss + disk parse failed)');
    // ...and the rest of the enrichment still happens.
    assert.strictEqual(out.description, 'Tag things');
  });

  it('attaches loadError even with NO cache row — the manifest-parse-failure case', () => {
    // REGRESSION: the early `if (!row) return { ...entry };` path must
    // also carry the load error, or the most common failure (an
    // unparseable manifest, which is also why there's no cache row)
    // never surfaces on the card.
    const loadErrors = new Map([['broken-manifest', 'Feature broken-manifest has a legacy manifest (manifestVersion < 3); reinstall or update the manifest.']]);
    const [out] = enrichFeatureEntries([entry('broken-manifest')], [], loadErrors);
    assert.strictEqual(
      out.loadError,
      'Feature broken-manifest has a legacy manifest (manifestVersion < 3); reinstall or update the manifest.',
    );
    assert.strictEqual(out.path, entry('broken-manifest').path, 'still lists with its registry metadata');
  });

  it('leaves loadError undefined when no error is joined in', () => {
    const [out] = enrichFeatureEntries([entry('tags')], [TAGS_ROW]);
    assert.strictEqual(out.loadError, undefined);
  });

  it('leaves loadError undefined when the map has no entry for this feature id', () => {
    const loadErrors = new Map([['some-other-feature', 'boom']]);
    const [out] = enrichFeatureEntries([entry('tags')], [TAGS_ROW], loadErrors);
    assert.strictEqual(out.loadError, undefined);
  });

  it('ignores cache rows that have no registry entry — the registry decides what exists', () => {
    const out = enrichFeatureEntries([entry('tags')], [TAGS_ROW, { featureId: 'ghost', commands: [] }]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].id, 'tags');
  });

  it('tolerates a null manifest / absent commands on the row', () => {
    const [out] = enrichFeatureEntries([entry('weird')], [{ featureId: 'weird', manifest: null }]);
    assert.strictEqual(out.description, undefined);
    assert.deepStrictEqual(out.commands, []);
    assert.strictEqual(out.openCommand, undefined);
  });

  it('joins by featureId, not by array position', () => {
    const out = enrichFeatureEntries(
      [entry('a'), entry('tags'), entry('b')],
      [TAGS_ROW],
    );
    assert.strictEqual(out[0].description, undefined);
    assert.strictEqual(out[1].description, 'Tag things');
    assert.strictEqual(out[2].description, undefined);
  });

  it('returns [] for an empty registry', () => {
    assert.deepStrictEqual(enrichFeatureEntries([], [TAGS_ROW]), []);
  });

  it('attaches liveEntries for a feature with a cache row', () => {
    const live = new Map([['tags', ['background', 'home']]]);
    const [out] = enrichFeatureEntries([entry('tags')], [TAGS_ROW], undefined, live);
    assert.deepStrictEqual(out.liveEntries, ['background', 'home']);
    // ...and the rest of the enrichment still happens.
    assert.strictEqual(out.description, 'Tag things');
  });

  it('attaches liveEntries even with NO cache row', () => {
    const live = new Map([['broken-manifest', ['background']]]);
    const [out] = enrichFeatureEntries([entry('broken-manifest')], [], undefined, live);
    assert.deepStrictEqual(out.liveEntries, ['background']);
  });

  it('attaches an empty liveEntries for a feature reported as running nothing', () => {
    const live = new Map([['tags', []]]);
    const [out] = enrichFeatureEntries([entry('tags')], [TAGS_ROW], undefined, live);
    assert.deepStrictEqual(out.liveEntries, []);
  });

  it('leaves liveEntries absent when the argument is omitted', () => {
    const [withRow] = enrichFeatureEntries([entry('tags')], [TAGS_ROW]);
    const [withoutRow] = enrichFeatureEntries([entry('broken-manifest')], []);
    assert.strictEqual(withRow.liveEntries, undefined);
    assert.strictEqual(withoutRow.liveEntries, undefined);
  });

  it('leaves liveEntries undefined when the map has no entry for this feature id', () => {
    const live = new Map([['some-other-feature', ['background']]]);
    const [out] = enrichFeatureEntries([entry('tags')], [TAGS_ROW], undefined, live);
    assert.strictEqual(out.liveEntries, undefined);
  });
});

describe('enrichFeatureEntries — openable count across a realistic builtin set', () => {
  const rows: ManifestCacheRowLike[] = [
    {
      featureId: 'tags',
      manifest: { description: 'Tags', shortname: 'tags' },
      commands: [{ name: 'open tags', action: { type: 'window', url: 'peek://tags/home.html' } }],
    },
    {
      featureId: 'feeds',
      manifest: { description: 'Feeds', shortname: 'feeds' },
      commands: [{ name: 'open feeds', action: { type: 'window', url: 'peek://feeds/feeds.html' } }],
    },
    {
      // All-execute feature — no window, no Open button.
      featureId: 'windows',
      manifest: { description: 'Window switcher', shortname: 'windows' },
      commands: [
        { name: 'windows', action: { type: 'execute' } },
        { name: 'fullscreen', action: { type: 'execute' } },
      ],
    },
    {
      featureId: 'features-manager',
      manifest: { description: 'Manage features', shortname: 'features-manager' },
      commands: [
        { name: 'features', action: { type: 'window', url: 'peek://features-manager/manage.html' } },
        { name: 'browse features', action: { type: 'window', url: 'peek://features-manager/browse.html' } },
        { name: 'list features', action: { type: 'execute' } },
      ],
    },
  ];
  const entries = ['tags', 'feeds', 'windows', 'features-manager'].map(id => entry(id));
  const out = enrichFeatureEntries(entries, rows);

  it('produces exactly 3 openable features out of 4', () => {
    const openable = out.filter(e => !!e.openCommand);
    assert.strictEqual(
      openable.length,
      3,
      'REGRESSION: the Features Manager renders one Open button per feature with an openCommand. ' +
      'If this drops, Open buttons are missing; if it rises to 4, `windows` (all type:execute) ' +
      'wrongly got one.',
    );
    assert.deepStrictEqual(
      openable.map(e => e.id).sort(),
      ['features-manager', 'feeds', 'tags'],
    );
  });

  it('`windows` is enriched with a description but stays non-openable', () => {
    const w = out.find(e => e.id === 'windows');
    assert.ok(w);
    assert.strictEqual(w.description, 'Window switcher');
    assert.strictEqual(w.commands?.length, 2);
    assert.strictEqual(w.openCommand, undefined);
  });
});

// ── collectLoadErrors ───────────────────────────────────────────────────────

describe('collectLoadErrors — per-session tile-loader failures, not persisted', () => {
  function outcome(id: string, over: Partial<FeatureLoadOutcome> = {}): FeatureLoadOutcome {
    return { id, loaded: false, ...over };
  }

  it('excludes a skipped disabled feature — the card already shows a Disabled badge', () => {
    const errors = collectLoadErrors([
      outcome('tags', { skipped: true, error: 'Feature is disabled' }),
    ]);
    assert.strictEqual(errors.has('tags'), false);
  });

  it('excludes a skipped not-yet-approved feature — pending, not a fault', () => {
    const errors = collectLoadErrors([
      outcome('tags', { skipped: true, error: 'Feature not yet approved by user' }),
    ]);
    assert.strictEqual(errors.has('tags'), false);
  });

  it('includes a real failure (e.g. manifest-parse error)', () => {
    const errors = collectLoadErrors([
      outcome('broken', { error: 'Manifest not available for broken (cache miss + disk parse failed)' }),
    ]);
    assert.strictEqual(errors.get('broken'), 'Manifest not available for broken (cache miss + disk parse failed)');
  });

  it('excludes loaded features, even if error happens to be set', () => {
    const errors = collectLoadErrors([outcome('tags', { loaded: true, error: 'Feature is disabled' })]);
    assert.strictEqual(errors.has('tags'), false);
  });

  it('excludes results with no error message', () => {
    const errors = collectLoadErrors([outcome('tags')]);
    assert.strictEqual(errors.has('tags'), false);
  });

  it('last one wins when two results share an id', () => {
    const errors = collectLoadErrors([
      outcome('tags', { error: 'first failure' }),
      outcome('tags', { error: 'second failure' }),
    ]);
    assert.strictEqual(errors.get('tags'), 'second failure');
  });

  it('returns an empty map for an all-clean load', () => {
    const errors = collectLoadErrors([
      outcome('tags', { loaded: true }),
      outcome('feeds', { loaded: true }),
    ]);
    assert.strictEqual(errors.size, 0);
  });
});
