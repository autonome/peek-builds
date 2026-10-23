import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WindowId } from './window-kernel.js';
import {
  tileIdFromSource,
  setWindowOpenPayload,
  setWindowOpenerTile,
  getWindowOpenerTile,
  listWindowsOpenedByTile,
  tileOwnsLiveKeepLiveWindow,
  removeWindowOpenPayload,
} from './window-open-registry.js';

const wid = (s: string): WindowId => s as WindowId;

test('tileIdFromSource reads the host of a peek:// address', () => {
  assert.equal(tileIdFromSource('peek://slides/background.html'), 'slides');
  assert.equal(tileIdFromSource('peek://editor?x=1'), 'editor');
  assert.equal(tileIdFromSource('https://example.com/'), null);
  assert.equal(tileIdFromSource(undefined), null);
});

test('a window opened from a tile address names that tile', () => {
  setWindowOpenPayload(wid('w1'), 'peek://slides/background.html', {});
  assert.equal(getWindowOpenerTile(wid('w1')), 'slides');
  assert.deepEqual(listWindowsOpenedByTile('slides'), ['w1']);
  removeWindowOpenPayload(wid('w1'));
  assert.equal(getWindowOpenerTile(wid('w1')), null);
});

test('an explicit opener is not overridden by the source address', () => {
  setWindowOpenerTile(wid('w2'), 'peeks');
  setWindowOpenPayload(wid('w2'), 'peek://app/page', {});
  assert.equal(getWindowOpenerTile(wid('w2')), 'peeks');
  removeWindowOpenPayload(wid('w2'));
});

test('a non-tile source leaves the opener unset', () => {
  setWindowOpenPayload(wid('w3'), 'https://example.com/', {});
  assert.equal(getWindowOpenerTile(wid('w3')), null);
  removeWindowOpenPayload(wid('w3'));
});

test('tileOwnsLiveKeepLiveWindow is true only for that tile with a live keepLive window', () => {
  setWindowOpenPayload(wid('a'), 'peek://slides/background.html', {});
  setWindowOpenPayload(wid('b'), 'peek://slides/background.html', {});
  setWindowOpenPayload(wid('c'), 'peek://peeks/background.html', {});
  const keepLive = new Set<string>(['b', 'c']);
  const check = (id: WindowId) => keepLive.has(id);
  assert.equal(tileOwnsLiveKeepLiveWindow('slides', check), true);
  assert.equal(tileOwnsLiveKeepLiveWindow('peeks', check), true);
  assert.equal(tileOwnsLiveKeepLiveWindow('editor', check), false);
  keepLive.delete('b');
  assert.equal(tileOwnsLiveKeepLiveWindow('slides', check), false);
  assert.equal(tileOwnsLiveKeepLiveWindow('peeks', check), true);
  for (const id of ['a', 'b', 'c']) removeWindowOpenPayload(wid(id));
  assert.equal(tileOwnsLiveKeepLiveWindow('peeks', () => true), false);
});
