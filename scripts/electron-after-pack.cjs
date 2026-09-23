/**
 * electron-builder `afterPack` hook — stamps build identity into the bundle.
 *
 * Writes `build-info.json` into the packaged resources directory and, on
 * macOS, rewrites Info.plist so `CFBundleVersion` names the commit. A hook
 * rather than a package script means every electron-builder invocation is
 * stamped: build:electron, build:electron:dist, the install scripts and the
 * test:desktop:electron gate.
 *
 * This file lives in scripts/, which electron-builder.yml `files` excludes,
 * so the hook itself is never packaged.
 *
 * The git output is interpreted by resolveBuildInfo() in
 * apps/desktop/main/build-info.ts, loaded from its compiled form — every
 * packaging path runs `yarn build` first, so dist/ is present.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PROJECT_DIR = path.resolve(__dirname, '..');
const BUILD_INFO_MODULE = path.join(PROJECT_DIR, 'apps/desktop/dist/main/build-info.js');

function git(args) {
  return execFileSync('git', args, { cwd: PROJECT_DIR, encoding: 'utf8' });
}

/**
 * macOS keeps the app payload inside the .app bundle; every other platform
 * puts a resources/ directory beside the executable.
 */
function resourcesDirFor(context) {
  if (context.electronPlatformName === 'darwin') {
    const productFilename = context.packager.appInfo.productFilename;
    return path.join(context.appOutDir, `${productFilename}.app`, 'Contents', 'Resources');
  }
  return path.join(context.appOutDir, 'resources');
}

function stampInfoPlist(context, info) {
  const plist = require('plist');
  const productFilename = context.packager.appInfo.productFilename;
  const plistPath = path.join(context.appOutDir, `${productFilename}.app`, 'Contents', 'Info.plist');
  const parsed = plist.parse(fs.readFileSync(plistPath, 'utf8'));
  parsed.CFBundleVersion = info.shortCommit;
  parsed.PeekBuildCommit = info.commit;
  parsed.PeekBuildDirty = info.dirty;
  fs.writeFileSync(plistPath, plist.build(parsed));
  return plistPath;
}

module.exports = async function afterPack(context) {
  let info;
  try {
    const { resolveBuildInfo } = await import(pathToFileURL(BUILD_INFO_MODULE).href);
    info = resolveBuildInfo({
      commit: git(['rev-parse', 'HEAD']),
      commitTime: git(['log', '-1', '--format=%cI']),
      porcelain: git(['status', '--porcelain']),
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
      toplevel: git(['rev-parse', '--show-toplevel']),
      buildTime: new Date().toISOString(),
      version: require(path.join(PROJECT_DIR, 'package.json')).version,
    });
  } catch (err) {
    // A build from a source tarball has no git, and a bundle that cannot name
    // its source is better than a packaging run that dies. The app logs
    // "unidentified build" when the stamp is missing.
    console.warn(`[after-pack] build identity not stamped: ${err && err.message}`);
    return;
  }

  const resourcesDir = resourcesDirFor(context);
  const target = path.join(resourcesDir, 'build-info.json');
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(info, null, 2)}\n`);
  console.log(`[after-pack] ${target}: commit=${info.shortCommit} dirty=${info.dirty} checkout=${info.checkout}`);

  if (context.electronPlatformName === 'darwin') {
    // Signing is disabled (electron-builder.yml `identity: null`), so editing
    // the plist after packing does not invalidate a signature.
    console.log(`[after-pack] ${stampInfoPlist(context, info)}: CFBundleVersion=${info.shortCommit}`);
  }
};
