import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, renderReport } from './core/index.js';
import { loadSnapshot } from './load-snapshot.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// Resolve symlinks in the deepest part of the path that exists, so a link into the repo is still caught.
function realish(p) {
  let abs = resolve(p);
  const tail = [];
  while (!existsSync(abs) && dirname(abs) !== abs) {
    tail.unshift(abs.slice(dirname(abs).length + 1));
    abs = dirname(abs);
  }
  return join(realpathSync(abs), ...tail);
}

function repoRoot() {
  try {
    return realpathSync(
      execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(),
    );
  } catch {
    return null;
  }
}

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');

function main() {
  const snapshot = process.env.ACTIVITY_SNAPSHOT;
  const outEnv = process.env.ACTIVITY_OUT;
  if (!snapshot || !outEnv) {
    console.error('Set ACTIVITY_SNAPSHOT (path to a datastore snapshot) and ACTIVITY_OUT (output directory).');
    return 2;
  }
  const out = realish(outEnv);
  const root = repoRoot();
  if (root && (out === root || out.startsWith(root + sep))) {
    console.error('Refusing to write inside the git repo: outputs contain personal data. Point ACTIVITY_OUT elsewhere.');
    return 2;
  }

  const { tables, results } = analyze(loadSnapshot(snapshot));
  mkdirSync(out, { recursive: true });
  const { labels, ...flat } = tables;
  for (const [name, rows] of Object.entries(flat)) writeFileSync(join(out, `${name}.jsonl`), jsonl(rows));
  const labelRows = [
    ...labels.topical.map((l) => ({ kind: 'topical', ...l })),
    ...labels.feedback.map((l) => ({ kind: 'feedback', ...l })),
  ];
  writeFileSync(join(out, 'labels.jsonl'), jsonl(labelRows));
  writeFileSync(join(out, 'report.md'), renderReport(results));
  writeFileSync(join(out, 'report.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(`Wrote ${results.length} probes to ${out}`);
  return 0;
}

process.exitCode = main();
