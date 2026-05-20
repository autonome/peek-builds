/**
 * observeUrl — open a page-host window pointing at `url` and capture what
 * happens: console output, the load-error overlay (if any), and the
 * webview's settled state.
 *
 * Lightweight wrapper around the boilerplate that one-off repro specs keep
 * re-writing: app.window.open → wait for the page window → attach console
 * listener → poll for overlay or timeout → snapshot state.
 *
 * Usage:
 *
 *   const { app, bgWindow } = await createPerDescribeApp('repro');
 *   const obs = await observeUrl(app, bgWindow, 'https://example.com/');
 *   console.log(obs.overlay, obs.webviewState);
 *   console.log(obs.consoleLines.slice(-50).join('\n'));
 *   await obs.close();
 */

import { Page } from '@playwright/test';
import { DesktopApp } from '../fixtures/desktop-app';

export interface ObserveUrlOptions {
  /** Window dimensions. Defaults to 1200x900. */
  width?: number;
  height?: number;
  /** How long to wait for overlay/settle, in ms. Defaults to 35000 (past the page-host's 30s loading-timeout). */
  observeMs?: number;
  /** Pre-set on the page window via `window.__loadingTimeoutMs` to shorten the page-host's safety-net for tests. */
  loadingTimeoutMs?: number;
}

export interface OverlaySnapshot {
  urlText: string;
  reasonText: string;
}

export interface WebviewSnapshot {
  classes: string;
  url: string;
  isLoading: boolean | null;
}

export interface ObserveUrlResult {
  /** The page-host window. */
  pageWindow: Page;
  /** Window id returned by app.window.open — useful for closing via api.window.close. */
  windowId: number;
  /** The load-error overlay, if one was visible at observation end. */
  overlay: OverlaySnapshot | null;
  /** Webview state at observation end. */
  webviewState: WebviewSnapshot;
  /** Every page-host console message captured during the observation window, in order. */
  consoleLines: string[];
  /** Close the observed window via api.window.close. */
  close: () => Promise<void>;
}

export async function observeUrl(
  app: DesktopApp,
  bgWindow: Page,
  url: string,
  options: ObserveUrlOptions = {},
): Promise<ObserveUrlResult> {
  const {
    width = 1200,
    height = 900,
    observeMs = 35000,
    loadingTimeoutMs,
  } = options;

  const result = await bgWindow.evaluate(
    async ({ targetUrl, w, h }: { targetUrl: string; w: number; h: number }) => {
      return await (window as any).app.window.open(targetUrl, { width: w, height: h });
    },
    { targetUrl: url, w: width, h: height },
  );
  if (!result?.success) {
    throw new Error(`observeUrl: app.window.open failed for ${url}: ${JSON.stringify(result)}`);
  }
  const windowId: number = result.id;

  // Wait for the page-host window. It wraps the target URL in its own URL
  // (peek://app/page/index.html?url=...), so match on the encoded prefix.
  const findDeadline = Date.now() + 15000;
  let pageWindow: Page | undefined;
  while (Date.now() < findDeadline) {
    for (const w of app.windows()) {
      const wUrl = w.url();
      if (
        wUrl.includes('page/index.html') &&
        wUrl.includes(encodeURIComponent(url).slice(0, 32))
      ) {
        pageWindow = w;
        break;
      }
    }
    if (pageWindow) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!pageWindow) {
    throw new Error(`observeUrl: page window for ${url} did not appear within 15s`);
  }

  if (loadingTimeoutMs != null) {
    await pageWindow.evaluate((ms: number) => {
      (window as any).__loadingTimeoutMs = ms;
    }, loadingTimeoutMs);
  }

  const consoleLines: string[] = [];
  pageWindow.on('console', (msg) => {
    consoleLines.push(`[${msg.type()}] ${msg.text()}`);
  });
  pageWindow.on('pageerror', (err) => {
    consoleLines.push(`[pageerror] ${err.message}`);
  });

  const obsDeadline = Date.now() + observeMs;
  let overlay: OverlaySnapshot | null = null;
  while (Date.now() < obsDeadline) {
    overlay = await pageWindow.evaluate(() => {
      const el = document.querySelector('.load-error-overlay');
      if (!el) return null;
      return {
        urlText: el.querySelector('.load-error-url')?.textContent || '',
        reasonText: el.querySelector('.load-error-reason')?.textContent || '',
      };
    });
    if (overlay) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  const webviewState: WebviewSnapshot = await pageWindow.evaluate(() => {
    const wv = document.getElementById('content') as any;
    return {
      classes: wv?.className || '',
      url: wv?.getURL?.() || '',
      isLoading: wv?.isLoading?.() ?? null,
    };
  });

  return {
    pageWindow,
    windowId,
    overlay,
    webviewState,
    consoleLines,
    close: async () => {
      await bgWindow.evaluate(async (id: number) => {
        return await (window as any).app.window.close(id);
      }, windowId);
    },
  };
}
