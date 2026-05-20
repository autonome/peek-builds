/**
 * Pure helpers for chrome-extension command registration and UI entry computation.
 *
 * Kept in a separate file (no electron imports) so they can be unit-tested
 * under plain node without needing the Electron runtime.
 */

// ─── Types (duplicated from chrome-extensions.ts to avoid cross-import) ──────
// Kept minimal — only the manifest fields actually read by computeUiEntries.

export interface UiEntryManifest {
  action?: { default_popup?: string; default_title?: string };
  browser_action?: { default_popup?: string; default_title?: string };
  options_ui?: { page: string };
  options_page?: string;
  background?: { page?: string; service_worker?: string; scripts?: string[] };
  chrome_url_overrides?: { newtab?: string; history?: string; bookmarks?: string };
  devtools_page?: string;
  side_panel?: { default_path?: string };
  sidebar_action?: { default_panel?: string; default_title?: string };
}

export interface UiEntryDiscovered {
  name: string;
  manifest: UiEntryManifest;
}

export interface UiEntryLoaded {
  extensionUrl: string; // chrome-extension://[id]/ base URL
}

export interface ComputedUiEntry {
  extensionId: string;
  extensionName: string;
  type: 'popup' | 'options' | 'background' | 'newtab' | 'history' | 'bookmarks' | 'devtools' | 'sidepanel';
  title: string;
  url: string;
  width: number;
  height: number;
  openable: boolean;
}

// ─── Pure computation ─────────────────────────────────────────────────────────

/**
 * Compute UI entry points for a set of loaded chrome extensions.
 *
 * Pure function — no module state. Takes plain maps so it can be called from
 * tests without an Electron session. `chrome-extensions.ts` calls this with
 * its module-level `loadedExtensions` / `discoveredExtensions` maps after
 * adapting the types.
 *
 * Returns entries only for extensions present in both `loaded` AND `discovered`.
 * An extension must be loaded (session.loadExtension succeeded) to contribute
 * entries — "enabled in DB but not yet loaded" contributes nothing, so the
 * caller must ensure loading is complete before rendering.
 */
export function computeUiEntries(
  loaded: Map<string, UiEntryLoaded>,
  discovered: Map<string, UiEntryDiscovered>,
): ComputedUiEntry[] {
  const entries: ComputedUiEntry[] = [];

  for (const [extId, loadedExt] of loaded) {
    const disc = discovered.get(extId);
    if (!disc) continue;

    const manifest = disc.manifest;
    const baseUrl = loadedExt.extensionUrl;

    // Action popup (action takes priority over browser_action for MV3)
    const popupPage = manifest.action?.default_popup || manifest.browser_action?.default_popup;
    if (popupPage) {
      entries.push({
        extensionId: extId, extensionName: disc.name, type: 'popup',
        title: manifest.action?.default_title || manifest.browser_action?.default_title || disc.name,
        url: `${baseUrl}${popupPage}`, width: 400, height: 500, openable: true,
      });
    }

    // Options page (options_ui takes priority over options_page)
    const optionsPage = manifest.options_ui?.page || manifest.options_page;
    if (optionsPage) {
      entries.push({
        extensionId: extId, extensionName: disc.name, type: 'options',
        title: `${disc.name} Settings`,
        url: `${baseUrl}${optionsPage}`, width: 1024, height: 768, openable: true,
      });
    }

    // Background page (service workers are not directly openable)
    const bgPage = manifest.background?.page;
    const bgWorker = manifest.background?.service_worker;
    const bgScripts = manifest.background?.scripts;
    if (bgPage || bgWorker || bgScripts) {
      const bgPath = bgPage || bgWorker || (bgScripts && bgScripts[0]) || '';
      entries.push({
        extensionId: extId, extensionName: disc.name, type: 'background',
        title: `${disc.name} Background`,
        url: bgPath ? `${baseUrl}${bgPath}` : '',
        width: 0, height: 0, openable: !!bgPage,
      });
    }

    // Chrome URL overrides
    if (manifest.chrome_url_overrides) {
      const overrides = manifest.chrome_url_overrides;
      if (overrides.newtab) {
        entries.push({
          extensionId: extId, extensionName: disc.name, type: 'newtab',
          title: `${disc.name} New Tab`,
          url: `${baseUrl}${overrides.newtab}`, width: 1024, height: 768, openable: true,
        });
      }
      if (overrides.history) {
        entries.push({
          extensionId: extId, extensionName: disc.name, type: 'history',
          title: `${disc.name} History`,
          url: `${baseUrl}${overrides.history}`, width: 1024, height: 768, openable: true,
        });
      }
      if (overrides.bookmarks) {
        entries.push({
          extensionId: extId, extensionName: disc.name, type: 'bookmarks',
          title: `${disc.name} Bookmarks`,
          url: `${baseUrl}${overrides.bookmarks}`, width: 1024, height: 768, openable: true,
        });
      }
    }

    // DevTools page
    if (manifest.devtools_page) {
      entries.push({
        extensionId: extId, extensionName: disc.name, type: 'devtools',
        title: `${disc.name} DevTools`,
        url: `${baseUrl}${manifest.devtools_page}`, width: 1024, height: 768, openable: true,
      });
    }

    // Side panel
    const sidePanelPath = manifest.side_panel?.default_path || manifest.sidebar_action?.default_panel;
    if (sidePanelPath) {
      entries.push({
        extensionId: extId, extensionName: disc.name, type: 'sidepanel',
        title: manifest.sidebar_action?.default_title || `${disc.name} Side Panel`,
        url: `${baseUrl}${sidePanelPath}`, width: 400, height: 768, openable: true,
      });
    }
  }

  return entries;
}

// ─── Command name helpers ─────────────────────────────────────────────────────

/**
 * Sanitize a chrome extension display name for use in a command name.
 * - Trims leading/trailing whitespace
 * - Collapses runs of internal whitespace to a single space
 * - Falls back to the extension id if the result is empty
 */
export function sanitizeExtensionName(rawName: string, fallbackId: string): string {
  const collapsed = (rawName || '').replace(/\s+/g, ' ').trim();
  return collapsed || fallbackId;
}

/**
 * Build the command-palette name for opening an extension's options page.
 * Pattern: `<sanitized extension name> options`.
 */
export function buildOptionsCommandName(rawName: string, fallbackId: string): string {
  return `${sanitizeExtensionName(rawName, fallbackId)} options`;
}
