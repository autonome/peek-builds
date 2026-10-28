import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const themeFiles = [
  'themes/basic/variables.css',
  'themes/peek/variables.css',
  'features/theme-basic/variables.css',
  'features/theme-peek/variables.css',
  'features/theme-shichijuni/variables.css',
];

const STATUS_TOKENS = [
  '--accent',
  '--error-bg', '--error-border', '--error-text',
  '--warning-bg', '--warning-border', '--warning-text',
  '--success-bg', '--success-border', '--success-text',
  '--theme-accent', '--theme-success', '--theme-warning', '--theme-danger',
];

for (const file of themeFiles) {
  test(`${file} defines every status token`, () => {
    const css = fs.readFileSync(path.join(root, file), 'utf8');
    for (const token of STATUS_TOKENS) {
      assert.match(css, new RegExp(`^\\s*${token}:`, 'm'), `${token} missing`);
    }
  });
}
