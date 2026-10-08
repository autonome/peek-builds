/**
 * The address bar shows when a page starts loading and hides once the load
 * settles, unless the user revealed it themselves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  navbarRevealOnLoad,
  pointerLeaveHides,
  SHOWN_BY_LOAD,
  SHOWN_BY_USER,
} from '../../renderer/page/navbar-load-reveal.js';

test('a page that starts loading shows the hidden address bar', () => {
  assert.deepEqual(navbarRevealOnLoad(null, true), { action: 'show', shownBy: SHOWN_BY_LOAD });
});

test('the load that showed the bar hides it when it settles', () => {
  assert.deepEqual(navbarRevealOnLoad(SHOWN_BY_LOAD, false), { action: 'hide', shownBy: null });
});

test('opening a page shows the bar and then hides it', () => {
  const shown = navbarRevealOnLoad(null, true);
  const settled = navbarRevealOnLoad(shown.shownBy, false);
  assert.equal(shown.action, 'show');
  assert.equal(settled.action, 'hide');
});

test('a bar the user revealed is not taken over by a load', () => {
  assert.deepEqual(navbarRevealOnLoad(SHOWN_BY_USER, true), { action: 'none', shownBy: SHOWN_BY_USER });
});

test('a bar the user revealed stays up when a load settles', () => {
  assert.deepEqual(navbarRevealOnLoad(SHOWN_BY_USER, false), { action: 'none', shownBy: SHOWN_BY_USER });
});

test('the pointer moving over a loading page leaves the load-held bar up', () => {
  assert.equal(pointerLeaveHides(SHOWN_BY_LOAD), false);
});

test('the pointer leaving a bar the user revealed starts its hide', () => {
  assert.equal(pointerLeaveHides(SHOWN_BY_USER), true);
  assert.equal(pointerLeaveHides(null), true);
});

test('a settled load with the bar hidden changes nothing', () => {
  assert.deepEqual(navbarRevealOnLoad(null, false), { action: 'none', shownBy: null });
});
