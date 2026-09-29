#!/usr/bin/env node
// Builds the macOS non-activating window addon
// (apps/desktop/native/nonactivating-window/nonactivating_window.mm).
//
// darwin only; a no-op elsewhere. It compiles with clang against the Node-API
// headers Electron's header cache holds (`~/.electron-gyp/<electron version>`,
// filled by `@electron/rebuild` or `node-gyp install`). Without clang or those
// headers it warns and builds nothing, and the app keeps opening pages over
// another app as panels. A compile error with both present fails the build.
//
// Output: apps/desktop/dist/native/nonactivating-window.node, arm64 (the only
// packaged mac arch).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') process.exit(0);

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(appDir, 'native', 'nonactivating-window', 'nonactivating_window.mm');
const outDir = join(appDir, 'dist', 'native');
const out = join(outDir, 'nonactivating-window.node');

const require = createRequire(import.meta.url);
const electronVersion = JSON.parse(readFileSync(require.resolve('electron/package.json'), 'utf8')).version;
const headers = join(homedir(), '.electron-gyp', electronVersion, 'include', 'node');
if (!existsSync(join(headers, 'node_api.h'))) {
  console.warn(
    `build-nonactivating-window: no Node-API headers for Electron ${electronVersion} ` +
      `(run: npx node-gyp install --target=${electronVersion} --dist-url=https://electronjs.org/headers --devdir=~/.electron-gyp); ` +
      'building no addon, pages over another app stay panels',
  );
  process.exit(0);
}

const probe = spawnSync('clang++', ['--version'], { stdio: 'ignore' });
if (probe.error || probe.status !== 0) {
  console.warn('build-nonactivating-window: clang++ not found (install the Xcode command-line tools); building no addon');
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
const build = spawnSync(
  'clang++',
  [
    '-O2', '-std=c++17', '-fobjc-arc', '-target', 'arm64-apple-macos12.0',
    '-bundle', '-undefined', 'dynamic_lookup',
    '-DNODE_GYP_MODULE_NAME=nonactivating_window', '-DNAPI_VERSION=8',
    '-I', headers, source, '-framework', 'AppKit', '-o', out,
  ],
  { stdio: 'inherit' },
);
if (build.error || build.status !== 0) {
  console.error('build-nonactivating-window: clang++ failed');
  process.exit(build.status || 1);
}
