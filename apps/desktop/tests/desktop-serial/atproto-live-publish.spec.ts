/**
 * LIVE end-to-end check against a real PDS (network, throwaway account).
 *
 * Opt-in only: runs when PEEK_LIVE_ATPROTO=1 AND the credentials file exists.
 * The normal gate never reaches the network.
 *
 *   PEEK_LIVE_ATPROTO=1 HEADLESS=1 BACKEND=electron ./scripts/playwright-with-display.sh test \
 *     --config apps/desktop/playwright.config.ts \
 *     --project=desktop-serial --workers=1 --grep 'live atproto' --trace=off
 *
 * Steps (each logs `[live] step N ok/failed: <reason>`):
 *   1. boot on an isolated profile, open the Lex home window
 *   2. log in through the real OAuth flow (loopback redirect + auth window)
 *   3. window.app.atproto.sessionInfo() reports the signed-in account
 *   4. publish the built-in hello-world feature through the features-manager wizard
 *   5. read the published record back over plain HTTP
 *   6. install it back through tile:features:install (signature + CID checks)
 *
 * The account password is read from the env file only inside this process,
 * is typed into the auth page via a page.evaluate argument, and is never
 * logged. Screenshots/traces are disabled for this spec.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, DesktopApp } from '../fixtures/desktop-app';
import { Page } from '@playwright/test';
import { createPerDescribeApp } from '../helpers/test-app';

const ENV_FILE = path.join(os.homedir(), '.config', 'peek', 'test-atproto.env');
const LIVE = process.env.PEEK_LIVE_ATPROTO === '1' && fs.existsSync(ENV_FILE);

const HANDLE = 'peek-test.mu.social';
const DID = 'did:plc:bubrzn5su3ofhndsjsi27and';
const PDS = 'https://eurosky.social';
const COLLECTION = 'space.peek.feature.release';

const INTERESTING = /Failed to upload|refresh token|Host not allowed|atproto-proxy|\[atproto|\[lex\]|DPoP/i;

function step(n: number, ok: boolean, reason: string): void {
  process.stdout.write(`[live] step ${n} ${ok ? 'ok' : 'failed'}: ${reason}\n`);
}

/** Describe the form controls of a page without ever reading their values. */
async function describeControls(page: Page): Promise<string> {
  return page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll('input, button, a[role=button], [role=button], form').forEach((el) => {
      const e = el as HTMLElement & { type?: string; name?: string };
      const label = (e.innerText || '').trim().slice(0, 40).replace(/\s+/g, ' ');
      out.push(`${el.tagName.toLowerCase()}[type=${e.type || ''} name=${e.name || ''} id=${e.id || ''}]${label ? ' "' + label + '"' : ''}`);
    });
    return out.join('\n');
  });
}

async function pageText(page: Page): Promise<string> {
  try {
    return (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 400);
  } catch {
    return '<unreadable>';
  }
}

test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test.describe('live atproto login, publish, install @live', () => {
  test.skip(!LIVE, 'set PEEK_LIVE_ATPROTO=1 and provide ~/.config/peek/test-atproto.env');
  test.setTimeout(300_000);

  let app: DesktopApp;
  let bgWindow: Page;
  const rendererLines: string[] = [];
  const attached = new WeakSet<Page>();

  function watch(page: Page, tag: string): void {
    if (attached.has(page)) return;
    attached.add(page);
    page.on('console', (m) => {
      const t = m.text();
      if (INTERESTING.test(t)) {
        const line = `${tag}: ${t.slice(0, 300)}`;
        rendererLines.push(line);
        process.stdout.write(`[live] console ${line}\n`);
      }
    });
    page.on('pageerror', (e) => {
      const line = `${tag}: pageerror ${String(e.message).slice(0, 300)}`;
      rendererLines.push(line);
      process.stdout.write(`[live] console ${line}\n`);
    });
  }

  test.beforeAll(async () => {
    ({ app, bgWindow } = await createPerDescribeApp('live-atproto'));
    watch(bgWindow, 'test-fixture');
    // Capture main-process console output matching the interesting patterns.
    await app.evaluateMain!((_e, src: string) => {
      const re = new RegExp(src, 'i');
      const g = globalThis as unknown as { __liveLog?: string[] };
      g.__liveLog = [];
      for (const level of ['log', 'warn', 'error'] as const) {
        const orig = console[level].bind(console);
        console[level] = (...args: unknown[]) => {
          try {
            const s = args.map((a) => (typeof a === 'string' ? a : (a instanceof Error ? a.message : JSON.stringify(a)))).join(' ');
            if (re.test(s)) g.__liveLog!.push(`${level}: ${s.slice(0, 300)}`);
          } catch { /* ignore */ }
          orig(...(args as []));
        };
      }
    }, INTERESTING.source);
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  async function mainLog(): Promise<string[]> {
    return app.evaluateMain!(() => ((globalThis as unknown as { __liveLog?: string[] }).__liveLog || []).slice());
  }

  test('login, publish hello-world, read back, install back', async () => {
    const password = fs.readFileSync(ENV_FILE, 'utf-8').trim();
    expect(password.length).toBeGreaterThan(0);

    // ── Step 1: Lex home window ───────────────────────────────────────
    let lex: Page;
    try {
      await bgWindow.evaluate(async () => {
        await (window as any).app.window.open('peek://lex/home.html', {
          role: 'workspace', key: 'lex-home', width: 860, height: 620, title: 'Lexicon Studio',
        });
      });
      lex = await app.getWindow(/peek:\/\/lex\/home\.html/, 20000);
      watch(lex, 'lex');
      await lex.locator('#handle-input input').waitFor({ timeout: 15000 });
      step(1, true, 'lex home window open, handle field present');
    } catch (err) {
      step(1, false, (err as Error).message.split('\n')[0]);
      throw err;
    }

    // ── Step 2: OAuth login via auth window ──────────────────────────
    let authPage: Page;
    try {
      // The public typeahead does not index accounts on other PDSes, so the
      // handle is typed in full and submitted with Enter, as a user would.
      await lex.locator('#handle-input input').click();
      await lex.keyboard.type(HANDLE, { delay: 20 });
      await lex.keyboard.press('Enter');

      authPage = await app.getWindow(/^https?:\/\//, 30000);
      watch(authPage, 'auth');
      await authPage.waitForLoadState('domcontentloaded');
      process.stdout.write(`[live] auth page host: ${new URL(authPage.url()).host}\n`);
      process.stdout.write(`[live] auth page controls:\n${await describeControls(authPage)}\n`);
      process.stdout.write(`[live] auth page text: ${await pageText(authPage)}\n`);

      // Fill the password (and identifier if the page asks for it) without
      // putting the secret in any API call that the reporter would echo.
      const pwInput = authPage.locator('input[type=password]').first();
      await pwInput.waitFor({ timeout: 30000 });
      const ident = authPage.locator('input[name=username], input[name=identifier], input[type=email], input[autocomplete=username]').first();
      if (await ident.count()) {
        const cur = await ident.inputValue().catch(() => '');
        if (!cur) await ident.fill(HANDLE);
      }
      await authPage.evaluate((pw: string) => {
        const el = document.querySelector('input[type=password]') as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        el.focus();
        setter.call(el, pw);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, password);

      const submit = authPage.getByRole('button', { name: /sign in|log in|login|next|continue/i }).first();
      await submit.click();

      // Consent screen (if any), then the window closes after the callback.
      for (let i = 0; i < 40; i++) {
        if (authPage.isClosed()) break;
        await new Promise((r) => setTimeout(r, 1000));
        if (authPage.isClosed()) break;
        const txt = await pageText(authPage);
        if (i === 0 || i % 5 === 0) process.stdout.write(`[live] auth page text: ${txt}\n`);
        if (/captcha|verify|verification|code|two-factor|2fa|confirm your email/i.test(txt) && !/authorize|accept|allow/i.test(txt)) {
          process.stdout.write(`[live] auth page needs a human step; controls:\n${await describeControls(authPage)}\n`);
        }
        const accept = authPage.getByRole('button', { name: /^(authorize|accept|allow|approve|grant)/i }).first();
        if (await accept.count().catch(() => 0)) {
          await accept.click().catch(() => {});
        }
      }
      step(2, true, 'auth window driven to completion');
    } catch (err) {
      step(2, false, (err as Error).message.split('\n')[0]);
      throw err;
    }

    // ── Step 3: session stored ────────────────────────────────────────
    try {
      let info: any = null;
      for (let i = 0; i < 30; i++) {
        info = await lex.evaluate(async () => await (window as any).app.atproto.sessionInfo());
        if (info && info.signedIn) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      process.stdout.write(`[live] sessionInfo: ${JSON.stringify({ signedIn: info?.signedIn, handle: info?.handle, did: info?.did, pdsUrl: info?.pdsUrl })}\n`);
      expect(info.signedIn).toBe(true);
      expect(info.handle).toBe(HANDLE);
      step(3, true, `signedIn handle=${info.handle} pdsUrl=${info.pdsUrl}`);
    } catch (err) {
      const errTxt = await lex.locator('#login-error').innerText().catch(() => '');
      step(3, false, `${(err as Error).message.split('\n')[0]} loginError="${errTxt}"`);
      throw err;
    }

    // ── Step 4: publish hello-world via the wizard ───────────────────
    let recordUri = '';
    try {
      await bgWindow.evaluate(async () => {
        // The wizard's own host, not the legacy shared `peek://ext/` form: a
        // shared host carries no tile identity, so a page on it is never
        // served the `atproto` protocol module the wizard now imports.
        await (window as any).app.window.open('peek://features-manager/publish.html', {
          role: 'workspace', key: 'live-publish', width: 900, height: 700, title: 'Publish',
        });
      });
      const pub = await app.getWindow(/features-manager\/publish\.html/, 20000);
      watch(pub, 'publish');

      const card = pub.locator('peek-card', { hasText: 'hello-world' }).first();
      const anyCard = pub.locator('peek-card').first();
      await anyCard.waitFor({ timeout: 20000 });
      const names = await pub.locator('.feature-name').allInnerTexts();
      process.stdout.write(`[live] publish page features: ${JSON.stringify(names)}\n`);
      const target = (await card.count()) ? card : pub.locator('.feature-select-card', { hasText: /hello/i }).first();
      await target.click();
      await pub.locator('#next-to-step-3').waitFor({ state: 'visible', timeout: 15000 });
      await pub.locator('#next-to-step-3').click();
      await pub.locator('#publish-btn').waitFor({ state: 'visible', timeout: 15000 });
      const pubHandle = await pub.locator('#pub-handle').innerText();
      process.stdout.write(`[live] publish page identity: ${pubHandle}\n`);
      await pub.locator('#publish-btn').click();

      const success = pub.locator('#publish-success');
      const failure = pub.locator('#publish-error');
      await expect.poll(
        async () => (await success.isVisible()) || (await failure.isVisible()),
        { timeout: 120000, message: 'publish never finished' },
      ).toBe(true);
      if (await failure.isVisible()) {
        const msg = await pub.locator('#error-message').innerText();
        throw new Error(`publish error: ${msg}`);
      }
      recordUri = await pub.evaluate(() => (document.getElementById('success-uri') as any).value as string);
      step(4, true, `published ${recordUri}`);
    } catch (err) {
      step(4, false, (err as Error).message.split('\n')[0]);
      process.stdout.write(`[live] renderer lines: ${JSON.stringify(rendererLines)}\n`);
      process.stdout.write(`[live] main lines: ${JSON.stringify(await mainLog())}\n`);
      throw err;
    }
    process.stdout.write(`[live] main lines after publish: ${JSON.stringify(await mainLog())}\n`);

    // ── Step 5: read back over HTTP ──────────────────────────────────
    let readBack: any;
    try {
      const url = `${PDS}/xrpc/com.atproto.repo.listRecords?repo=${DID}&collection=${COLLECTION}`;
      const res = await fetch(url);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      readBack = (body.records || []).find((r: any) => r.uri === recordUri) ||
        (body.records || []).find((r: any) => r.value?.featureId === 'hello-world');
      expect(readBack, 'record for hello-world in listRecords').toBeTruthy();
      expect(readBack.value.featureId).toBe('hello-world');
      step(5, true, `listRecords ${res.status}, ${body.records.length} record(s), uri=${readBack.uri}`);
    } catch (err) {
      step(5, false, (err as Error).message.split('\n')[0]);
      throw err;
    }

    // ── Step 6: install back through tile:features:install ────────────
    try {
      const res = await bgWindow.evaluate(
        async (u: string) => await (window as any).app.features.install(u, true),
        readBack.uri,
      );
      process.stdout.write(`[live] install result: ${JSON.stringify({ success: res.success, error: res.error, entry: res.entry && { id: res.entry.id, source: res.entry.source?.type } })}\n`);
      expect(res.error, `install error: ${res.error}`).toBeUndefined();
      expect(res.success).toBe(true);
      step(6, true, 'install passed signature verification and bundle CID checks');
    } catch (err) {
      step(6, false, (err as Error).message.split('\n')[0]);
      process.stdout.write(`[live] main lines: ${JSON.stringify(await mainLog())}\n`);
      throw err;
    }
  });
});
