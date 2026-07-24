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
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  accessoryElectronDir,
  accessoryElectronAppPath,
  accessoryElectronBinaryPath,
} from './helpers/accessory-electron';

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

  // Skip the ~250MB copy when the existing copy is up to date (mtime >= source).
  // Only re-copies after an Electron upgrade bumps the source binary's mtime.
  if (fs.existsSync(destBinary)) {
    const srcMtime = fs.statSync(srcBinary).mtimeMs;
    const destMtime = fs.statSync(destBinary).mtimeMs;
    if (destMtime >= srcMtime) {
      return;
    }
  }

  // (Re)build the copy. Clear any stale copy first so cp doesn't merge into it.
  fs.rmSync(destApp, { recursive: true, force: true });
  fs.mkdirSync(accessoryElectronDir(), { recursive: true });
  // cp -R preserves the symlinks inside a macOS .app bundle (Frameworks, etc.),
  // which fs.cpSync's defaults do not reliably reproduce.
  execFileSync('cp', ['-R', srcApp, accessoryElectronDir()], { stdio: 'inherit' });

  // Patch the COPY's Info.plist — same helper the packaged path uses.
  const patchScript = path.join(REPO_ROOT, 'scripts', 'patch-test-plist.sh');
  execFileSync(patchScript, [destApp], { stdio: 'inherit' });
}
