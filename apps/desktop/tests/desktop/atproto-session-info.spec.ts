/**
 * Integration spec for the REGISTERED `tile:atproto:session-info` IPC handler,
 * reached through `window.app.atproto.sessionInfo()` on the trustedBuiltin
 * test-fixture renderer.
 *
 * The handler reports whether a usable stored atproto session exists and which
 * account it belongs to, without ever returning token material. Rows are seeded
 * straight into the booted profile's `feature_settings` table (the same row the
 * Lex feature writes), so the real `readAtprotoSession()` read path runs. Fake
 * values only.
 */

import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

const FAKE_DID = 'did:plc:testaccount0000000000000';
const FAKE_HANDLE = 'test.example';

const FAKE_SESSION = {
  accessToken: 'fake-access-token',
  refreshToken: 'fake-refresh-token',
  pdsUrl: 'https://pds.test.example',
  tokenEndpoint: 'https://pds.test.example/oauth/token',
  dpopKeyPairJwk: {
    privateKey: { kty: 'EC', crv: 'P-256', x: 'fake', y: 'fake', d: 'fake' },
    publicKey: { kty: 'EC', crv: 'P-256', x: 'fake', y: 'fake' },
  },
  did: FAKE_DID,
  handle: FAKE_HANDLE,
};

/** Write the `lex_session` feature_settings row in the booted main process. */
async function seedSessionRow(app: DesktopApp, value: string): Promise<void> {
  // evaluateMain has no dynamic import, so open a second handle on the
  // profile's sqlite file (WAL mode allows it) instead of reusing getDb().
  await app.evaluateMain!(({ app: electronApp }, v: string) => {
    const get = (process as any).getBuiltinModule as (id: string) => any;
    const fs = get('node:fs');
    const path = get('node:path');
    const { DatabaseSync } = get('node:sqlite');
    const userData = electronApp.getPath('userData');
    // userData is the profile directory in a test launch; fall back to a
    // profile subdirectory in case that layout changes.
    const dbFile = [
      path.join(userData, 'datastore.sqlite'),
      ...fs.readdirSync(userData).map((d: string) => path.join(userData, d, 'datastore.sqlite')),
    ].find((f: string) => fs.existsSync(f));
    if (!dbFile) throw new Error(`no datastore.sqlite under ${userData}`);
    const db = new DatabaseSync(dbFile);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      db.prepare(`
        INSERT OR REPLACE INTO feature_settings (id, featureId, key, value, updatedAt)
        VALUES (?, ?, ?, ?, ?)
      `).run('lex_session', 'lex', 'session', v, Date.now());
    } finally {
      db.close();
    }
  }, value);
}

async function sessionInfo(bgWindow: Page): Promise<Record<string, unknown>> {
  return await bgWindow.evaluate(async () => await (window as any).app.atproto.sessionInfo());
}

test.describe('tile:atproto:session-info — registered IPC handler @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('atproto-session-info'));
    expect(typeof app.evaluateMain).toBe('function');
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test('reports signed out when no session row exists', async () => {
    expect(await sessionInfo(bgWindow)).toEqual({ signedIn: false });
  });

  test('reports the stored account and no token material', async () => {
    await seedSessionRow(app, JSON.stringify(FAKE_SESSION));
    const res = await sessionInfo(bgWindow);
    expect(res).toEqual({
      signedIn: true,
      handle: FAKE_HANDLE,
      did: FAKE_DID,
      pdsUrl: 'https://pds.test.example',
    });
    for (const key of ['accessToken', 'refreshToken', 'dpopKeyPairJwk']) {
      expect(Object.keys(res)).not.toContain(key);
    }
    expect(JSON.stringify(res)).not.toContain('fake-access-token');
    expect(JSON.stringify(res)).not.toContain('fake-refresh-token');
  });

  test('reports signed out after logout writes a null session', async () => {
    await seedSessionRow(app, 'null');
    expect(await sessionInfo(bgWindow)).toEqual({ signedIn: false });
  });
});
