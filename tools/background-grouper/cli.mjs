#!/usr/bin/env node
// Usage: node tools/background-grouper/cli.mjs <database-copy> <report-path> [--days N] [--cutoff X] [--no-embed] [--model-cache DIR]
// Both paths must be outside the repository: they hold real browsing data.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGrouper, formatReport, DEFAULTS } from './grouper.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Resolve through symlinks as far as the path exists, so a link into the repo is caught. */
function realish(p) {
  let cur = path.resolve(p);
  const tail = [];
  while (!fs.existsSync(cur)) {
    tail.unshift(path.basename(cur));
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return path.join(fs.realpathSync(cur), ...tail);
}

export function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function assertOutsideRepo(p, label, root = REPO_ROOT) {
  if (isInside(realish(p), realish(root))) {
    throw new Error(`${label} is inside the repository (${p}); browsing data must stay outside it`);
  }
}

export function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days') opts.days = Number(argv[++i]);
    else if (a === '--cutoff') opts.cutoff = Number(argv[++i]);
    else if (a === '--no-embed') opts.noEmbed = true;
    else if (a === '--model-cache') opts.modelCache = argv[++i];
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else pos.push(a);
  }
  if (pos.length !== 2) throw new Error('expected <database-copy> <report-path>');
  for (const k of ['days', 'cutoff']) {
    if (k in opts && !(opts[k] > 0)) throw new Error(`--${k} must be a positive number`);
  }
  if ('modelCache' in opts && !opts.modelCache) throw new Error('--model-cache needs a directory');
  return { dbPath: pos[0], reportPath: pos[1], opts: { ...DEFAULTS, ...opts } };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    assertOutsideRepo(args.dbPath, 'database path');
    assertOutsideRepo(args.reportPath, 'report path');
    if (!fs.existsSync(args.dbPath)) throw new Error(`no such file: ${args.dbPath}`);
    if (args.opts.modelCache) assertOutsideRepo(args.opts.modelCache, 'model cache');
  } catch (e) {
    console.error(`background-grouper: ${e.message}`);
    console.error('usage: cli.mjs <database-copy> <report-path> [--days N] [--cutoff X] [--no-embed] [--model-cache DIR]');
    process.exit(2);
  }
  if (!args.opts.noEmbed) {
    const { createEmbedder, defaultCacheDir, MODEL } = await import('./embedder.mjs');
    const cacheDir = args.opts.modelCache || defaultCacheDir();
    assertOutsideRepo(cacheDir, 'model cache');
    args.opts.embed = await createEmbedder({ cacheDir });
    args.opts.embedModel = MODEL;
  }
  const result = await runGrouper(args.dbPath, args.opts);
  fs.writeFileSync(args.reportPath, formatReport(result, args.opts));
  console.log(`${result.groups.length} groups from ${result.stats.pages} pages; report written to ${args.reportPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
