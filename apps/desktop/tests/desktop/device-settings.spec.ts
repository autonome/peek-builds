import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

// Exercises the Settings > Devices panel (renderDevicesSettings() in
// apps/desktop/renderer/settings/settings.js) against a stub HTTP server
// standing in for the sync server's account-holder /devices routes
// (apps/server/index.js GET/PATCH/DELETE /devices). The panel is driven
// through the real api.sync.{getConfig,setConfig,listDevices,renameDevice,
// revokeDevice} IPC surface — no server process, no sync.ts unit-test-style
// in-process fetch stub, since this is the renderer UI, not sync.ts itself.

interface StubDevice {
  id: string;
  label: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

/** A minimal in-memory /devices server: GET list, PATCH rename, DELETE revoke. */
function startDeviceStubServer(devices: StubDevice[]): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://stub.invalid');
      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'GET' && url.pathname === '/devices') {
        res.end(JSON.stringify({ devices }));
        return;
      }

      const deviceMatch = url.pathname.match(/^\/devices\/([^/]+)$/);
      if (req.method === 'PATCH' && deviceMatch) {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          const device = devices.find((d) => d.id === deviceMatch[1]);
          if (!device) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'not found' }));
            return;
          }
          const parsed = body ? JSON.parse(body) : {};
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
        device.revoked_at = new Date().toISOString();
        res.end(JSON.stringify({ revoked: true }));
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
    ];
    ({ server, url: serverUrl } = await startDeviceStubServer(devices));
  });

  test.afterAll(async () => {
    if (app) await app.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('lists devices, renames one, and revoking removes access', async () => {
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
    await apiKeyInput.fill('stub-test-key');
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
    await expect(laptopCard).toContainText('Active');
    await expect(phoneCard).toContainText('Phone');
    await expect(phoneCard).toContainText('never'); // last_seen_at: null

    // The <peek-card>/<peek-input>/<peek-button> custom elements actually
    // upgraded (shadow root attached) — proves settings-importmap.json +
    // settings-components.js resolved under the page's strict
    // `script-src 'self'` CSP, not just that light-DOM text survived.
    await expect
      .poll(() => laptopCard.evaluate((el) => !!(el as unknown as { shadowRoot: unknown }).shadowRoot))
      .toBe(true);

    // The "add a device" card mints a single-use enrolment code via its one
    // "Create code" button (api.sync.createEnrolmentCode()).
    await expect(settingsWindow.locator('.devices-panel')).toContainText('Add a device');
    const addDeviceButtons = settingsWindow.locator('.devices-panel peek-card').first().locator('peek-button');
    await expect(addDeviceButtons).toHaveCount(1);

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
  });
});
