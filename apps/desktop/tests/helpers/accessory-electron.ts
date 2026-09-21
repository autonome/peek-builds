/**
 * accessory-electron — shared paths for the TEST-ONLY "accessory" Electron.
 *
 * On macOS the OS activates each fresh Electron process frontmost BEFORE any
 * JS runs, so main/headless-policy.ts's app.setActivationPolicy('accessory')
 * is too late to stop the launch-time focus grab. A headless suite launches
 * ~140 Electron processes, so that blip becomes repeated focus theft from
 * whoever is at the machine. The only PRE-JS suppressor is LSUIElement=true in
 * the bundle's Info.plist.
 *
 * For the UNPACKAGED (source / grep) test path there is no Peek.app bundle to
 * patch — Playwright launches node_modules/electron/dist/Electron.app directly,
 * and that is shared with `yarn start`, so we must not patch it in place. The
 * globalSetup (global-setup-electron-accessory.ts) instead copies that bundle
 * once into a deterministic tmp location and patches the COPY; the fixture
 * (fixtures/desktop-app.ts) then points executablePath at the copy's binary.
 *
 * Both the globalSetup and the fixture import these path helpers so they agree
 * on exactly one location — hence this shared module.
 */
import path from 'path';
import os from 'os';

/** Root dir under the OS temp dir that holds the patched Electron copy. */
export function accessoryElectronDir(): string {
  return path.join(os.tmpdir(), 'peek-accessory-electron');
}

/** Path to the copied Electron.app bundle root (what the plist patch targets). */
export function accessoryElectronAppPath(): string {
  return path.join(accessoryElectronDir(), 'Electron.app');
}

/** Path to the Electron binary inside the copied bundle (executablePath). */
export function accessoryElectronBinaryPath(): string {
  return path.join(accessoryElectronAppPath(), 'Contents', 'MacOS', 'Electron');
}

/**
 * Path to the marker written next to (not inside) the copied bundle, only
 * after a copy and its plist patch both complete. Its absence means the
 * copy is unfinished or has since lost files — see
 * tests/helpers/accessory-electron-freshness.js.
 */
export function accessoryElectronMarkerPath(): string {
  return path.join(accessoryElectronDir(), '.complete');
}
