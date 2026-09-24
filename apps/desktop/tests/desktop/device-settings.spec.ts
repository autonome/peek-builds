import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

// Exercises the Settings > Devices panel (renderDevicesSettings() in
// apps/desktop/renderer/settings/settings.js) and the Sync panel's
// enrolment-code entry against a stub HTTP server standing in for the sync
// server's account-holder routes (apps/server/index.js GET/PATCH/DELETE
// /devices, POST /devices/enrolment-codes, POST /enrol). The panels are
// driven through the real api.sync.* IPC surface — no server process, no
// sync.ts unit-test-style in-process fetch stub, since this is the renderer
// UI, not sync.ts itself.

interface StubDevice {
  id: string;
  label: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

// Which stub device each bearer key belongs to — the real server marks the
// requesting device `current` in GET /devices and on a self-revoke, and this
// is what lets the stub do the same.
const STUB_KEY = 'stub-test-key';
const ENROLLED_KEY = 'enrolled-key';
const ALREADY_REVOKED_KEY = 'already-revoked-key';
const STUB_CODE = 'ABCD2345';
const DEVICE_FOR_KEY: Record<string, string> = {
  [STUB_KEY]: 'dev-laptop',
  [ENROLLED_KEY]: 'dev-new',
  [ALREADY_REVOKED_KEY]: 'dev-tablet',
};

// dev-tablet models a device the real server has already revoked through
// some other path (a dropped response, two tabs both firing revoke) by the
// time THIS client's revoke call lands — the retry case
// tile-ipc.ts's tile:sync:revoke-device handler exists to handle. The stub
// answers its DELETE with `{revoked:false, current:true}` without touching
// revoked_at, so GET keeps listing it as active (this client never saw the
// other revoke) and the revoke button stays clickable.
const ALREADY_REVOKED_ON_SERVER = new Set(['dev-tablet']);

/** A minimal in-memory sync-server stub: GET list, PATCH rename, DELETE
 * revoke (with `current`), POST enrolment code (always STUB_CODE), and POST
 * /enrol (trades STUB_CODE for ENROLLED_KEY and adds the new device). */
function startDeviceStubServer(devices: StubDevice[]): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://stub.invalid');
      res.setHeader('Content-Type', 'application/json');
      const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
      const requestingDeviceId = DEVICE_FOR_KEY[bearer];

      const readJsonBody = (): Promise<Record<string, string>> =>
        new Promise((done) => {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', () => done(body ? JSON.parse(body) : {}));
        });

      if (req.method === 'GET' && url.pathname === '/devices') {
        res.end(JSON.stringify({
          devices: devices.map((d) => ({ ...d, current: d.id === requestingDeviceId })),
        }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/devices/enrolment-codes') {
        res.end(JSON.stringify({
          code: STUB_CODE,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/enrol') {
        readJsonBody().then((parsed) => {
          if (parsed.code !== STUB_CODE) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Invalid enrolment code' }));
            return;
          }
          const label = parsed.label || 'New device';
          devices.push({
            id: 'dev-new',
            label,
            created_at: new Date().toISOString(),
            last_seen_at: null,
            revoked_at: null,
          });
          res.end(JSON.stringify({
            device: { deviceId: 'dev-new', userId: 'stub-user', label, apiKey: ENROLLED_KEY },
          }));
        });
        return;
      }

      const deviceMatch = url.pathname.match(/^\/devices\/([^/]+)$/);
      if (req.method === 'PATCH' && deviceMatch) {
        readJsonBody().then((parsed) => {
          const device = devices.find((d) => d.id === deviceMatch[1]);
          if (!device) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'not found' }));
            return;
          }
          if (!parsed.label) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'label is required' }));
            return;
          }
          device.label = parsed.label;
          res.end(JSON.stringify({ device }));
        });
        return;
      }

      if (req.method === 'DELETE' && deviceMatch) {
        const device = devices.find((d) => d.id === deviceMatch[1]);
        if (!device) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }
        const alreadyRevokedElsewhere = ALREADY_REVOKED_ON_SERVER.has(device.id);
        if (!alreadyRevokedElsewhere) {
          device.revoked_at = new Date().toISOString();
        }
        res.end(JSON.stringify({
          revoked: !alreadyRevokedElsewhere,
          current: device.id === requestingDeviceId,
        }));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'not found' }));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

test.describe('Device Settings Panel @desktop', () => {
  let app: DesktopApp;
  let bgWindow: Page;
  let server: http.Server;
  let serverUrl: string;
  let devices: StubDevice[];

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('device-settings'));

    devices = [
      {
        id: 'dev-laptop',
        label: 'Laptop',
        created_at: '2026-01-01T00:00:00.000Z',
        last_seen_at: '2026-02-01T00:00:00.000Z',
        revoked_at: null,
      },
      {
        id: 'dev-phone',
        label: 'Phone',
        created_at: '2026-01-05T00:00:00.000Z',
        last_seen_at: null,
        revoked_at: null,
      },
      {
        id: 'dev-tablet',
        label: 'Tablet',
        created_at: '2026-01-10T00:00:00.000Z',
        last_seen_at: null,
        revoked_at: null,
      },
    ];
    ({ server, url: serverUrl } = await startDeviceStubServer(devices));
  });

  test.afterAll(async () => {
    if (app) await app.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('lists, renames, revokes (including itself), mints a code and enrols with it', async () => {
    const settingsWindow = await app.getWindow('settings/settings.html');
    expect(settingsWindow).toBeTruthy();
    await settingsWindow.waitForSelector('.settings-layout', { timeout: 5000 });

    // Point the desktop client's sync config at the stub server through the
    // real Sync panel inputs — `api` is a module-scoped import in
    // settings.js, not a window global, so this drives it the same way a
    // person configuring sync would.
    await settingsWindow.click('[data-section="sync"]');
    await settingsWindow.waitForSelector('#section-sync.active');

    const syncSection = settingsWindow.locator('#section-sync');
    const serverUrlInput = syncSection.locator('.form-group:has(label:text-is("Server URL")) input');
    await serverUrlInput.fill(serverUrl);
    await serverUrlInput.press('Tab');

    const apiKeyInput = syncSection.locator('.form-group:has(label:text-is("API Key")) input');
    await apiKeyInput.fill(STUB_KEY);
    await apiKeyInput.press('Tab');

    // The Sync panel's own status line flips once setConfig's IPC round trip
    // has actually landed — wait on it rather than an arbitrary timeout.
    await expect(syncSection.getByText('Status: Configured')).toBeVisible();

    // Switching to the Devices panel refreshes it against the now-configured
    // server (renderDevicesSettings()'s window._refreshDevicesList hook).
    await settingsWindow.click('[data-section="devices"]');
    await settingsWindow.waitForSelector('#section-devices.active');

    // --- list renders ---
    const laptopCard = settingsWindow.locator('[data-device-id="dev-laptop"]');
    const phoneCard = settingsWindow.locator('[data-device-id="dev-phone"]');
    await expect(laptopCard).toBeVisible();
    await expect(phoneCard).toBeVisible();
    await expect(laptopCard).toContainText('Laptop');
    // The laptop is the device whose key this install is using — the server
    // says so (`current`), and the panel names it instead of "Active".
    await expect(laptopCard).toContainText('This device');
    await expect(laptopCard).toHaveAttribute('data-current', 'true');
    await expect(phoneCard).toContainText('Phone');
    await expect(phoneCard).toContainText('Active');
    await expect(phoneCard).toContainText('never'); // last_seen_at: null

    // The <peek-card>/<peek-input>/<peek-button> custom elements actually
    // upgraded (shadow root attached) — proves the inline importmap (allowed
    // by its CSP hash) + settings-components.js resolved under the page's
    // `script-src 'self'` CSP, not just that light-DOM text survived.
    await expect
      .poll(() => laptopCard.evaluate((el) => !!(el as unknown as { shadowRoot: unknown }).shadowRoot))
      .toBe(true);

    // --- mint an enrolment code ---
    // The "add a device" card mints a single-use enrolment code via its
    // "Create code" button (api.sync.createEnrolmentCode()) and shows it
    // with its expiry.
    await expect(settingsWindow.locator('.devices-panel')).toContainText('Add a device');
    await settingsWindow.locator('[data-role="add-device-button"]').click();
    const codeDisplay = settingsWindow.locator('[data-role="enrolment-code-display"]');
    await expect(codeDisplay).toBeVisible();
    await expect(codeDisplay).toContainText(STUB_CODE);
    await expect(codeDisplay).toContainText('expires');

    // --- rename ---
    const renameInput = laptopCard.locator('[data-role="rename-input"]');
    await renameInput.evaluate((el: any, value: string) => { el.value = value; }, 'Work Laptop');
    await laptopCard.locator('[data-role="rename-button"]').click();
    await expect(laptopCard).toContainText('Work Laptop');
    expect(devices.find((d) => d.id === 'dev-laptop')?.label).toBe('Work Laptop');

    // --- revoke removes access ---
    settingsWindow.once('dialog', (dialog) => dialog.accept());
    await phoneCard.locator('[data-role="revoke-button"]').click();
    await expect(settingsWindow.locator('[data-device-id="dev-phone"][data-revoked="true"]')).toBeVisible();
    await expect(phoneCard).toContainText('Revoked');
    // Revoked devices lose their rename/revoke controls — nothing left to act on.
    await expect(phoneCard.locator('[data-role="revoke-button"]')).toHaveCount(0);
    expect(devices.find((d) => d.id === 'dev-phone')?.revoked_at).toBeTruthy();

    // --- revoking this very device disconnects it, and says so ---
    // The server allows it and answers `current: true`; the main process
    // drops the now-dead key, the panel explains instead of reloading into a
    // 401, and the Sync panel's API Key field no longer shows the dead key.
    let selfRevokePrompt = '';
    settingsWindow.once('dialog', (dialog) => {
      selfRevokePrompt = dialog.message();
      dialog.accept();
    });
    await laptopCard.locator('[data-role="revoke-button"]').click();
    await expect(settingsWindow.locator('.devices-panel-status')).toContainText("This device's key was revoked");
    // The confirm names the consequence rather than reading like any other revoke.
    expect(selfRevokePrompt).toContain('the device you are using right now');
    await expect(settingsWindow.locator('[data-device-id]')).toHaveCount(0);
    expect(devices.find((d) => d.id === 'dev-laptop')?.revoked_at).toBeTruthy();

    await settingsWindow.click('[data-section="sync"]');
    await settingsWindow.waitForSelector('#section-sync.active');
    await expect(apiKeyInput).toHaveValue('');
    await expect(syncSection.getByText('Status: Not configured')).toBeVisible();

    // --- enrol with the code, from the Sync panel ---
    // Trades the code minted above for this install's own key (api.sync.enrol
    // → POST /enrol), stored exactly where a pasted key goes.
    const enrolLabelInput = syncSection.locator('[data-role="enrol-label-input"]');
    await enrolLabelInput.evaluate((el: any, value: string) => { el.value = value; }, 'Re-enrolled laptop');
    const enrolCodeInput = syncSection.locator('[data-role="enrol-code-input"]');
    await enrolCodeInput.evaluate((el: any, value: string) => { el.value = value; }, STUB_CODE);
    await syncSection.locator('[data-role="enrol-button"]').click();
    await expect(syncSection.locator('[data-role="enrol-status"]')).toContainText('now has its own key');
    await expect(apiKeyInput).toHaveValue(ENROLLED_KEY);
    await expect(syncSection.getByText('Status: Configured')).toBeVisible();
    expect(devices.find((d) => d.id === 'dev-new')?.label).toBe('Re-enrolled laptop');

    // --- the Devices panel works again on the new key ---
    await settingsWindow.click('[data-section="devices"]');
    await settingsWindow.waitForSelector('#section-devices.active');
    const newCard = settingsWindow.locator('[data-device-id="dev-new"]');
    await expect(newCard).toBeVisible();
    await expect(newCard).toContainText('Re-enrolled laptop');
    await expect(newCard).toContainText('This device');
    await expect(settingsWindow.locator('[data-device-id="dev-laptop"]')).toContainText('Revoked');
  });

  test('retrying a self-revoke on an already-revoked device still clears the local key', async () => {
    const settingsWindow = await app.getWindow('settings/settings.html');
    await settingsWindow.waitForSelector('.settings-layout', { timeout: 5000 });

    // Point this device at dev-tablet, which the stub always answers a
    // revoke for as `{revoked:false, current:true}` — see
    // ALREADY_REVOKED_ON_SERVER above.
    await settingsWindow.click('[data-section="sync"]');
    await settingsWindow.waitForSelector('#section-sync.active');
    const syncSection = settingsWindow.locator('#section-sync');
    const serverUrlInput = syncSection.locator('.form-group:has(label:text-is("Server URL")) input');
    await serverUrlInput.fill(serverUrl);
    await serverUrlInput.press('Tab');
    const apiKeyInput = syncSection.locator('.form-group:has(label:text-is("API Key")) input');
    await apiKeyInput.fill(ALREADY_REVOKED_KEY);
    await apiKeyInput.press('Tab');
    await expect(syncSection.getByText('Status: Configured')).toBeVisible();

    await settingsWindow.click('[data-section="devices"]');
    await settingsWindow.waitForSelector('#section-devices.active');
    const tabletCard = settingsWindow.locator('[data-device-id="dev-tablet"]');
    await expect(tabletCard).toBeVisible();
    await expect(tabletCard).toContainText('This device');

    // The DELETE response carries `revoked:false` (someone/something else
    // already revoked it) but `current:true` — tile-ipc.ts's revoke-device
    // handler must still drop the local key on `current` alone.
    settingsWindow.once('dialog', (dialog) => dialog.accept());
    await tabletCard.locator('[data-role="revoke-button"]').click();
    await expect(settingsWindow.locator('.devices-panel-status')).toContainText("This device's key was revoked");

    await settingsWindow.click('[data-section="sync"]');
    await settingsWindow.waitForSelector('#section-sync.active');
    await expect(apiKeyInput).toHaveValue('');
    await expect(syncSection.getByText('Status: Not configured')).toBeVisible();
  });
});
