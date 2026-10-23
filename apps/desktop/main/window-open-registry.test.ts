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
  reportOwnedWindowOpened,
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

test('any window a tile opened is reported as owned, keepLive or not', () => {
  const seen: string[] = [];
  const report = (tile: string, id: string) => { seen.push(`${tile}:${id}`); };
  // A plain, non-keepLive window opened from a tile's address.
  setWindowOpenPayload(wid('p1'), 'peek://peeks/background.html', { keepLive: false });
  reportOwnedWindowOpened(wid('p1'), false, report);
  // The tile's own window (declared opener) is reported by the launcher instead.
  setWindowOpenerTile(wid('p2'), 'peeks');
  reportOwnedWindowOpened(wid('p2'), true, report);
  // A window with no opener tile.
  reportOwnedWindowOpened(wid('p3'), false, report);
  assert.deepEqual(seen, ['peeks:p1']);
  removeWindowOpenPayload(wid('p1'));
  removeWindowOpenPayload(wid('p2'));
});
