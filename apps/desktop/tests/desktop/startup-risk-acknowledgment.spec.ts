/**
 * Startup risk acknowledgment: the notice shown before the normal runtime.
 *
 * Every test starts from a fresh, unseeded user-data root inside the OS temp
 * directory (never a real installation) and launches through launchStartupGate,
 * which does not wait for the runtime.
 */
import { test, expect, launchStartupGate } from '../fixtures/desktop-app';
import type { ElectronApplication, Page } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NOTICE,
  consentRecordPath,
  createAcceptanceRecord,
  isValidAcceptanceRecord,
} from '../../main/startup-consent';

test.describe.configure({ mode: 'serial' });

interface Gate {
  app: ElectronApplication;
  root: string;
  profile: string;
}

const roots: string[] = [];
const apps: ElectronApplication[] = [];
let counter = 0;

function freshRoot(): { root: string; profile: string } {
  const profile = `startup-ack-${process.pid}-${Date.now()}-${counter++}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-test-startup-ack-'));
  roots.push(root);
  return { root, profile };
}

async function start(prepare?: (root: string) => void, extraArgs: string[] = []): Promise<Gate> {
  const { root, profile } = freshRoot();
  prepare?.(root);
  const { app } = await launchStartupGate(profile, { userDataRoot: root, extraArgs });
  apps.push(app);
  return { app, root, profile };
}

function exited(app: ElectronApplication): Promise<number | null> {
  const child = app.process();
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise(resolve => child.once('exit', code => resolve(code)));
}

async function noticePage(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow();
  await page.locator('#continue').waitFor();
  return page;
}

function killLaunchesUnder(root: string): void {
  try {
    execFileSync('pkill', ['-f', root]);
  } catch {
    // Nothing matched.
  }
}

test.afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close().catch(() => undefined);
  }
  for (const root of roots.splice(0)) {
    killLaunchesUnder(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.describe('startup risk acknowledgment', () => {
  test('startup risk acknowledgment: only the notice appears, with the exact wording and unchecked boxes', async () => {
    const { app, root, profile } = await start();
    const page = await noticePage(app);
    expect(app.windows()).toHaveLength(1);
    expect(page.url().startsWith('file://')).toBe(true);
    await expect(page.locator('h1')).toHaveText(NOTICE.title);
    const paragraphs = await page.locator('main p:not(#error):not(#fallback)').allTextContents();
    expect(paragraphs).toEqual([...NOTICE.paragraphs]);
    const labels = await page.locator('.ack label').allTextContents();
    expect(labels).toEqual([...NOTICE.acknowledgments]);
    for (let i = 0; i < 3; i++) await expect(page.locator(`#ack-${i}`)).not.toBeChecked();
    await expect(page.locator('#quit')).toHaveText(NOTICE.quit);
    await expect(page.locator('#continue')).toHaveText(NOTICE.continue);
    await expect(page.locator('#continue')).toBeDisabled();
    // Nothing from the runtime exists: no profile directory, no record.
    expect(fs.existsSync(path.join(root, profile))).toBe(false);
    expect(fs.existsSync(consentRecordPath(root))).toBe(false);
  });

  test('startup risk acknowledgment: any missing checkbox keeps Continue disabled', async () => {
    const { app, root } = await start();
    const page = await noticePage(app);
    for (let bits = 0; bits < 7; bits++) {
      for (let i = 0; i < 3; i++) {
        const box = page.locator(`#ack-${i}`);
        if ((bits & (1 << i)) !== 0) await box.check(); else await box.uncheck();
      }
      await expect(page.locator('#continue')).toBeDisabled();
    }
    for (let i = 0; i < 3; i++) await page.locator(`#ack-${i}`).check();
    await expect(page.locator('#continue')).toBeEnabled();
    await page.locator('#ack-1').uncheck();
    await expect(page.locator('#continue')).toBeDisabled();
    expect(fs.existsSync(consentRecordPath(root))).toBe(false);
  });

  test('startup risk acknowledgment: Enter does not accept, even with every box checked', async () => {
    const { app, root } = await start();
    const page = await noticePage(app);
    await page.keyboard.press('Enter');
    for (let i = 0; i < 3; i++) await page.locator(`#ack-${i}`).check();
    await page.locator('#ack-2').focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    expect(app.process().exitCode).toBeNull();
    expect(fs.existsSync(consentRecordPath(root))).toBe(false);
    expect(app.windows()).toHaveLength(1);
  });

  test('startup risk acknowledgment: Escape declines, exits and records nothing', async () => {
    const { app, root, profile } = await start();
    const page = await noticePage(app);
    const done = exited(app);
    // The page may already be gone when the key press resolves.
    await page.keyboard.press('Escape').catch(() => undefined);
    expect(await done).toBe(0);
    expect(fs.existsSync(consentRecordPath(root))).toBe(false);
    expect(fs.existsSync(path.join(root, profile))).toBe(false);
  });

  test('startup risk acknowledgment: Quit declines, exits and records nothing', async () => {
    const { app, root, profile } = await start();
    const page = await noticePage(app);
    for (let i = 0; i < 3; i++) await page.locator(`#ack-${i}`).check();
    const done = exited(app);
    await page.locator('#quit').click().catch(() => undefined);
    expect(await done).toBe(0);
    expect(fs.existsSync(consentRecordPath(root))).toBe(false);
    expect(fs.existsSync(path.join(root, profile))).toBe(false);
  });

  test('startup risk acknowledgment: closing the window declines and records nothing', async () => {
    const { app, root } = await start();
    const page = await noticePage(app);
    const done = exited(app);
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
    expect(await done).toBe(0);
    expect(page.isClosed()).toBe(true);
    expect(fs.existsSync(consentRecordPath(root))).toBe(false);
  });

  test('startup risk acknowledgment: a second launch with a URL opens nothing and leaves the notice up', async () => {
    const { app, root, profile } = await start();
    await noticePage(app);
    const argv = await app.evaluate(() => process.argv);
    const execPath = await app.evaluate(() => process.execPath);
    const args = argv.slice(1).filter(arg => !arg.startsWith('--inspect') && !arg.startsWith('--remote-debugging'));
    const second = spawn(execPath, [...args, 'https://example.com/second-launch'], { stdio: 'ignore' });
    const secondExit = await new Promise<number | null>(resolve => second.once('exit', code => resolve(code)));
    expect(secondExit).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(app.process().exitCode).toBeNull();
    expect(app.windows()).toHaveLength(1);
    expect(app.windows()[0].url().startsWith('file://')).toBe(true);
    const count = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    expect(count).toBe(1);
    expect(fs.existsSync(path.join(root, profile))).toBe(false);
    expect(fs.existsSync(consentRecordPath(root))).toBe(false);
  });

  test('startup risk acknowledgment: OS activation does not dismiss the notice', async () => {
    const { app, root } = await start();
    await noticePage(app);
    await app.evaluate(({ app: electronApp }) => { electronApp.emit('activate'); });
    await new Promise(resolve => setTimeout(resolve, 300));
    const count = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    expect(count).toBe(1);
    expect(app.process().exitCode).toBeNull();
    expect(fs.existsSync(consentRecordPath(root))).toBe(false);
  });

  test('startup risk acknowledgment: a corrupt or outdated record prompts again', async () => {
    const cases: Array<(root: string) => void> = [
      root => fs.writeFileSync(consentRecordPath(root), '{"schemaVersion":1,'),
      root => fs.writeFileSync(consentRecordPath(root), JSON.stringify({ ...createAcceptanceRecord('old'), noticeVersion: 0 })),
      root => fs.writeFileSync(consentRecordPath(root), JSON.stringify({ ...createAcceptanceRecord('old'), noticeHash: 'old-text' })),
    ];
    for (const prepare of cases) {
      const { app } = await start(root => { fs.mkdirSync(root, { recursive: true }); prepare(root); });
      const page = await noticePage(app);
      await expect(page.locator('h1')).toHaveText(NOTICE.title);
      await app.close();
    }
  });

  test('startup risk acknowledgment: a save failure is explained, offers retry, and starts nothing', async () => {
    const { app, root, profile } = await start(prepared => {
      // A directory in the record's place makes the atomic replacement fail.
      fs.mkdirSync(path.join(prepared, 'startup-risk-acknowledgment.json', 'blocker'), { recursive: true });
    });
    const page = await noticePage(app);
    for (let i = 0; i < 3; i++) await page.locator(`#ack-${i}`).check();
    await page.locator('#continue').click();
    await expect(page.locator('#error')).toContainText('could not be saved');
    expect(app.process().exitCode).toBeNull();
    expect(fs.existsSync(path.join(root, profile))).toBe(false);
    await expect(page.locator('#quit')).toBeVisible();
    await expect(page.locator('#continue')).toBeEnabled();
  });

  test('startup risk acknowledgment: acceptance records once, starts the app, and a matching record skips the notice', async () => {
    test.setTimeout(120_000);
    const { app, root, profile } = await start();
    const page = await noticePage(app);
    for (let i = 0; i < 3; i++) await page.locator(`#ack-${i}`).check();
    const done = exited(app);
    await page.locator('#continue').click().catch(() => undefined);
    expect(await done).toBe(0);

    const record = JSON.parse(fs.readFileSync(consentRecordPath(root), 'utf8'));
    expect(isValidAcceptanceRecord(record)).toBe(true);
    expect(fs.readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([]);

    // The restarted process runs the normal runtime for the same profile.
    const mainLog = path.join(root, profile, 'logs', 'main.log');
    await expect.poll(() => fs.existsSync(mainLog), { timeout: 60_000 }).toBe(true);
    killLaunchesUnder(root);

    // A launch with the record present goes straight to the runtime.
    const { app: again } = await launchStartupGate(profile, { userDataRoot: root });
    apps.push(again);
    await expect.poll(async () => {
      const urls = again.windows().map(w => w.url());
      return urls.some(url => url.startsWith('peek://'));
    }, { timeout: 60_000 }).toBe(true);
    const titles = await Promise.all(again.windows().map(w => w.title().catch(() => '')));
    expect(titles).not.toContain(NOTICE.title);
  });

  test('startup risk acknowledgment: the notice assets are present in the build under test', async () => {
    const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    for (const rel of [
      'renderer/startup-consent/index.html',
      'renderer/startup-consent/notice.js',
      'renderer/startup-consent/notice.css',
      'dist/main/startup-consent-preload.cjs',
      'dist/main/startup-consent-electron.js',
    ]) {
      expect(fs.existsSync(path.join(desktopDir, rel)), rel).toBe(true);
    }
  });
});
