/**
 * Unit tests for renderer/cmd/usage-rank.js — ranking a command's parameter suggestions by how
 * often and recently each option was picked.
 *
 * Run via: node --test tests/unit/cmd-usage-rank.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', 'renderer', 'cmd', 'usage-rank.js');
const { PICK_SCORE, HALF_LIFE_MS, scoreAt, anchorAfterPick, recordPick, rankByUsage } =
  await import(modulePath);

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} !~ ${b}`);
const sug = (...values) => values.map(value => ({ title: value, subtitle: '', value }));
const values = list => list.map(s => s.value);

describe('score math', () => {
  it('a pick is worth 100 and the half-life is 10 days', () => {
    assert.equal(PICK_SCORE, 100);
    assert.equal(HALF_LIFE_MS, 10 * DAY);
  });

  it('a first pick scores 100 right now', () => {
    near(scoreAt(anchorAfterPick(undefined, NOW), NOW), 100);
  });

  it('the score halves every 10 days without rewriting the anchor', () => {
    const anchor = anchorAfterPick(undefined, NOW);
    near(scoreAt(anchor, NOW + 10 * DAY), 50);
    near(scoreAt(anchor, NOW + 20 * DAY), 25);
  });

  it('a second pick adds 100 to the decayed score', () => {
    const first = anchorAfterPick(undefined, NOW);
    const second = anchorAfterPick(first, NOW + 10 * DAY);
    near(scoreAt(second, NOW + 10 * DAY), 150);
  });

  it('an option never picked scores 0', () => {
    assert.equal(scoreAt(undefined, NOW), 0);
  });
});

describe('recordPick', () => {
  it('records per command and value without touching the input', () => {
    const before = {};
    const after = recordPick(before, 'switch space', 'Work', NOW);
    assert.deepEqual(before, {});
    near(scoreAt(after['switch space'].work, NOW), 100);
    assert.equal(after['switch space'].home, undefined);
  });

  it('keeps a different command separate', () => {
    const usage = recordPick({}, 'switch space', 'Work', NOW);
    assert.equal(usage['move to space'], undefined);
  });
});

describe('rankByUsage', () => {
  it('puts used options first by score, then unused ones in their supplied order', () => {
    let usage = {};
    usage = recordPick(usage, 'switch space', 'Home', NOW);
    usage = recordPick(usage, 'switch space', 'Work', NOW);
    usage = recordPick(usage, 'switch space', 'Work', NOW);
    const ranked = rankByUsage(sug('Alpha', 'Home', 'Beta', 'Work'), usage, 'switch space', NOW);
    assert.deepEqual(values(ranked), ['Work', 'Home', 'Alpha', 'Beta']);
  });

  it('prefers a recent pick over an older one of equal count', () => {
    let usage = {};
    usage = recordPick(usage, 'c', 'Old', NOW - 30 * DAY);
    usage = recordPick(usage, 'c', 'New', NOW);
    assert.deepEqual(values(rankByUsage(sug('Old', 'New'), usage, 'c', NOW)), ['New', 'Old']);
  });

  it('ranks only within the suggestions it is given (a typed filter)', () => {
    const usage = recordPick({}, 'c', 'Work', NOW);
    assert.deepEqual(values(rankByUsage(sug('Alpha', 'Beta'), usage, 'c', NOW)), ['Alpha', 'Beta']);
  });

  it('ignores usage recorded for another command', () => {
    const usage = recordPick({}, 'other', 'Beta', NOW);
    assert.deepEqual(values(rankByUsage(sug('Alpha', 'Beta'), usage, 'c', NOW)), ['Alpha', 'Beta']);
  });

  it('matches values case-insensitively and does not mutate the input', () => {
    const usage = recordPick({}, 'c', 'beta', NOW);
    const input = sug('Alpha', 'Beta');
    assert.deepEqual(values(rankByUsage(input, usage, 'c', NOW)), ['Beta', 'Alpha']);
    assert.deepEqual(values(input), ['Alpha', 'Beta']);
  });

  it('returns the list as is when there is no usage', () => {
    assert.deepEqual(values(rankByUsage(sug('B', 'A'), undefined, 'c', NOW)), ['B', 'A']);
  });

  describe('exact match of the typed text', () => {
    const used = recordPick(recordPick({}, 'c', 'homework', NOW), 'c', 'homework', NOW);

    it('ranks first regardless of usage', () => {
      const ranked = rankByUsage(sug('homework', 'work'), used, 'c', NOW, 'work');
      assert.deepEqual(values(ranked), ['work', 'homework']);
    });

    it('matches the title, case-insensitively', () => {
      const input = [
        { title: 'Homework', subtitle: '', value: 'homework' },
        { title: 'Work', subtitle: '', value: 'w1' },
      ];
      assert.deepEqual(values(rankByUsage(input, used, 'c', NOW, 'WORK')), ['w1', 'homework']);
    });

    it('ignores the param prefix on typed text and on options', () => {
      assert.deepEqual(
        values(rankByUsage(sug('#homework', '#work'), used, 'c', NOW, '#work', '#')),
        ['#work', '#homework']
      );
      assert.deepEqual(
        values(rankByUsage(sug('homework', 'work'), used, 'c', NOW, '#work', '#')),
        ['work', 'homework']
      );
    });

    it('applies when the command has no usage at all', () => {
      assert.deepEqual(values(rankByUsage(sug('homework', 'work'), undefined, 'c', NOW, 'work')),
        ['work', 'homework']);
    });

    it('changes nothing with no typed text', () => {
      assert.deepEqual(values(rankByUsage(sug('work', 'homework'), used, 'c', NOW, '')),
        ['homework', 'work']);
    });
  });
});
