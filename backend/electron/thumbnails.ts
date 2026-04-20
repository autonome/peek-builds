/**
 * Thumbnail capture and storage service.
 *
 * Captures page screenshots, resizes to 600x400 JPEG thumbnails,
 * and stores them in userData/thumbnails/ keyed by SHA-256 hash of
 * normalized URL.
 *
 * Features:
 * - Capture queue with max 1 concurrent to avoid GPU contention
 * - Skip recapture if thumbnail exists and is less than 24 hours old
 * - Cleanup/eviction at shutdown (not startup)
 * - NativeImage released immediately after write
 */

import type { WebContents } from 'electron';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEBUG } from './config.js';
import { normalizeUrl } from './datastore.js';

// Lazy-load `app` via CommonJS require so this module can be imported under
// ELECTRON_RUN_AS_NODE=1 (where electron's named ESM exports are empty).
// Consumers that never call initThumbnailDir/cleanupThumbnails (e.g. unit
// tests that transitively import via protocol.ts -> tile-launcher.ts) won't
// trigger the require.
const requireElectron = createRequire(import.meta.url);
let _app: typeof import('electron').app | null = null;
function getApp(): typeof import('electron').app {
  if (_app) return _app;
  const electron = requireElectron('electron') as typeof import('electron');
  _app = electron.app;
  return _app;
}

let thumbnailDir: string;

// 24 hours in milliseconds
const THUMBNAIL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Max total size for thumbnails directory (100MB)
const MAX_TOTAL_SIZE_BYTES = 100 * 1024 * 1024;

// ── Queue ────────────────────────────────────────────────────────────

type CaptureTask = {
  webContents: WebContents;
  url: string;
  resolve: (hash: string | null) => void;
};

const captureQueue: CaptureTask[] = [];
let captureRunning = false;

async function processQueue(): Promise<void> {
  if (captureRunning) return;
  const task = captureQueue.shift();
  if (!task) return;

  captureRunning = true;
  try {
    const hash = await doCapture(task.webContents, task.url);
    task.resolve(hash);
  } catch (err) {
    DEBUG && console.log('[thumbnails] Capture failed:', err);
    task.resolve(null);
  } finally {
    captureRunning = false;
    // Process next item
    processQueue();
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Ensure the thumbnails directory exists under userData.
 */
export function initThumbnailDir(): void {
  thumbnailDir = path.join(getApp().getPath('userData'), 'thumbnails');
  if (!fs.existsSync(thumbnailDir)) {
    fs.mkdirSync(thumbnailDir, { recursive: true });
    DEBUG && console.log('[thumbnails] Created thumbnail dir:', thumbnailDir);
  }
}

/**
 * Compute SHA-256 hash of normalized URL for use as filename.
 */
export function urlToHash(url: string): string {
  const normalized = normalizeUrl(url);
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Get the filesystem path for a thumbnail hash.
 */
export function getThumbnailPath(hash: string): string {
  return path.join(thumbnailDir, `${hash}.jpg`);
}

/**
 * Queue a thumbnail capture. Returns the hash on success, null on failure.
 * Skips recapture if the thumbnail already exists and is less than 24 hours old.
 */
export function captureThumbnail(webContents: WebContents, url: string): Promise<string | null> {
  const hash = urlToHash(url);
  const filePath = getThumbnailPath(hash);

  // Skip if recent thumbnail exists
  if (fs.existsSync(filePath)) {
    try {
      const stat = fs.statSync(filePath);
      if (Date.now() - stat.mtimeMs < THUMBNAIL_MAX_AGE_MS) {
        DEBUG && console.log('[thumbnails] Skipping recapture (fresh):', url);
        return Promise.resolve(hash);
      }
    } catch { /* stat failed, recapture */ }
  }

  return new Promise((resolve) => {
    captureQueue.push({ webContents, url, resolve });
    processQueue();
  });
}

/**
 * Perform the actual capture: screenshot, resize, save as JPEG.
 */
async function doCapture(webContents: WebContents, url: string): Promise<string | null> {
  if (webContents.isDestroyed()) return null;

  const hash = urlToHash(url);
  const filePath = getThumbnailPath(hash);

  try {
    const nativeImage = await webContents.capturePage();
    if (nativeImage.isEmpty()) {
      DEBUG && console.log('[thumbnails] Empty capture for:', url);
      return null;
    }

    // Resize to 600x400
    const resized = nativeImage.resize({ width: 600, height: 400 });
    const jpegBuffer = resized.toJPEG(80);

    fs.writeFileSync(filePath, jpegBuffer);
    DEBUG && console.log('[thumbnails] Saved:', hash, 'for', url);

    return hash;
  } catch (err) {
    DEBUG && console.log('[thumbnails] Capture error:', err);
    return null;
  }
}

/**
 * Eviction: remove thumbnails whose hash doesn't match any non-deleted item.
 * Then cap total size at ~100MB by removing oldest files.
 * Called at shutdown, not startup.
 */
export function cleanupThumbnails(getActiveHashes: () => Set<string>): void {
  if (!thumbnailDir || !fs.existsSync(thumbnailDir)) return;

  try {
    const activeHashes = getActiveHashes();
    const files = fs.readdirSync(thumbnailDir);

    // Phase 1: Remove orphaned thumbnails
    for (const file of files) {
      if (!file.endsWith('.jpg')) continue;
      const hash = file.replace('.jpg', '');
      if (!activeHashes.has(hash)) {
        try {
          fs.unlinkSync(path.join(thumbnailDir, file));
          DEBUG && console.log('[thumbnails] Evicted orphan:', hash);
        } catch { /* ignore individual file errors */ }
      }
    }

    // Phase 2: Cap total size by mtime (oldest first)
    const remaining = fs.readdirSync(thumbnailDir)
      .filter(f => f.endsWith('.jpg'))
      .map(f => {
        const fullPath = path.join(thumbnailDir, f);
        const stat = fs.statSync(fullPath);
        return { path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first

    let totalSize = remaining.reduce((sum, f) => sum + f.size, 0);

    // Remove oldest until under cap
    for (let i = remaining.length - 1; i >= 0 && totalSize > MAX_TOTAL_SIZE_BYTES; i--) {
      try {
        fs.unlinkSync(remaining[i].path);
        totalSize -= remaining[i].size;
        DEBUG && console.log('[thumbnails] Evicted for size:', path.basename(remaining[i].path));
      } catch { /* ignore */ }
    }

    DEBUG && console.log(`[thumbnails] Cleanup done. ${remaining.length} files, ${(totalSize / 1024 / 1024).toFixed(1)}MB`);
  } catch (err) {
    console.error('[thumbnails] Cleanup error:', err);
  }
}
