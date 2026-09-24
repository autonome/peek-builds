/**
 * Download save-path helpers.
 *
 * Kept in its own module so it can be imported without pulling in `electron`:
 * the main-process unit tests run under `ELECTRON_RUN_AS_NODE=1`, where
 * `import ... from 'electron'` cannot load, and `session-partition.ts` imports
 * electron plus the window registry, protocol and permission handler.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Given a desired save path, return a path that does not already exist on disk.
 * If the desired path is free, returns it unchanged.
 * Otherwise appends an incrementing counter before the extension:
 *   download.jpg → download-1.jpg → download-2.jpg → …
 */
export function resolveUniqueDownloadPath(desiredPath: string): string {
  if (!fs.existsSync(desiredPath)) {
    return desiredPath;
  }
  const ext = path.extname(desiredPath);
  const base = desiredPath.slice(0, desiredPath.length - ext.length);
  let counter = 1;
  while (true) {
    const candidate = `${base}-${counter}${ext}`;
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
    counter++;
  }
}

/**
 * Strip path separators and other filesystem-hostile characters from a
 * download filename. Chromium already drops `/` and `\` from suggested
 * names, but we belt-and-suspender against null bytes, control chars,
 * and absurdly long names that would error on `setSavePath`.
 */
export function sanitizeDownloadFilename(raw: string): string {
  // eslint-disable-next-line no-control-regex
  let cleaned = (raw || '').replace(/[\x00-\x1f/\\:*?"<>|]/g, '_').trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') {
    cleaned = `download-${Date.now()}`;
  }
  // 200 chars leaves headroom for collision suffixes + path components.
  if (cleaned.length > 200) {
    const ext = path.extname(cleaned);
    cleaned = cleaned.slice(0, 200 - ext.length) + ext;
  }
  return cleaned;
}
