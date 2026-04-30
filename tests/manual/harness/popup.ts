/**
 * Discover and open a chrome-extension popup window in the running app.
 *
 * Pattern lifted verbatim from tests/desktop/proton-pass-permissions.spec.ts:
 *   bgWindow → app.chromeExtensions.getUiEntries()
 *           → window.app.window.open(popupUrl, ...)
 *           → app.getWindow('popup.html')
 */

import { Page } from '@playwright/test';
import { DesktopApp } from '../../fixtures/desktop-app';

export interface UiEntry {
  extensionId: string;
  extensionName: string;
  type: string; // 'popup' | 'options' | ...
  url: string;
}

export async function listUiEntries(bgWindow: Page): Promise<UiEntry[]> {
  return bgWindow.evaluate(async () => {
    const r = await (window as any).app.chromeExtensions.getUiEntries();
    return r.data as UiEntry[];
  });
}

export async function discoverPopup(
  app: DesktopApp,
  bgWindow: Page,
  extensionNameSubstring: string,
  opts: { width?: number; height?: number; key?: string; timeout?: number } = {},
): Promise<{ popup: Page; entry: UiEntry }> {
  const entries = await listUiEntries(bgWindow);
  const needle = extensionNameSubstring.toLowerCase();
  const entry = entries.find((e) => e.type === 'popup' && e.extensionName.toLowerCase().includes(needle));
  if (!entry) {
    const known = entries.filter((e) => e.type === 'popup').map((e) => e.extensionName).join(', ');
    throw new Error(
      `[harness] popup for extension matching "${extensionNameSubstring}" not found. ` +
      `Known popup extensions: ${known || '<none>'}.`,
    );
  }

  const openResult = await bgWindow.evaluate(
    async (args: { url: string; width: number; height: number; key: string }) => {
      return await (window as any).app.window.open(args.url, {
        width: args.width, height: args.height, key: args.key,
      });
    },
    {
      url: entry.url,
      width: opts.width ?? 400,
      height: opts.height ?? 600,
      key: opts.key ?? `harness-${entry.extensionId}-popup`,
    },
  );
  if (!(openResult as any)?.success) {
    throw new Error(`[harness] window.open failed for popup ${entry.url}: ${JSON.stringify(openResult)}`);
  }

  const popup = await app.getWindow('popup.html', opts.timeout ?? 15000);
  return { popup, entry };
}
