import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  argsFromCommandMessage, sheetNameOptions, findSheetByName,
  normalizeSheetName, withSheetName, sheetIdOfKey, DEFAULT_SHEET_NAME, resolveNameEdit
} from '../../features/sheets/sheet-commands.js';

test('resolveNameEdit saves a changed name, trimmed and collapsed', () => {
  assert.deepEqual(resolveNameEdit('Home', '  Work   board ', false), { save: true, name: 'Work board' });
});

test('resolveNameEdit keeps the current name on cancel, blank or unchanged', () => {
  assert.deepEqual(resolveNameEdit('Home', 'Work', true), { save: false, name: 'Home' });
  assert.deepEqual(resolveNameEdit('Home', '   ', false), { save: false, name: 'Home' });
  assert.deepEqual(resolveNameEdit('Home', ' Home ', false), { save: false, name: 'Home' });
});

test('argsFromCommandMessage prefers search, then params, then typed text', () => {
  assert.equal(argsFromCommandMessage({ search: ' Work ' }, 'new sheet'), 'Work');
  assert.equal(argsFromCommandMessage({ params: ['My', 'Board'] }, 'new sheet'), 'My Board');
  assert.equal(argsFromCommandMessage({ typed: 'new sheet Home' }, 'new sheet'), 'Home');
  assert.equal(argsFromCommandMessage({ typed: 'new sheet' }, 'new sheet'), '');
  assert.equal(argsFromCommandMessage(null, 'new sheet'), '');
});

test('sheetNameOptions is plain data that survives structured cloning', () => {
  const opts = sheetNameOptions([
    { key: 'sheet:b', name: 'Beta', createdAt: 0, items: [{}, {}] },
    { key: 'sheet:a', name: 'Alpha', items: [{}] },
    { key: 'sheet:c' }
  ]);
  assert.deepEqual(opts.map((o) => o.value), ['Alpha', 'Beta']);
  assert.equal(opts[0].subtitle, '1 card');
  assert.match(opts[1].subtitle, /^2 cards · created /);
  assert.doesNotThrow(() => structuredClone(opts));
});

test('findSheetByName matches exact before partial, ignoring case', () => {
  const sheets = [{ name: 'Work stuff' }, { name: 'Work' }];
  assert.equal(findSheetByName(sheets, 'work').name, 'Work');
  assert.equal(findSheetByName(sheets, 'stuff').name, 'Work stuff');
  assert.equal(findSheetByName(sheets, 'nope'), null);
  assert.equal(findSheetByName(sheets, '  '), null);
});

test('names are trimmed and a blank rename keeps the old name', () => {
  assert.equal(normalizeSheetName('  a   b '), 'a b');
  assert.equal(normalizeSheetName(''), DEFAULT_SHEET_NAME);
  const config = { name: 'Old', items: [] };
  assert.deepEqual(withSheetName(config, ' New '), { name: 'New', items: [] });
  assert.equal(withSheetName(config, '   '), config);
  assert.equal(sheetIdOfKey('sheet:abc'), 'abc');
});
