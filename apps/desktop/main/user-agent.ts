/**
 * User-Agent helpers.
 *
 * Deliberately a leaf module with NO electron imports, so it can be imported
 * directly by unit tests running under `ELECTRON_RUN_AS_NODE=1` (where named
 * `electron` exports are unavailable) — the test exercises the SAME code the
 * app runs, no mirrored copy.
 */

/**
 * Normalize an Electron User-Agent string into a clean stock-Chrome UA.
 *
 * Electron's default `app.userAgentFallback` for a *named* app is
 *   `Mozilla/5.0 (...) AppleWebKit/537.36 (KHTML, like Gecko) Peek/<ver> Chrome/<ver> Electron/<ver> Safari/537.36`
 * — i.e. it injects the app product token (`Peek/<ver>`) BEFORE the `Chrome/`
 * token, and appends an `Electron/<ver>` token. Both are non-standard tells that
 * UA-sniffing sites reject. The leading app token is the worse offender:
 * WhatsApp Web's browser sniffer reads the first product after the engine
 * comment as the "browser", sees `Peek`, and renders its unsupported-browser
 * page (verified end-to-end — peek 080fd433; a UA carrying only `Electron/<ver>`
 * AFTER `Chrome/` loads WhatsApp fine, one carrying `Peek/<ver>` before it does
 * not).
 *
 * So strip BOTH: any product token(s) between `(KHTML, like Gecko)` and
 * `Chrome/`, and the trailing `Electron/<ver>`. What's left is the canonical
 * Chrome UA `... (KHTML, like Gecko) Chrome/<ver> Safari/537.36`. The
 * `Chrome/<version>` token stays live, so the UA tracks the bundled Chromium
 * automatically across Electron upgrades (no hardcoded version to drift). This
 * is intentionally generic — it does not hardcode "Peek", so it also cleans a
 * UA with a different app name or no app token at all.
 *
 * Applied globally via `app.userAgentFallback` in initSessionPartition(), which
 * every session and webContents inherits.
 */
export function toChromeUserAgent(userAgent: string): string {
  return userAgent
    // Drop any app product token(s) sitting between the engine comment and the
    // Chrome token (e.g. "Peek/0.0.1 ").
    .replace(/(\(KHTML, like Gecko\) ).*?(Chrome\/)/, '$1$2')
    // Drop the trailing Electron token.
    .replace(/ Electron\/\S+/, '');
}
