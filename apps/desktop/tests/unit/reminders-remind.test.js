/**
 * Unit tests for features/reminders/remind.js — reading `remind:<duration>`
 * tags and deciding what each item's reminder needs.
 *
 * Run via: node --test tests/unit/reminders-remind.test.js
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { parseRemindTag, planReminders, itemIdsWithRemindTags } = await import(
  join(__dirname, '../../features/reminders/remind.js')
);

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const NOW = 1_700_000_000_000;

/** An item as the datastore hands it back, carrying a stored reminder. */
function itemWithReminder(tag, dueAt) {
  return { metadata: { reminder: { tag, dueAt } } };
}

describe('parseRemindTag', () => {
  it('reads each unit', () => {
    assert.deepEqual(parseRemindTag('remind:1m'), { ms: MINUTE });
    assert.deepEqual(parseRemindTag('remind:1h'), { ms: HOUR });
    assert.deepEqual(parseRemindTag('remind:1d'), { ms: DAY });
    assert.deepEqual(parseRemindTag('remind:1w'), { ms: WEEK });
  });

  it('reads a multi-digit count', () => {
    assert.deepEqual(parseRemindTag('remind:90m'), { ms: 90 * MINUTE });
    assert.deepEqual(parseRemindTag('remind:3d'), { ms: 3 * DAY });
  });

  it('reads remind:due as the due state', () => {
    assert.deepEqual(parseRemindTag('remind:due'), { due: true });
  });

  it('refuses a bare prefix', () => {
    assert.equal(parseRemindTag('remind:'), null);
  });

  it('refuses a zero count', () => {
    assert.equal(parseRemindTag('remind:0d'), null);
  });

  it('refuses an unknown unit', () => {
    assert.equal(parseRemindTag('remind:3x'), null);
  });

  it('refuses two units in one tag', () => {
    assert.equal(parseRemindTag('remind:1h30m'), null);
  });

  it('refuses a tag without the prefix', () => {
    assert.equal(parseRemindTag('3d'), null);
    assert.equal(parseRemindTag('reminder:3d'), null);
    assert.equal(parseRemindTag('todo'), null);
  });
});

describe('planReminders', () => {
  it('starts a reminder for a tag it has not seen, due a duration from now', () => {
    const actions = planReminders({ a: ['remind:3d'] }, {}, NOW);
    assert.deepEqual(actions, [
      { itemId: 'a', kind: 'start', reminder: { tag: 'remind:3d', dueAt: NOW + 3 * DAY } },
    ]);
  });

  it('leaves a started reminder alone until it comes due', () => {
    const items = { a: itemWithReminder('remind:3d', NOW + DAY) };
    assert.deepEqual(planReminders({ a: ['remind:3d'] }, items, NOW), []);
  });

  it('marks a reminder due once its time has passed', () => {
    const items = { a: itemWithReminder('remind:3d', NOW - MINUTE) };
    assert.deepEqual(planReminders({ a: ['remind:3d'] }, items, NOW), [
      { itemId: 'a', kind: 'due', fromTag: 'remind:3d' },
    ]);
  });

  it('marks a reminder due exactly once — the applied swap is not due again', () => {
    const items = { a: itemWithReminder('remind:3d', NOW - MINUTE) };
    const first = planReminders({ a: ['remind:3d'] }, items, NOW);
    assert.equal(first.length, 1);
    assert.equal(first[0].kind, 'due');
    // What applying that action leaves behind: the duration tag swapped for
    // remind:due, the metadata kept.
    assert.deepEqual(planReminders({ a: ['remind:due'] }, items, NOW), []);
  });

  it('restarts the clock when the duration tag changes', () => {
    const items = { a: itemWithReminder('remind:3d', NOW - MINUTE) };
    assert.deepEqual(planReminders({ a: ['remind:1w'] }, items, NOW), [
      { itemId: 'a', kind: 'start', reminder: { tag: 'remind:1w', dueAt: NOW + WEEK } },
    ]);
  });

  it('clears the stored reminder when the tag is removed', () => {
    const items = { a: itemWithReminder('remind:3d', NOW + DAY) };
    assert.deepEqual(planReminders({ a: ['todo'] }, items, NOW), [
      { itemId: 'a', kind: 'clear' },
    ]);
  });

  it('reaches an item that has no tags left at all', () => {
    const items = { a: itemWithReminder('remind:3d', NOW + DAY) };
    assert.deepEqual(planReminders({}, items, NOW), [{ itemId: 'a', kind: 'clear' }]);
  });

  it('leaves a due item waiting while it still carries remind:due', () => {
    const items = { a: itemWithReminder('remind:3d', NOW - DAY) };
    assert.deepEqual(planReminders({ a: ['remind:due'] }, items, NOW), []);
  });

  it('clears the stored reminder once remind:due is dismissed', () => {
    const items = { a: itemWithReminder('remind:3d', NOW - DAY) };
    assert.deepEqual(planReminders({ a: [] }, items, NOW), [{ itemId: 'a', kind: 'clear' }]);
  });

  it('does nothing for a remind: tag that does not parse', () => {
    assert.deepEqual(planReminders({ a: ['remind:3x'] }, {}, NOW), []);
    assert.deepEqual(planReminders({ a: ['remind:'] }, {}, NOW), []);
  });

  it('does nothing for remind:due with no stored reminder', () => {
    assert.deepEqual(planReminders({ a: ['remind:due'] }, {}, NOW), []);
  });

  it('accepts tags as records with a name, and a Map of items', () => {
    const tags = new Map([['a', [{ name: 'remind:1h' }]]]);
    const items = new Map();
    assert.deepEqual(planReminders(tags, items, NOW), [
      { itemId: 'a', kind: 'start', reminder: { tag: 'remind:1h', dueAt: NOW + HOUR } },
    ]);
  });

  it('plans one item at a time across a mixed set', () => {
    const tags = {
      fresh: ['remind:1h'],
      waiting: ['remind:1w'],
      ripe: ['remind:1m'],
      dismissed: ['todo'],
      junk: ['remind:nope'],
    };
    const items = {
      waiting: itemWithReminder('remind:1w', NOW + WEEK),
      ripe: itemWithReminder('remind:1m', NOW - 1),
      dismissed: itemWithReminder('remind:1m', NOW - DAY),
    };
    const byId = Object.fromEntries(
      planReminders(tags, items, NOW).map(action => [action.itemId, action]),
    );
    assert.deepEqual(Object.keys(byId).sort(), ['dismissed', 'fresh', 'ripe']);
    assert.equal(byId.fresh.kind, 'start');
    assert.equal(byId.ripe.kind, 'due');
    assert.equal(byId.dismissed.kind, 'clear');
  });

  it('takes the first duration tag when an item carries several', () => {
    assert.deepEqual(planReminders({ a: ['remind:2h', 'remind:3d'] }, {}, NOW), [
      { itemId: 'a', kind: 'start', reminder: { tag: 'remind:2h', dueAt: NOW + 2 * HOUR } },
    ]);
  });
});

describe('itemIdsWithRemindTags', () => {
  it('names every item carrying a remind: tag, parseable or not', () => {
    const ids = itemIdsWithRemindTags({
      a: ['remind:3d'],
      b: ['remind:due'],
      c: ['remind:nope'],
      d: ['todo'],
      e: [],
    });
    assert.deepEqual(ids.sort(), ['a', 'b', 'c']);
  });
});
