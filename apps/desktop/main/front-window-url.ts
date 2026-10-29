/**
 * Pure choice of the address `copy url` puts on the clipboard.
 *
 * Web pages and built-in `peek://` windows both have an address worth
 * copying; a blank or not-yet-navigated window does not. Candidates are
 * ordered by preference (page content first, then the window itself).
 */

const NOT_COPYABLE = new Set(['', 'about:blank']);

export function pickCopyableUrl(candidates: ReadonlyArray<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const url = candidate.trim();
    if (NOT_COPYABLE.has(url)) continue;
    return url;
  }
  return null;
}
