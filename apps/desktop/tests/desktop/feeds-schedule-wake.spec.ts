/**
 * Feeds runs unattended: on a fresh profile, with no user action at all, the
 * feeds background tile is awake and has recorded a poll run.
 *
 * `feeds`' background entry declares `schedule: [{ topic: 'feeds:poll',
 * everyMinutes: 15 }]`. The entry has never fired on a fresh profile, so it is
 * due the moment boot finishes registering tiles: main publishes `feeds:poll`,
 * the load-on-dispatch hook wakes the sleeping tile, and the fire is persisted
 * in `tile_schedule_runs` so the next launch does not reset the interval. This
 * is the whole point of the feature — before it, feeds polled only after
 * someone ran a feeds command in that session.
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';
import { waitForExtensionsReady } from '../helpers/window-utils';

let app: DesktopApp;
let bgWindow: Page;

/** True iff any live BrowserWindow's URL contains the given substring. */
const windowUrlExists = (needle: string): Promise<boolean> =>
  app.evaluateMain!(((electron: typeof import('electron'), n: string) => {
    const { BrowserWindow } = electron;
    return BrowserWindow.getAllWindows().some((w) => {
      try { return w.webContents.getURL().includes(n); } catch { return false; }
    });
  }) as any, needle) as Promise<boolean>;

/**
 * The `tile_schedule_runs` rows for one tile, read from the profile's
 * datastore. Opened as a second handle inside main, the way
 * `atproto-session-info.spec.ts` does — `evaluateMain` has no dynamic import.
 */
const scheduleRuns = (tileId: string): Promise<Array<{ topic: string; lastRunAt: number }>> =>
  app.evaluateMain!((({ app: electronApp }: { app: typeof import('electron').app }, id: string) => {
    const get = (process as any).getBuiltinModule as (m: string) => any;
    const fs = get('node:fs');
    const path = get('node:path');
    const { DatabaseSync } = get('node:sqlite');
    const userData = electronApp.getPath('userData');
    const dbFile = [
      path.join(userData, 'datastore.sqlite'),
      ...fs.readdirSync(userData).map((d: string) => path.join(userData, d, 'datastore.sqlite')),
    ].find((f: string) => fs.existsSync(f));
    if (!dbFile) throw new Error(`no datastore.sqlite under ${userData}`);
    const db = new DatabaseSync(dbFile);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      return db
        .prepare('SELECT topic, lastRunAt FROM tile_schedule_runs WHERE ownerTileId = ?')
        .all(id);
    } finally {
      db.close();
    }
  }) as any, tileId) as Promise<Array<{ topic: string; lastRunAt: number }>>;

test.describe('Feeds Schedule Wake @desktop', () => {
  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('feeds-schedule-wake'));
    await waitForExtensionsReady(bgWindow, 15000);
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('the feeds background tile is awake after boot with no user action', async () => {
    // The boot fire lands while boot is still finishing, so the state — the
    // tile being loaded — is what we wait on, not the transition.
    await expect
      .poll(() => windowUrlExists('peek://feeds/background.html'), { timeout: 15000 })
      .toBe(true);
  });

  test('the boot fire is recorded in tile_schedule_runs for feeds / feeds:poll', async () => {
    const before = Date.now();
    await expect
      .poll(async () => (await scheduleRuns('feeds')).length, { timeout: 15000 })
      .toBeGreaterThan(0);

    const rows = await scheduleRuns('feeds');
    expect(rows.map(r => r.topic)).toContain('feeds:poll');
    const row = rows.find(r => r.topic === 'feeds:poll')!;
    // A real timestamp, not a zero or a placeholder: this launch wrote it.
    expect(row.lastRunAt).toBeGreaterThan(before - 10 * 60 * 1000);
    expect(row.lastRunAt).toBeLessThanOrEqual(Date.now());
  });
});
