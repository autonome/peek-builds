import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAccelerator, acceleratorFromKeyEvent, resolveSheetHotkey, withSheetHotkey,
  findHotkeyConflict, buildSheetShortcuts, SHEET_OPEN_TOPIC
} from '../../features/sheets/sheet-hotkeys.js';

describe('normalizeAccelerator', () => {
  it('canonicalizes spellings and modifier order', () => {
    assert.equal(normalizeAccelerator('shift+option+1'), 'Alt+Shift+1');
    assert.equal(normalizeAccelerator('Cmd+Ctrl+k'), 'Command+Control+K');
    assert.equal(normalizeAccelerator('Alt+ArrowUp'), 'Alt+Up');
  });
  it('rejects unusable accelerators', () => {
    assert.equal(normalizeAccelerator(''), null);
    assert.equal(normalizeAccelerator(null), null);
    assert.equal(normalizeAccelerator('Alt'), null);
    assert.equal(normalizeAccelerator('K'), null);
    assert.equal(normalizeAccelerator('Alt+A+B'), null);
    assert.equal(normalizeAccelerator('Alt+Nonsense'), null);
  });
  it('allows a function key alone', () => {
    assert.equal(normalizeAccelerator('f5'), 'F5');
  });
});

describe('acceleratorFromKeyEvent', () => {
  it('uses the physical key so Alt+digit is not a symbol', () => {
    assert.equal(acceleratorFromKeyEvent({ key: '¡', code: 'Digit1', altKey: true }), 'Alt+1');
  });
  it('ignores modifier-only presses and cancel keys', () => {
    assert.equal(acceleratorFromKeyEvent({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }), null);
    assert.equal(acceleratorFromKeyEvent({ key: 'Escape', code: 'Escape' }), null);
    assert.equal(acceleratorFromKeyEvent({ key: 'Backspace', code: 'Backspace' }), null);
  });
  it('needs a modifier except for function keys', () => {
    assert.equal(acceleratorFromKeyEvent({ key: 'a', code: 'KeyA' }), null);
    assert.equal(acceleratorFromKeyEvent({ key: 'F5', code: 'F5' }), 'F5');
    assert.equal(acceleratorFromKeyEvent({ key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true, shiftKey: true }), 'Command+Shift+Left');
  });
});

describe('resolveSheetHotkey / withSheetHotkey', () => {
  it('reads no key from an old config', () => {
    assert.equal(resolveSheetHotkey({ name: 'a' }), null);
    assert.equal(resolveSheetHotkey(null), null);
  });
  it('defaults the scope to global and validates the keys', () => {
    assert.deepEqual(resolveSheetHotkey({ hotkey: { keys: 'alt+2' } }), { keys: 'Alt+2', scope: 'global' });
    assert.deepEqual(resolveSheetHotkey({ hotkey: { keys: 'alt+2', scope: 'app' } }), { keys: 'Alt+2', scope: 'app' });
    assert.equal(resolveSheetHotkey({ hotkey: { keys: 'x' } }), null);
  });
  it('sets and removes a key without touching other fields', () => {
    const cfg = { name: 'a', items: [1] };
    const set = withSheetHotkey(cfg, { keys: 'option+3', scope: 'app' });
    assert.deepEqual(set, { name: 'a', items: [1], hotkey: { keys: 'Alt+3', scope: 'app' } });
    assert.equal(cfg.hotkey, undefined);
    assert.equal('hotkey' in withSheetHotkey(set, null), false);
    assert.equal('hotkey' in withSheetHotkey(set, { keys: 'bad' }), false);
  });
});

describe('findHotkeyConflict', () => {
  const map = {
    'sheet:a': { name: 'A', hotkey: { keys: 'Alt+1' } },
    'sheet:b': { name: 'B', hotkey: { keys: 'Alt+2', scope: 'app' } },
    'sheet:c': { name: 'C' }
  };
  it('finds another sheet using the key, in any spelling and scope', () => {
    assert.deepEqual(findHotkeyConflict(map, 'c', 'option+1'), { sheetId: 'a', name: 'A' });
    assert.deepEqual(findHotkeyConflict(map, 'c', 'Alt+2'), { sheetId: 'b', name: 'B' });
  });
  it('does not conflict with the sheet itself or an unused key', () => {
    assert.equal(findHotkeyConflict(map, 'a', 'Alt+1'), null);
    assert.equal(findHotkeyConflict(map, 'c', 'Alt+9'), null);
    assert.equal(findHotkeyConflict(null, 'c', 'Alt+9'), null);
  });
});

describe('buildSheetShortcuts', () => {
  it('declares global keys as wake shortcuts and lists app keys as local', () => {
    const out = buildSheetShortcuts({
      'sheet:a': { hotkey: { keys: 'Alt+1', scope: 'global' } },
      'sheet:b': { hotkey: { keys: 'Alt+2', scope: 'app' } },
      'sheet:c': { name: 'no key' }
    });
    assert.deepEqual(out.wake, [{ accelerator: 'Alt+1', wakeTopic: SHEET_OPEN_TOPIC, wakeArgs: ['a'] }]);
    assert.deepEqual(out.local, [{ keys: 'Alt+2', sheetId: 'b' }]);
    assert.deepEqual(out.skipped, []);
  });
  it('gives a duplicated key to the first sheet only and reports the rest', () => {
    const out = buildSheetShortcuts({
      'sheet:a': { hotkey: { keys: 'Alt+1' } },
      'sheet:b': { hotkey: { keys: 'option+1', scope: 'app' } }
    });
    assert.equal(out.wake.length, 1);
    assert.equal(out.local.length, 0);
    assert.deepEqual(out.skipped, [{ sheetId: 'b', keys: 'Alt+1', keptBy: 'a' }]);
  });
  it('returns empty lists for no sheets, so an empty set can still be declared', () => {
    for (const input of [{}, null, undefined]) {
      assert.deepEqual(buildSheetShortcuts(input), { wake: [], local: [], skipped: [] });
    }
  });
});
