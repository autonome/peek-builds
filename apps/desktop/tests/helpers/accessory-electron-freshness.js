/**
 * accessory-electron-freshness — pure rebuild/reuse decision for the copied
 * "accessory" Electron.app used by the unpacked (source/grep) headless test
 * path (see global-setup-electron-accessory.ts).
 *
 * macOS purges files under the OS temp dir one at a time rather than removing
 * a directory tree atomically, so a copy can lose files (a helper binary, a
 * dylib, a locale pack) while its main binary sits untouched. A staleness
 * check that only compares the main binary's mtime against the source's
 * cannot see that loss — the binary's own mtime is unaffected by a neighbor
 * being purged — so the broken copy passes the check and gets reused, and
 * every launch that follows fails before any test runs. Wholeness (every
 * required file present, plus a completion marker written only after a full,
 * successful copy) catches what a plain mtime comparison cannot.
 */

// Paths relative to the copied bundle's root (Contents/…), naming files
// observed purged out from under an otherwise-untouched copy.
export const REQUIRED_BUNDLE_RELATIVE_PATHS = [
  'Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler',
  'Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libvk_swiftshader.dylib',
  'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist',
  'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/en.lproj/locale.pak',
];

/**
 * Decide whether the copied Electron.app must be (re)built.
 *
 * @param {object} facts
 * @param {boolean} facts.binaryExists - the copied binary is present.
 * @param {number} facts.sourceMtimeMs - source binary mtime, in ms.
 * @param {number} facts.copyMtimeMs - copied binary mtime, in ms (ignored
 *   when binaryExists is false).
 * @param {boolean} facts.markerExists - the completion marker file is
 *   present next to the copy.
 * @param {string[]} facts.missingRequiredFiles - entries from
 *   REQUIRED_BUNDLE_RELATIVE_PATHS that are absent from the copy.
 * @returns {boolean} true when the copy must be rebuilt; false to reuse it.
 */
export function shouldRebuildAccessoryElectron(facts) {
  const { binaryExists, sourceMtimeMs, copyMtimeMs, markerExists, missingRequiredFiles } = facts;
  if (!binaryExists) return true;
  if (copyMtimeMs < sourceMtimeMs) return true;
  if (!markerExists) return true;
  if (missingRequiredFiles.length > 0) return true;
  return false;
}
