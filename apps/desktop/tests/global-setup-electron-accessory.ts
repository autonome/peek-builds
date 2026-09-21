/**
 * Playwright globalSetup — build a TEST-ONLY "accessory" Electron for the
 * UNPACKAGED (source / grep) launch path, so headless test runs stop stealing
 * the user's focus at launch time.
 *
 * Background: on macOS the OS activates each fresh Electron process frontmost
 * BEFORE any JS runs, so main/headless-policy.ts's
 * app.setActivationPolicy('accessory') is too late — the focus grab already
 * happened. The only PRE-JS suppressor is LSUIElement=true in the bundle's
 * Info.plist. The PACKAGED test path patches out/mac-arm64/Peek.app directly
 * (scripts/patch-test-plist.sh, invoked from the test:desktop:electron[:x]
 * scripts). The UNPACKAGED path launches node_modules/electron/dist/Electron.app,
 * which is SHARED with `yarn start` and must not be patched in place — so here
 * we copy it once into a deterministic tmp location and patch the COPY. The
 * fixture (fixtures/desktop-app.ts) then points executablePath at the copy.
 *
 * GUARDED so production and dev are untouched: runs only when
 *   darwin  &&  headless (HEADLESS|PEEK_HEADLESS)  &&  !packaged (PACKAGED).
 * Any other run (non-darwin, non-headless, or the packaged path) is a no-op and
 * the fixture falls back to today's behavior. The headless/packaged detection
 * mirrors isHeadless()/isPackaged() in fixtures/desktop-app.ts.
 *
 * The existing copy is reused only when it is WHOLE, not merely current: the
 * copied binary must exist and be at least as new as the source, a completion
 * marker written after a full prior copy must exist, and a short list of
 * bundle files known to matter must all be present. A copy sitting under the
 * OS temp dir can lose files to the OS's own one-at-a-time purge (observed:
 * chrome_crashpad_handler, libvk_swiftshader.dylib, the framework's
 * Resources/Info.plist, every locale.pak) while its main binary's mtime is
 * untouched, so an mtime-only check reuses a broken copy and every launch
 * that follows dies before any test runs. The decision itself is the pure
 * function shouldRebuildAccessoryElectron (helpers/accessory-electron-freshness.js).
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  accessoryElectronDir,
  accessoryElectronAppPath,
  accessoryElectronBinaryPath,
  accessoryElectronMarkerPath,
} from './helpers/accessory-electron';
import {
  shouldRebuildAccessoryElectron,
  REQUIRED_BUNDLE_RELATIVE_PATHS,
} from './helpers/accessory-electron-freshness.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// From apps/desktop/tests/ → monorepo root is 3 levels up.
const REPO_ROOT = path.join(__dirname, '../../..');

// Mirror fixtures/desktop-app.ts isHeadless()/isPackaged().
function isHeadless(): boolean {
  const h = process.env.HEADLESS;
  const p = process.env.PEEK_HEADLESS;
  return h === '1' || h === 'true' || p === '1' || p === 'true';
}
function isPackaged(): boolean {
  const v = process.env.PACKAGED;
  return v === '1' || v === 'true';
}

export default async function globalSetup(): Promise<void> {
  // Guard: only the darwin + headless + unpackaged path needs (or gets) this.
  if (process.platform !== 'darwin' || !isHeadless() || isPackaged()) {
    return;
  }

  const srcApp = path.join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'Electron.app');
  const srcBinary = path.join(srcApp, 'Contents', 'MacOS', 'Electron');
  if (!fs.existsSync(srcBinary)) {
    // No local Electron to copy (shouldn't happen in a built clone) — skip
    // silently; the fixture guard also checks existsSync and falls back.
    console.warn(`[accessory-electron] source Electron missing at ${srcBinary}; skipping`);
    return;
  }

  const destApp = accessoryElectronAppPath();
  const destBinary = accessoryElectronBinaryPath();
  const markerPath = accessoryElectronMarkerPath();

  const binaryExists = fs.existsSync(destBinary);
  const missingRequiredFiles = binaryExists
    ? REQUIRED_BUNDLE_RELATIVE_PATHS.filter((rel) => !fs.existsSync(path.join(destApp, rel)))
    : [...REQUIRED_BUNDLE_RELATIVE_PATHS];

  const rebuild = shouldRebuildAccessoryElectron({
    binaryExists,
    sourceMtimeMs: fs.statSync(srcBinary).mtimeMs,
    copyMtimeMs: binaryExists ? fs.statSync(destBinary).mtimeMs : 0,
    markerExists: fs.existsSync(markerPath),
    missingRequiredFiles,
  });
  if (!rebuild) {
    return;
  }

  // (Re)build the copy. Clear any stale copy first so cp doesn't merge into it.
  fs.rmSync(destApp, { recursive: true, force: true });
  fs.rmSync(markerPath, { force: true });
  fs.mkdirSync(accessoryElectronDir(), { recursive: true });
  // cp -R preserves the symlinks inside a macOS .app bundle (Frameworks, etc.),
  // which fs.cpSync's defaults do not reliably reproduce.
  execFileSync('cp', ['-R', srcApp, accessoryElectronDir()], { stdio: 'inherit' });

  // Patch the COPY's Info.plist — same helper the packaged path uses.
  const patchScript = path.join(REPO_ROOT, 'scripts', 'patch-test-plist.sh');
  execFileSync(patchScript, [destApp], { stdio: 'inherit' });

  // Marker written LAST, after the copy and the patch both succeed, so a
  // copy interrupted at any earlier point is also treated as not whole.
  fs.writeFileSync(markerPath, new Date().toISOString());
}
