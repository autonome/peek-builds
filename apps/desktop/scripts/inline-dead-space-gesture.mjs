// Build step: electron sandboxed preloads cannot require sibling files, so the
// shared dead-space-gesture.cjs is inlined into each dist preload that requires it.
// Each preload carries one marked line:
//   const deadSpaceGesture = require('./dead-space-gesture.cjs'); // PEEK_INLINE_DEAD_SPACE_GESTURE
// which is replaced by an IIFE returning the module's exports. Idempotent: a
// preload without the marker line is left alone; a missing target is an error.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist', 'main');
const sharedPath = path.join(dist, 'chrome-api-polyfills', 'dead-space-gesture.cjs');
const targets = [
  path.join(dist, 'chrome-api-polyfills', 'runtime-external-preload.cjs'),
  path.join(dist, 'tile-preload.cjs'),
];
const MARKER = /^[ \t]*(const|var|let) deadSpaceGesture = require\('\.\/dead-space-gesture\.cjs'\); \/\/ PEEK_INLINE_DEAD_SPACE_GESTURE$/m;

const shared = fs.readFileSync(sharedPath, 'utf8');
for (const file of targets) {
  const src = fs.readFileSync(file, 'utf8');
  const m = MARKER.exec(src);
  if (!m) throw new Error(`inline-dead-space-gesture: marker line not found in ${file}`);
  const body = `${m[1]} deadSpaceGesture = (function () { const module = { exports: {} };\n${shared}\nreturn module.exports; })();`;
  fs.writeFileSync(file, src.replace(MARKER, () => body));
  console.log(`inlined dead-space-gesture into ${path.relative(root, file)}`);
}
