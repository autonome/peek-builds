/**
 * Unit tests for renderer/cmd/enum-match.js — tiered matching of typed text against option names.
 *
 * Run via: node --test tests/unit/enum-match.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { matchTier, TIER_EXACT, TIER_PREFIX, TIER_WORD, TIER_SUBSTRING, NO_MATCH } =
  await import(join(__dirname, '..', '..', 'renderer', 'cmd', 'enum-match.js'));

describe('matchTier', () => {
  it('ranks exact above prefix above word start above substring', () => {
    assert.equal(matchTier('proj', 'proj'), TIER_EXACT);
    assert.equal(matchTier('proj', 'projects'), TIER_PREFIX);
    assert.equal(matchTier('proj', 'Client Projects'), TIER_WORD);
    assert.equal(matchTier('roj', 'Client Projects'), TIER_SUBSTRING);
    assert.ok(TIER_EXACT < TIER_PREFIX && TIER_PREFIX < TIER_WORD && TIER_WORD < TIER_SUBSTRING);
  });

  it('returns NO_MATCH when the text is absent', () => {
    assert.equal(matchTier('zzz', 'Client Projects'), NO_MATCH);
  });

  it('is case-insensitive', () => {
    assert.equal(matchTier('PROJ', 'projects'), TIER_PREFIX);
    assert.equal(matchTier('proj', 'PROJECTS'), TIER_PREFIX);
  });

  it('treats space, hyphen, underscore and slash as word boundaries', () => {
    assert.equal(matchTier('pro', 'my projects'), TIER_WORD);
    assert.equal(matchTier('pro', 'my-projects'), TIER_WORD);
    assert.equal(matchTier('pro', 'my_projects'), TIER_WORD);
    assert.equal(matchTier('pro', 'my/projects'), TIER_WORD);
  });

  it('treats a camelCase hump as a word boundary', () => {
    assert.equal(matchTier('proj', 'clientProjects'), TIER_WORD);
    assert.equal(matchTier('proj', 'clientprojects'), TIER_SUBSTRING);
  });

  it('takes the best tier across several names', () => {
    assert.equal(matchTier('proj', 'work-items', 'Client Projects'), TIER_WORD);
    assert.equal(matchTier('proj', 'projects', 'Client Projects'), TIER_PREFIX);
  });

  it('ignores missing names', () => {
    assert.equal(matchTier('proj', undefined, 'Projects'), TIER_PREFIX);
    assert.equal(matchTier('proj', undefined, ''), NO_MATCH);
  });

  it('matches everything as exact for empty text', () => {
    assert.equal(matchTier('', 'anything'), TIER_EXACT);
  });
});
