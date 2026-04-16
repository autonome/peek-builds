/**
 * Pure helpers for chrome-extension command registration.
 *
 * Kept in a separate file (no electron imports) so they can be unit-tested
 * under plain node without needing the Electron runtime.
 */

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
