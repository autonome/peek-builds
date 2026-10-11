/**
 * The address bar shows only when a page window first appears (or its first
 * load starts before the chrome reaches it), stays up for a minimum dwell
 * measured from when it was shown or until the load finishes (whichever is
 * later), then hides — unless the user revealed it themselves. Later loads in
 * an already-revealed window do not show it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  navbarLoadReveal,
  pointerLeaveHides,
  LOAD_REVEAL_DWELL_MS,
  SHOWN_BY_LOAD,
  SHOWN_BY_USER,
} from '../../renderer/page/navbar-load-reveal.js';

const HIDDEN = { shownBy: null, shownAt: null };
const HIDDEN_REVEALED = { shownBy: null, shownAt: null, revealed: true };

test('the dwell is 1500 ms', () => {
  assert.equal(LOAD_REVEAL_DWELL_MS, 1500);
});

test('the first load of a window not yet revealed shows the hidden address bar and holds it', () => {
  assert.deepEqual(navbarLoadReveal(HIDDEN, 'load-start', 1000), {
    show: true, hideAfterMs: null, shownBy: SHOWN_BY_LOAD, shownAt: 1000,
  });
});

test('a later load in an already-revealed window does not show the bar', () => {
  assert.deepEqual(navbarLoadReveal(HIDDEN_REVEALED, 'load-start', 1000), {
    show: false, hideAfterMs: null, shownBy: null, shownAt: null,
  });
});

test('a load settling in an already-revealed window with the bar hidden changes nothing', () => {
  assert.deepEqual(navbarLoadReveal(HIDDEN_REVEALED, 'load-stop', 1000), {
    show: false, hideAfterMs: null, shownBy: null, shownAt: null,
  });
});

test('a load that finishes before the dwell ends keeps the bar up for the rest of the dwell', () => {
  const shown = navbarLoadReveal(HIDDEN, 'load-start', 1000);
  const settled = navbarLoadReveal(shown, 'load-stop', 1030);
  assert.equal(settled.show, false);
  assert.equal(settled.hideAfterMs, LOAD_REVEAL_DWELL_MS - 30);
  assert.equal(settled.shownBy, SHOWN_BY_LOAD);
});

test('a load that finishes after the dwell hides the bar at once', () => {
  const shown = navbarLoadReveal(HIDDEN, 'load-start', 1000);
  const settled = navbarLoadReveal(shown, 'load-stop', 1000 + LOAD_REVEAL_DWELL_MS + 2000);
  assert.equal(settled.hideAfterMs, 0);
});

test('a second navigation while the first reveal is held does not restart the dwell', () => {
  const first = navbarLoadReveal(HIDDEN, 'load-start', 1000);
  const second = navbarLoadReveal({ ...first, revealed: true }, 'load-start', 1800);
  assert.equal(second.show, false);
  assert.equal(second.shownAt, 1000);
  assert.equal(second.shownBy, SHOWN_BY_LOAD);
});

test('a window that appears with its page already loaded shows the bar for the full dwell', () => {
  assert.deepEqual(navbarLoadReveal(HIDDEN, 'window-appeared', 5000, false), {
    show: true, hideAfterMs: LOAD_REVEAL_DWELL_MS, shownBy: SHOWN_BY_LOAD, shownAt: 5000,
  });
});

test('a window that appears still loading shows the bar until its load settles', () => {
  const appeared = navbarLoadReveal(HIDDEN, 'window-appeared', 5000, true);
  assert.equal(appeared.show, true);
  assert.equal(appeared.hideAfterMs, null);
  assert.equal(navbarLoadReveal(appeared, 'load-stop', 5100).hideAfterMs, LOAD_REVEAL_DWELL_MS - 100);
});

test('switching to an existing window never shows the bar, loading or not', () => {
  for (const loading of [true, false]) {
    assert.deepEqual(navbarLoadReveal(HIDDEN_REVEALED, 'window-switched', 1000, loading), {
      show: false, hideAfterMs: null, shownBy: null, shownAt: null,
    });
  }
});

test('switching to an existing window takes down a bar another window\'s load was holding', () => {
  const held = navbarLoadReveal(HIDDEN, 'load-start', 1000);
  for (const loading of [true, false]) {
    const r = navbarLoadReveal(held, 'window-switched', 1100, loading);
    assert.equal(r.show, false);
    assert.equal(r.hideAfterMs, 0);
  }
});

test('a settled load with the bar hidden changes nothing', () => {
  assert.deepEqual(navbarLoadReveal(HIDDEN, 'load-stop', 1000), {
    show: false, hideAfterMs: null, shownBy: null, shownAt: null,
  });
});

test('a bar the user revealed is not taken over by a load, a new window, or a load settling', () => {
  const user = { shownBy: SHOWN_BY_USER, shownAt: null };
  for (const [event, loading] of [
    ['load-start', true], ['load-stop', false],
    ['window-appeared', false], ['window-switched', false],
  ]) {
    assert.deepEqual(navbarLoadReveal(user, event, 1000, loading), {
      show: false, hideAfterMs: null, shownBy: SHOWN_BY_USER, shownAt: null,
    }, event);
  }
});

test('the pointer moving over a loading page leaves the load-held bar up', () => {
  assert.equal(pointerLeaveHides(SHOWN_BY_LOAD), false);
});

test('the pointer leaving a bar the user revealed starts its hide', () => {
  assert.equal(pointerLeaveHides(SHOWN_BY_USER), true);
  assert.equal(pointerLeaveHides(null), true);
});
