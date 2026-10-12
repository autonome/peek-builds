/**
 * Unit tests for renderer/cmd/object-pairs.js — top-level rows that pair a command with one of
 * its enum options ("switch space work") when the typed text matches the option's name.
 *
 * Run via: node --test tests/unit/cmd-object-pairs.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modulePath = join(__dirname, '..', '..', 'renderer', 'cmd', 'object-pairs.js');
const { pairRowsFor, withPairRows } = await import(modulePath);
const { recordPick } = await import(join(__dirname, '..', '..', 'renderer', 'cmd', 'usage-rank.js'));

const NOW = 1_800_000_000_000;
const enumCmd = (name, ...values) => ({
  name,
  params: [{ type: 'enum', options: values.map(v => ({ value: v, title: v })) }],
});
const COMMANDS = [
  enumCmd('switch space', 'work', 'home', 'workshop'),
  enumCmd('move to space', 'work', 'home', 'workshop'),
  { name: 'reload', params: [] },
];
const names = rows => rows.map(r => r.name);

describe('pairRowsFor', () => {
  it('pairs each enum command with each option whose name matches', () => {
    const rows = pairRowsFor('work', COMMANDS, {}, NOW);
    assert.deepEqual(names(rows).sort(), [
      'move to space work', 'move to space workshop', 'switch space work', 'switch space workshop',
    ]);
    const row = rows.find(r => r.name === 'switch space work');
    assert.equal(row.command, 'switch space');
    assert.equal(row.value, 'work');
  });

  it('needs at least two typed characters', () => {
    assert.deepEqual(pairRowsFor('w', COMMANDS, {}, NOW), []);
    assert.deepEqual(pairRowsFor('  w ', COMMANDS, {}, NOW), []);
  });

  it('matches the option title as well as its value', () => {
    const cmds = [{ name: 'settings', params: [{ type: 'enum', options: [{ value: 'privacy', title: 'Extensions' }] }] }];
    const rows = pairRowsFor('exten', cmds, {}, NOW);
    assert.deepEqual(names(rows), ['settings Extensions']);
    assert.equal(rows[0].value, 'privacy');
  });

  it('accepts plain string values', () => {
    const cmds = [{ name: 'pick', params: [{ type: 'enum', values: ['alpha', 'beta'] }] }];
    assert.deepEqual(names(pairRowsFor('alp', cmds, {}, NOW)), ['pick alpha']);
  });

  it('skips non-enum and multi-value parameters', () => {
    const cmds = [
      { name: 'tag', params: [{ type: 'tag', options: [{ value: 'work', title: 'work' }] }] },
      { name: 'multi', params: [{ type: 'enum', multiple: true, values: ['work'] }] },
    ];
    assert.deepEqual(pairRowsFor('work', cmds, {}, NOW), []);
  });

  it('orders by pair usage, then match tier, then command order', () => {
    const usage = recordPick({}, 'move to space', 'workshop', NOW);
    const rows = pairRowsFor('work', COMMANDS, usage, NOW);
    assert.deepEqual(names(rows), [
      'move to space workshop', // used
      'switch space work', // exact before prefix
      'move to space work',
      'switch space workshop',
    ]);
  });
});

describe('pairRowsFor with pairPriority', () => {
  const withPriority = (cmd, pairPriority) => ({ ...cmd, pairPriority });
  const SPACES = [
    withPriority(enumCmd('switch space', 'work', 'home', 'workshop'), 1),
    enumCmd('rename space', 'work', 'home', 'workshop'),
    enumCmd('move to space', 'work', 'home', 'workshop'),
  ];

  it('puts the higher-priority command first for the same option, whatever the usage', () => {
    let usage = {};
    for (let i = 0; i < 20; i++) usage = recordPick(usage, 'move to space', 'work', NOW - i * 1000);
    const pairs = pairRowsFor('work', SPACES, usage, NOW);
    const merged = withPairRows(['workflow'], pairs);
    assert.equal(merged[0], 'switch space work');
    assert.ok(merged.indexOf('switch space work') < merged.indexOf('move to space work'));
  });

  it('still orders the other commands for that option by usage', () => {
    const usage = recordPick({}, 'move to space', 'work', NOW);
    const pairs = pairRowsFor('work', SPACES, usage, NOW);
    assert.deepEqual(names(pairs).slice(0, 3), ['switch space work', 'move to space work', 'rename space work']);
  });

  it('still orders different options by usage', () => {
    const usage = recordPick({}, 'move to space', 'workshop', NOW);
    const pairs = pairRowsFor('work', SPACES, usage, NOW);
    // The used option keeps the top slot, and the priority command takes it. Each option's
    // rows keep the slots usage gave them.
    assert.deepEqual(names(pairs), [
      'switch space workshop',
      'switch space work',
      'rename space work',
      'move to space work',
      'move to space workshop',
      'rename space workshop',
    ]);
  });
});

describe('withPairRows', () => {
  it('puts pair rows after the command matches when no option name equals the typed text', () => {
    const pairs = pairRowsFor('wor', COMMANDS, {}, NOW);
    assert.deepEqual(withPairRows(['workflow'], pairs), [
      'workflow', 'switch space work', 'move to space work', 'switch space workshop', 'move to space workshop',
    ]);
  });

  it('puts exact-match pair rows first, by usage, ahead of command matches', () => {
    const usage = recordPick({}, 'move to space', 'work', NOW);
    const pairs = pairRowsFor('work', COMMANDS, usage, NOW);
    assert.deepEqual(withPairRows(['workflow'], pairs), [
      'move to space work', 'switch space work', 'workflow', 'switch space workshop', 'move to space workshop',
    ]);
  });

  it('pair usage and parameter-mode usage are the same data', () => {
    // A pick made in parameter mode ("move to space" -> "home") ranks the pair row too.
    const usage = recordPick({}, 'move to space', 'home', NOW);
    const pairs = pairRowsFor('hom', COMMANDS, usage, NOW);
    assert.deepEqual(names(pairs), ['move to space home', 'switch space home']);
  });

  it('keeps command matches unchanged when there are no pair rows', () => {
    assert.deepEqual(withPairRows(['a', 'b'], []), ['a', 'b']);
  });

  it('drops a pair row whose text is already a command match', () => {
    const pairs = pairRowsFor('work', COMMANDS, {}, NOW);
    const merged = withPairRows(['switch space work'], pairs);
    assert.equal(merged.filter(n => n === 'switch space work').length, 1);
  });
});
