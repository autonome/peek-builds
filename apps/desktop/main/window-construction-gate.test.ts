/**
 * Static gate over window construction in the main-process tree.
 *
 * The page-open paths are enumerated here as an inventory: every non-comment
 * `new BrowserWindow(...)` / `new BaseWindow(...)` / `new WebContentsView(...)`
 * (including the `...Ctor` injection aliases) in `apps/desktop/main` must appear
 * in EXPECTED with a reason. A new construction site therefore turns this suite
 * red at build time rather than waiting for a launched run to happen to create
 * that window and trip the `web-contents-created` listener in `entry.ts`.
 *
 * Three layers:
 *   1. Inventory — per file + constructor family counts match EXPECTED.
 *   2. Forbidden literals — no `nodeIntegration: true`, `contextIsolation: false`,
 *      `webSecurity: false`, nor `nodeIntegrationInSubFrames` / `enableRemoteModule`
 *      / `allowRunningInsecureContent` as a property at line start.
 *   3. Self-check — the scanner actually sees the known sites, so a broken path
 *      or regex cannot make the gate pass by scanning nothing.
 *
 * Sibling gate: `sandbox-enforcement.test.ts` covers `sandbox: false` the same way.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Compiled test lives at apps/desktop/dist/main/; source lives at apps/desktop/main/.
const MAIN_SRC_DIR = path.resolve(__dirname, '../../main');

type ConstructorFamily = 'BrowserWindow' | 'BaseWindow' | 'WebContentsView';

interface InventoryRow {
  /** Path relative to apps/desktop/main, forward-slashed. */
  file: string;
  ctor: ConstructorFamily;
  count: number;
  reason: string;
}

/**
 * Every window-construction site in the main tree, per file and constructor
 * family. Counts come from a scan of the tree; the `...Ctor` aliases
 * (`BrowserWindowCtor`, `BaseWindowCtor`) count under their base family.
 */
const EXPECTED: InventoryRow[] = [
  {
    file: 'tile-launcher.ts',
    ctor: 'BrowserWindow',
    count: 1,
    reason: 'createTileBrowserWindow(): every tile window, loaded through the tile preload',
  },
  {
    file: 'core-glue.ts',
    ctor: 'BrowserWindow',
    count: 1,
    reason: 'the background / core window that hosts the orchestrator',
  },
  {
    file: 'test-fixture-glue.ts',
    ctor: 'BrowserWindow',
    count: 1,
    reason: 'the test fixture window, injected constructor',
  },
  {
    file: 'ipc.ts',
    ctor: 'BrowserWindow',
    count: 1,
    reason: "the window-open handler's direct path for non-tile windows",
  },
  {
    file: 'ipc.ts',
    ctor: 'BaseWindow',
    count: 1,
    reason: 'createHybridHostBaseWindow(): the hybrid page-host frame',
  },
  {
    file: 'ipc.ts',
    ctor: 'WebContentsView',
    count: 3,
    reason: 'hybrid page-host content: adopted popup, fresh popup, page host',
  },
  {
    file: 'hybrid-overlay.ts',
    ctor: 'BrowserWindow',
    count: 1,
    reason: 'the single shared chrome overlay window',
  },
  {
    file: 'hybrid-overlay.ts',
    ctor: 'BaseWindow',
    count: 5,
    reason: 'test-bridge hosts and the "elsewhere" helper window',
  },
  {
    file: 'hybrid-overlay.ts',
    ctor: 'WebContentsView',
    count: 4,
    reason: 'content views for the test-bridge hosts',
  },
  {
    file: 'chrome-extensions.ts',
    ctor: 'BrowserWindow',
    count: 2,
    reason: 'the extension bridge window; the extension options/popup page window',
  },
  {
    file: 'chrome-api-polyfills/offscreen.js',
    ctor: 'BrowserWindow',
    count: 1,
    reason: 'the chrome.offscreen document host',
  },
];

const CONSTRUCTION_RE = /\bnew\s+(BrowserWindow|BaseWindow|WebContentsView)[A-Za-z]*\s*\(/g;

/** Property names that must never appear as a live webPreferences setting. */
const FORBIDDEN_LITERALS: Array<{ re: RegExp; what: string }> = [
  { re: /^\s*nodeIntegration\s*:\s*true\b/, what: 'nodeIntegration: true' },
  { re: /^\s*contextIsolation\s*:\s*false\b/, what: 'contextIsolation: false' },
  { re: /^\s*webSecurity\s*:\s*false\b/, what: 'webSecurity: false' },
  { re: /^\s*nodeIntegrationInSubFrames\s*:/, what: 'nodeIntegrationInSubFrames' },
  { re: /^\s*enableRemoteModule\s*:/, what: 'enableRemoteModule' },
  { re: /^\s*allowRunningInsecureContent\s*:/, what: 'allowRunningInsecureContent' },
];

const ADD_TO_EXPECTED =
  'A new window construction site must be added to EXPECTED in ' +
  'main/window-construction-gate.test.ts with a one-line reason and, if it loads ' +
  'content, must register with the window-state machine and appear under a ' +
  'policy-compliant webPreferences.';

describe('window construction — inventory', () => {
  it('every construction site in the main tree is listed in EXPECTED', () => {
    const actual = scanInventory();
    const expected = expectedAsMap();

    const problems: string[] = [];
    for (const key of unionKeys(actual, expected)) {
      const got = actual.get(key) ?? 0;
      const want = expected.get(key) ?? 0;
      if (got === want) continue;
      const [file, ctor] = key.split('|');
      if (want === 0) {
        problems.push(`${file}: ${got} unlisted \`new ${ctor}(\` site(s)`);
      } else if (got === 0) {
        problems.push(`${file}: EXPECTED lists ${want} \`new ${ctor}(\` site(s), found none`);
      } else {
        problems.push(`${file}: found ${got} \`new ${ctor}(\` site(s), EXPECTED lists ${want}`);
      }
    }

    assert.deepEqual(problems, [], `Window construction inventory drifted. ${ADD_TO_EXPECTED} Drift: ${problems.join('; ')}`);
  });

  it('every EXPECTED row carries a reason', () => {
    for (const row of EXPECTED) {
      assert.ok(
        row.reason && row.reason.length > 10,
        `EXPECTED row ${row.file} / ${row.ctor} needs a real reason for its window`,
      );
      assert.ok(row.count > 0, `EXPECTED row ${row.file} / ${row.ctor} must have a positive count`);
    }
  });
});

describe('window construction — forbidden webPreferences literals', () => {
  it('no unsafe webPreferences literal exists in the main tree', () => {
    const offenders: string[] = [];
    for (const file of walkSource(MAIN_SRC_DIR)) {
      if (isTestFile(file)) continue;
      const rel = relSource(file);
      readSourceLines(file).forEach((line, i) => {
        for (const { re, what } of FORBIDDEN_LITERALS) {
          if (re.test(line)) offenders.push(`${rel}:${i + 1} (${what})`);
        }
      });
    }
    assert.deepEqual(
      offenders,
      [],
      'Found an unsafe webPreferences literal in the main tree. Renderer isolation and ' +
        'web security are mandatory — wire a narrow capability instead of relaxing them. ' +
        `Offenders: ${offenders.join(', ')}`,
    );
  });
});

/**
 * Hold-to-drag (docs/design/window-drag.md) reads the press from the window's
 * webContents. On macOS the press that activates an inactive window reaches
 * the webContents only when the window accepts the first mouse, so every
 * window kind the gesture serves opts in at construction.
 */
const FIRST_MOUSE: Array<{ file: string; count: number; where: string }> = [
  { file: 'ipc.ts', count: 2, where: 'createHybridHostBaseWindow() and the window-open winOptions' },
  { file: 'tile-launcher.ts', count: 1, where: 'createTileBrowserWindow() baseline' },
];

describe('window construction — the activating press reaches the page', () => {
  for (const { file, count, where } of FIRST_MOUSE) {
    it(`${file}: ${where} accept the first mouse`, () => {
      const lines = readSourceLines(path.join(MAIN_SRC_DIR, file)).filter((l) => !isCommentLine(l));
      const found = lines.filter((l) => /^\s*acceptFirstMouse\s*:\s*true\b/.test(l)).length;
      assert.equal(found, count, `${file}: expected ${count} \`acceptFirstMouse: true\` (${where}), found ${found}`);
    });
  }
});

describe('window construction — scanner self-check', () => {
  it('the scanner sees the known construction sites', () => {
    const actual = scanInventory();
    const total = [...actual.values()].reduce((a, b) => a + b, 0);
    assert.ok(total > 0, 'scanned zero construction sites — the source path or the regex is broken');
    assert.ok(
      actual.has('tile-launcher.ts|BrowserWindow'),
      'tile-launcher.ts createTileBrowserWindow() was not seen — the scanner is not reading the main tree',
    );
  });

  it('the scanner skips commented-out construction sites', () => {
    assert.equal(countConstructions(['  // const win = new BrowserWindow({});']).size, 0);
    assert.equal(countConstructions([' * right after `new BrowserWindow()`.']).size, 0);
    assert.equal(countConstructions(['/* new BaseWindow({}) */']).size, 0);
    assert.equal(countConstructions(['  const win = new BrowserWindow({});']).get('BrowserWindow'), 1);
    assert.equal(countConstructions(['  const win = new BrowserWindowCtor(prefs);']).get('BrowserWindow'), 1);
  });
});

// ── helpers ────────────────────────────────────────────────────────────────

/** Map of `relativeFile|ConstructorFamily` → count, over the whole main tree. */
function scanInventory(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of walkSource(MAIN_SRC_DIR)) {
    if (isTestFile(file)) continue;
    const rel = relSource(file);
    for (const [ctor, n] of countConstructions(readSourceLines(file))) {
      const key = `${rel}|${ctor}`;
      counts.set(key, (counts.get(key) ?? 0) + n);
    }
  }
  return counts;
}

/** Per-constructor-family counts over the given source lines, comments excluded. */
function countConstructions(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    if (isCommentLine(line)) continue;
    for (const m of line.matchAll(CONSTRUCTION_RE)) {
      counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    }
  }
  return counts;
}

function expectedAsMap(): Map<string, number> {
  const m = new Map<string, number>();
  for (const row of EXPECTED) {
    const key = `${row.file}|${row.ctor}`;
    assert.ok(!m.has(key), `EXPECTED has a duplicate row for ${key}`);
    m.set(key, row.count);
  }
  return m;
}

function unionKeys(a: Map<string, number>, b: Map<string, number>): string[] {
  return [...new Set([...a.keys(), ...b.keys()])].sort();
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function isTestFile(file: string): boolean {
  return /\.test\.(ts|cts|js|mjs)$/.test(path.basename(file));
}

function relSource(file: string): string {
  return path.relative(MAIN_SRC_DIR, file).split(path.sep).join('/');
}

function readSourceLines(file: string): string[] {
  return fs.readFileSync(file, 'utf8').split('\n');
}

function* walkSource(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkSource(full);
    } else if (/\.(ts|cts|js|mjs)$/.test(entry.name)) {
      yield full;
    }
  }
}
