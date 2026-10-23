/**
 * Electron-free resolution of a `peek://app/{path}` pathname to a file under
 * `renderer/`. Shared by the protocol handler (`protocol.ts`) and session
 * restore (`session.ts isValidDescriptor()`), and kept free of `electron` so
 * `session.test.ts` can import it directly.
 */

import path from 'node:path';

/**
 * Absolute file path a `peek://app/{pathname}` request maps to, or null if it
 * would escape `renderer/`. `pathname` has no leading slash.
 */
export function resolveRendererPath(rootDir: string, pathname: string): string | null {
  const absolutePath = path.resolve(rootDir, 'renderer', pathname);
  const rendererBase = path.resolve(rootDir, 'renderer');
  if (!absolutePath.startsWith(rendererBase)) return null;
  return absolutePath;
}

/**
 * Whether a saved `peek://app/...` window URL still points at a page that
 * exists. Other URLs (other hosts, other schemes) are not this function's
 * concern and report true.
 */
export function appPageExists(
  rootDir: string,
  url: string,
  exists: (p: string) => boolean,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (parsed.protocol !== 'peek:' || parsed.host !== 'app') return true;
  const resolved = resolveRendererPath(rootDir, parsed.pathname.replace(/^\//, ''));
  return resolved !== null && exists(resolved);
}
