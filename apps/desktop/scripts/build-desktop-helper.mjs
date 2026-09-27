#!/usr/bin/env node
// Builds the macOS desktop helper (specs/kernel-desktops.md, section 6 "Build and packaging").
//
// darwin only; a no-op elsewhere. Without a Swift compiler (Xcode command-line tools) it warns
// and builds nothing, and the app runs on the fallback desktop provider. A compile error with a
// compiler present fails the build.
//
// Output: apps/desktop/dist/native/peek-desktop-helper, arm64 (the only packaged mac arch).
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') process.exit(0);

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(appDir, 'native', 'desktop-helper', 'main.swift');
const outDir = join(appDir, 'dist', 'native');
const out = join(outDir, 'peek-desktop-helper');

const probe = spawnSync('swiftc', ['--version'], { stdio: 'ignore' });
if (probe.error || probe.status !== 0) {
  console.warn(
    'build-desktop-helper: swiftc not found (install the Xcode command-line tools); ' +
      'building no desktop helper, the app will use the fallback desktop provider',
  );
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
const build = spawnSync(
  'swiftc',
  ['-O', '-target', 'arm64-apple-macos12.0', source, '-o', out],
  { stdio: 'inherit' },
);
if (build.error || build.status !== 0) {
  console.error('build-desktop-helper: swiftc failed');
  process.exit(build.status || 1);
}
