/**
 * WebAuthn Bridge for Proton Pass — Architecture Note
 *
 * This file is intentionally empty. The WebAuthn injection is handled directly
 * in entry.ts by reading the Proton Pass extension's webauthn.js file and
 * injecting it via webContents.executeJavaScript() into http/https webviews.
 *
 * Why executeJavaScript() instead of a preload script:
 * - Electron preload scripts run in an isolated context when contextIsolation
 *   is enabled (which it is for webviews by default)
 * - Proton Pass's webauthn.js needs to override navigator.credentials in the
 *   page's MAIN world, not an isolated world
 * - executeJavaScript() runs in the main world, so the overrides are visible
 *   to page scripts
 * - This matches how Electron ignores "world": "MAIN" in Chrome extension
 *   manifest content_scripts — we work around it at the application level
 *
 * See entry.ts, search for "webauthn" for the injection logic.
 */
