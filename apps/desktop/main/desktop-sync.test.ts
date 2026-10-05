// A window the user drags to another desktop reaches the kernel only through a provider read:
// no desktop switch fires for it. specs/kernel-desktops.md, "Backend algorithm".

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { initialState, evolve, windowById, type Event, type State, type WindowId } from './window-kernel.js';
import { syncDesktops, type DesktopSyncDeps } from './desktop-sync.js';
import type { DesktopProvider, Placement, ProviderLayout } from './desktop-provider.js';

const wid = (n: number): WindowId => `ds-${n}` as WindowId;

function harness(placementsOf: () => Placement[]) {
  let state: State = initialState();
  const apply = (ev: Event): void => {
    state = evolve(state, ev);
  };
  const layout: ProviderLayout = {
    screens: [{ display: '1', current: 'd1' }],
    desktops: [{ id: 'd1', display: '1' }, { id: 'd2', display: '1' }],
  };
  const provider = {
    layout: async () => layout,
    placements: async () => placementsOf(),
  } as unknown as DesktopProvider;
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const deps: DesktopSyncDeps = {
    provider,
    getState: () => state,
    platformIds: () => new Map([[100, wid(1)]]),
    layoutReported: (screens, desktops) => apply({ type: 'DesktopLayoutReported', screens, desktops }),
    currentDesktopChanged: (screen, desktop) => apply({ type: 'CurrentDesktopChanged', screen, desktop }),
    placementReported: (id, screen, desktop, onEveryDesktop) =>
      apply({ type: 'WindowPlacementReported', id, screen, desktop, onEveryDesktop }),
    desktopsRead: (switchesSeen) => apply({ type: 'DesktopsRead', switchesSeen }),
    log: (event, fields) => logs.push({ event, fields }),
  };
  apply({
    type: 'WindowRegistered', id: wid(1), kind: 'page-host', layer: 0, canBecomeKey: true,
    acceptsInput: true, class: 'primary', role: 'content',
  });
  apply({ type: 'WindowShown', id: wid(1) });
  return { deps, logs, desktopOf: () => windowById(state, wid(1))?.desktop };
}

describe('desktop-sync: a window moved between desktops without a switch', () => {
  it('a later read moves the record to the desktop the provider now reports', async () => {
    let at = 'd1';
    const h = harness(() => [{ window: 100, display: '1', desktop: at, onEveryDesktop: false }]);
    await syncDesktops('start', h.deps);
    assert.strictEqual(h.desktopOf(), 'd1');

    at = 'd2'; // the user drags the window in Mission Control; the current desktop stays d1
    await syncDesktops('refresh', h.deps);
    assert.strictEqual(h.desktopOf(), 'd2');
  });

  it('logs the placements it read, window to desktop', async () => {
    const h = harness(() => [{ window: 100, display: '1', desktop: 'd2', onEveryDesktop: false }]);
    await syncDesktops('refresh', h.deps);
    const end = h.logs.find((l) => l.event === 'sync-desktops-end');
    assert.strictEqual(end?.fields.placements, `${String(wid(1))}:d2`);
  });
});
