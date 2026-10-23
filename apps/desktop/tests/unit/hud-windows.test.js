import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyWindow, summarizeWindows } from '../../renderer/lib/hud-windows.js';

const w = (url, params = {}, visible = false) => ({ url, params, visible });

test('classifies each known kind', () => {
  assert.equal(classifyWindow(w('peek://app/background.html')), 'Peek core');
  assert.equal(classifyWindow(w('peek://app/page/overlay.html')), 'Page chrome');
  assert.equal(classifyWindow(w('chrome-extension://abc/peek-bridge.html')), 'Extension helper');
  assert.equal(classifyWindow(w('peek://app/cmd/panel.html', { role: 'palette' })), 'Command palette');
  assert.equal(classifyWindow(w('peek://slides/background.html')), 'Feature: slides');
  assert.equal(classifyWindow(w('peek://ext/lists/background.html')), 'Feature: lists');
  assert.equal(classifyWindow(w('peek://peeks/home.html', { keepLive: true })), 'Kept-alive peek/slide');
  assert.equal(classifyWindow(w('https://example.com/')), 'Web page');
  assert.equal(classifyWindow(w('peek://settings/home.html')), 'App window');
});

test('unmatched entries land in Other and are reported', () => {
  const seen = [];
  const rows = summarizeWindows([w('weird:thing'), w('')], (e) => seen.push(e.url));
  assert.deepEqual(rows, [{ kind: 'Other', visible: 0, hidden: 2, total: 2 }]);
  assert.deepEqual(seen, ['weird:thing', '']);
});

test('summary counts visible and hidden per kind, largest first', () => {
  const rows = summarizeWindows([
    w('https://a.test/', {}, true), w('https://b.test/'), w('https://c.test/'),
    w('peek://app/background.html'), null,
  ]);
  assert.deepEqual(rows[0], { kind: 'Web page', visible: 1, hidden: 2, total: 3 });
  assert.equal(rows.reduce((n, r) => n + r.total, 0), 5);
});
