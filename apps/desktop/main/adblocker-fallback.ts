/**
 * Bundled adblocker fallback list and its engine builder.
 *
 * Kept in its own module so it can be imported without pulling in `electron`:
 * the main-process unit tests run under `ELECTRON_RUN_AS_NODE=1`, where
 * `import ... from 'electron'` cannot load, and `adblocker.ts` imports `app`
 * and `session`.
 */

import { ElectronBlocker } from '@ghostery/adblocker-electron';

// ─── Bundled fallback ────────────────────────────────────────────────────────
// A minimal filter list shipped inside the app binary.  Privacy posture >
// correctness: it is better to block a handful of well-known domains than to
// run with no adblocker on first boot when the network is unavailable.
// Rules are uBlock Origin / EasyList syntax.
export const BUNDLED_FALLBACK_FILTERS = `
! Peek bundled adblocker fallback (used only when cache absent and network down)
! Generated from a small subset of EasyList + EasyPrivacy core rules.
||doubleclick.net^
||googlesyndication.com^
||googleadservices.com^
||adnxs.com^
||advertising.com^
||ads.yahoo.com^
||pubmatic.com^
||rubiconproject.com^
||openx.net^
||quantserve.com^
||scorecardresearch.com^
||omtrdc.net^
||2mdn.net^
||adform.net^
||criteo.com^
||tapad.com^
||liveramp.net^
||liveramp.com^
||adsrvr.org^
||adtech.de^
||smartadserver.com^
||yieldmo.com^
||google-analytics.com^$third-party
||googletagmanager.com^$third-party
||googletagservices.com^
||moatads.com^
||adroll.com^
||facebook.com/tr/*^
||connect.facebook.net^$third-party
`.trim();

/**
 * Build a minimal engine from the bundled fallback list.
 * Never throws.
 */
export function buildFallbackEngine(): ElectronBlocker {
  return ElectronBlocker.parse(BUNDLED_FALLBACK_FILTERS);
}
