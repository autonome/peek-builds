/**
 * Drift detection: no module in `app/` or `features/` should still
 * use the deprecated `import('foo.json', { assert: { type: 'json' } })`
 * attribute syntax.
 *
 * Why: Chrome 123+ removed `assert: { type: 'json' }` in favour of the
 * `with: { type: 'json' }` import-attributes spec. Electron 40 ships
 * Chrome ~131, so the old form is silently dropped — the import then
 * fails strict module-script MIME checking with
 *
 *   Failed to load module script: Expected a JavaScript-or-Wasm module
 *   script but the server responded with a MIME type of "application/json".
 *
 * Observed in packaged build 2026-05-08 in features/entities/name-validator.js.
 * The fix is mechanical (rename `assert` → `with`); without this test,
 * a future agent could re-introduce the deprecated form when copying
 * an example off the web or from older docs.
 *
 * Scope: every `.js` / `.mjs` / `.cjs` under `app/` and `features/`.
 * Skips `node_modules`, dot-dirs, and the test harness itself.
 *
 * Wholesale `import './foo.json'` (no attribute) is also flagged —
 * that form is an error in any modern Electron because the protocol
 * handler returns `application/json` and the loader expects JS without
 * an attribute clause.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

function repoRoot(): string {
  return process.cwd();
}

function jsFilesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        stack.push(full);
      } else if (e.isFile() && /\.(js|cjs|mjs)$/.test(e.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Scan a source for `import(... .json ..., { assert: { type: 'json' } })`
 * patterns. The regex is intentionally loose on whitespace and quote
 * style; tight on the `assert: { type: 'json' }` shape so the
 * already-fixed `with: { type: 'json' }` form does not match.
 */
function findDeprecatedAssert(source: string): RegExpMatchArray[] {
  // Matches:  assert\s*:\s*\{\s*type\s*:\s*['"`]json['"`]\s*\}
  // Anchored on the keyword `assert:` to avoid false positives on
  // `node:assert` or assertion library calls.
  const re = /\bassert\s*:\s*\{\s*type\s*:\s*['"`]json['"`]\s*\}/g;
  return Array.from(source.matchAll(re));
}

/**
 * Scan a source for `import(...)` of a `.json` path with NO attribute
 * clause at all — also a guaranteed failure under strict module-script
 * MIME checking. Catches a different mistake from `assert` (forgot the
 * attribute entirely) but the symptom is the same.
 *
 * Heuristic: an `import('…json'...)` call where neither `with:` nor
 * `assert:` appears within a small window after the closing quote.
 * Imperfect but cheap; review hits manually.
 */
function findUnattributedJsonImport(source: string): RegExpMatchArray[] {
  // import\s*\(\s*['"`][^'"`]*\.json['"`]\s*(\)|,[^)]*\))
  // Then look for `with` or `assert` inside the second arg.
  const re = /\bimport\s*\(\s*(['"`])[^'"`]*\.json\1\s*(?:\)|,([^)]*)\))/g;
  const offenders: RegExpMatchArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const secondArg = m[2] ?? '';
    const hasAttr = /\b(?:with|assert)\b/.test(secondArg);
    if (!hasAttr) offenders.push(m);
  }
  return offenders;
}

describe('json-import-deprecated-assert drift detection', () => {
  it('no module uses deprecated `assert: { type: \'json\' }` attribute syntax', () => {
    const offenders: string[] = [];
    for (const root of ['app', 'features']) {
      const dir = path.join(repoRoot(), root);
      for (const file of jsFilesUnder(dir)) {
        const source = fs.readFileSync(file, 'utf-8');
        const matches = findDeprecatedAssert(source);
        for (const m of matches) {
          const line = source.slice(0, m.index!).split('\n').length;
          offenders.push(`${path.relative(repoRoot(), file)}:${line} — ${m[0]}`);
        }
      }
    }
    assert.deepStrictEqual(
      offenders, [],
      'Found `assert: { type: \'json\' }` import attribute. Chrome 123+ ' +
      'removed this syntax in favour of `with: { type: \'json\' }`; the ' +
      'old form is silently dropped, then strict MIME checking fails the ' +
      'module load with "Expected a JavaScript-or-Wasm module script but ' +
      'the server responded with a MIME type of \\"application/json\\"". ' +
      'Rename `assert` → `with`.\n\nOffenders:\n  ' + offenders.join('\n  '),
    );
  });

  it('no `import(\'…json\')` lacks a `with` attribute', () => {
    const offenders: string[] = [];
    for (const root of ['app', 'features']) {
      const dir = path.join(repoRoot(), root);
      for (const file of jsFilesUnder(dir)) {
        const source = fs.readFileSync(file, 'utf-8');
        const matches = findUnattributedJsonImport(source);
        for (const m of matches) {
          const line = source.slice(0, m.index!).split('\n').length;
          offenders.push(`${path.relative(repoRoot(), file)}:${line} — ${m[0]}`);
        }
      }
    }
    assert.deepStrictEqual(
      offenders, [],
      'Found `import(\'…json\')` with no import attribute. Strict module-' +
      'script MIME checking will reject the load. Add ' +
      '`{ with: { type: \'json\' } }` as the second argument.\n\n' +
      'Offenders:\n  ' + offenders.join('\n  '),
    );
  });
});
