/**
 * Unit coverage for the devtools target rule (peek item 621e283f).
 *
 * The cases here are the ones the old handler could not express: a feature
 * with no `background` entry at all, and the difference between "never
 * loaded" and "lifecycle says ready but no window exists".
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { STATES } from './tile-fsm.js';
import {
  RUNNING_STATES,
  liveDevtoolsEntries,
  pickDevtoolsEntries,
  type EntryProbe,
  type EntryProbeResult,
} from './feature-devtools-target.js';

/** Build a probe from a plain map of entryId → probe result. */
function probeFrom(table: Record<string, EntryProbeResult>): EntryProbe {
  return (entryId: string) => table[entryId] ?? { state: STATES.UNREGISTERED, hasWindow: false };
}

const ready = { state: STATES.READY, hasWindow: true };
const visible = { state: STATES.VISIBLE, hasWindow: true };

describe('RUNNING_STATES', () => {
  it('is ready + visible only — loading has a window but has not signalled ready', () => {
    assert.deepStrictEqual([...RUNNING_STATES], [STATES.READY, STATES.VISIBLE]);
    assert.ok(!RUNNING_STATES.includes(STATES.LOADING));
  });
});

describe('liveDevtoolsEntries', () => {
  it('counts a ready entry with a window as live', () => {
    const result = liveDevtoolsEntries(['home'], probeFrom({ home: ready }));
    assert.deepStrictEqual(result, { live: ['home'], drift: [] });
  });

  it('counts a visible entry with a window as live', () => {
    const result = liveDevtoolsEntries(['home'], probeFrom({ home: visible }));
    assert.deepStrictEqual(result, { live: ['home'], drift: [] });
  });

  it('does not count registered, loading, unloading or crashed entries', () => {
    const table: Record<string, EntryProbeResult> = {
      a: { state: STATES.REGISTERED, hasWindow: false },
      b: { state: STATES.LOADING, hasWindow: true },
      c: { state: STATES.UNLOADING, hasWindow: true },
      d: { state: STATES.CRASHED, hasWindow: true },
    };
    const result = liveDevtoolsEntries(['a', 'b', 'c', 'd'], probeFrom(table));
    assert.deepStrictEqual(result, { live: [], drift: [] });
  });

  it('reports a running state with no window as drift, not as not-running', () => {
    const result = liveDevtoolsEntries(
      ['background'],
      probeFrom({ background: { state: STATES.READY, hasWindow: false } }),
    );
    assert.deepStrictEqual(result, { live: [], drift: ['background'] });
  });

  it('splits a mixed entry set into live and drift', () => {
    const table: Record<string, EntryProbeResult> = {
      background: { state: STATES.READY, hasWindow: false },
      home: visible,
      panel: { state: STATES.REGISTERED, hasWindow: false },
    };
    const result = liveDevtoolsEntries(['background', 'home', 'panel'], probeFrom(table));
    assert.deepStrictEqual(result, { live: ['home'], drift: ['background'] });
  });
});

describe('pickDevtoolsEntries', () => {
  it('resolves a feature whose only live entry is home, with no background declared', () => {
    const { live, drift } = liveDevtoolsEntries(['home'], probeFrom({ home: ready }));
    const picked = pickDevtoolsEntries(undefined, live, drift, 'websearch');
    assert.deepStrictEqual(picked, { entries: ['home'] });
  });

  it('prefers background when background and home are both live', () => {
    const { live, drift } = liveDevtoolsEntries(
      ['background', 'home'],
      probeFrom({ background: ready, home: visible }),
    );
    const picked = pickDevtoolsEntries(undefined, live, drift, 'peeks');
    assert.deepStrictEqual(picked, { entries: ['background'] });
  });

  it('returns every live entry when none of them is background', () => {
    const picked = pickDevtoolsEntries(undefined, ['home', 'panel'], [], 'lists');
    assert.deepStrictEqual(picked, { entries: ['home', 'panel'] });
  });

  it('resolves an explicit entryId that is live to exactly that entry', () => {
    const picked = pickDevtoolsEntries('home', ['background', 'home'], [], 'peeks');
    assert.deepStrictEqual(picked, { entries: ['home'] });
  });

  it('errors on an explicit entryId that is not live, naming the live entries', () => {
    const picked = pickDevtoolsEntries('background', ['home'], [], 'websearch');
    assert.ok(picked.error, 'expected an error');
    assert.match(picked.error!, /websearch:background/);
    assert.match(picked.error!, /home/);
    assert.strictEqual(picked.entries, undefined);
  });

  it('reports drift distinctly from "may not be loaded yet"', () => {
    const picked = pickDevtoolsEntries(undefined, [], ['background'], 'mcp-server');
    assert.ok(picked.error, 'expected an error');
    assert.match(picked.error!, /Lifecycle state reports ready/);
    assert.match(picked.error!, /background/);
    assert.ok(
      !/may not be loaded yet/.test(picked.error!),
      'drift must not be reported as a never-loaded tile',
    );
  });

  it('reports "No active tile found" when nothing is live and nothing drifts', () => {
    const picked = pickDevtoolsEntries(undefined, [], [], 'windows');
    assert.ok(picked.error, 'expected an error');
    assert.match(picked.error!, /No active tile found for windows:background\./);
    assert.match(picked.error!, /The feature may not be loaded yet\./);
  });
});
