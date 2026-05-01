#!/usr/bin/env node
/**
 * audit-tile-caps.js
 *
 * Scans every feature (manifestVersion === 3) under features/ and detects
 * all `api.*` call patterns in source files. Produces a markdown matrix of
 * which features use which shim surfaces, with per-method counts.
 *
 * Usage: node scripts/audit-tile-caps.js
 *
 * Output goes to stdout. Redirect to a file to capture:
 *   node scripts/audit-tile-caps.js > docs/tile-preload-trimming-matrix.md
 *
 * Idempotent — same input produces same output. Uses only stdlib.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '..');
const FEATURES_DIR = path.join(REPO_ROOT, 'features');

// Surfaces we detect. Order here controls the column order in the matrix.
// Each entry describes how to count + how to extract the method name.
const SURFACES = [
  { key: 'api.datastore',   label: 'api.datastore',   kind: 'method',  regex: /\bapi\.datastore\.([a-zA-Z_$][\w$]*)\s*\(/g },
  { key: 'api.pubsub',      label: 'api.pubsub',      kind: 'method',  regex: /\bapi\.pubsub\.([a-zA-Z_$][\w$]*)\s*\(/g },
  { key: 'api.subscribe',   label: 'api.subscribe',   kind: 'shim',    regex: /\bapi\.subscribe\s*\(/g },
  { key: 'api.publish',     label: 'api.publish',     kind: 'shim',    regex: /\bapi\.publish\s*\(/g },
  { key: 'api.window',      label: 'api.window',      kind: 'method',  regex: /\bapi\.window\.([a-zA-Z_$][\w$]*)\s*\(/g },
  { key: 'api.shortcuts',   label: 'api.shortcuts',   kind: 'method',  regex: /\bapi\.shortcuts\.([a-zA-Z_$][\w$]*)\s*\(/g },
  { key: 'api.settings',    label: 'api.settings',    kind: 'method',  regex: /\bapi\.settings\.([a-zA-Z_$][\w$]*)\s*\(/g },
  { key: 'api.context',     label: 'api.context',     kind: 'method',  regex: /\bapi\.context\.([a-zA-Z_$][\w$]*)\s*\(/g },
  { key: 'api.files',       label: 'api.files',       kind: 'method',  regex: /\bapi\.files\.([a-zA-Z_$][\w$]*)\s*\(/g },
  { key: 'api.modes',       label: 'api.modes',       kind: 'method',  regex: /\bapi\.modes\.([a-zA-Z_$][\w$]*)\s*\(/g },
  { key: 'api.closeWindow', label: 'api.closeWindow', kind: 'shim',    regex: /\bapi\.closeWindow\s*\(/g },
  { key: 'api.ipc',         label: 'api.ipc.invoke',  kind: 'method',  regex: /\bapi\.ipc\.([a-zA-Z_$][\w$]*)\s*\(/g },
  { key: 'api.debug',       label: 'api.debug',       kind: 'ref',     regex: /\bapi\.debug\b/g },
  { key: 'api.filesystem',  label: 'api.filesystem',  kind: 'method',  regex: /\bapi\.filesystem\.([a-zA-Z_$][\w$]*)\s*\(/g },
  { key: 'api.network',     label: 'api.network',     kind: 'method',  regex: /\bapi\.network\.([a-zA-Z_$][\w$]*)\s*\(/g },
  { key: 'api.theme',       label: 'api.theme',       kind: 'method',  regex: /\bapi\.theme\.([a-zA-Z_$][\w$]*)\s*\(/g },
  { key: 'api.sync',        label: 'api.sync',        kind: 'method',  regex: /\bapi\.sync\.([a-zA-Z_$][\w$]*)\s*\(/g },
  { key: 'api.scopes',      label: 'api.scopes',      kind: 'ref',     regex: /\bapi\.scopes\.([A-Z_]+)\b/g },
];

// Columns that count toward "total shim calls" in the summary.
// These are the shim surfaces that will eventually be removed (see
// tile-preload-trimming-plan.md section 1).
const SHIM_COLUMNS = new Set([
  'api.datastore',
  'api.subscribe',
  'api.publish',
  'api.shortcuts',
  'api.settings',   // getKey/setKey/getExtKey variants
  'api.context',
  'api.files',
  'api.modes',
  'api.closeWindow',
  'api.ipc',
  'api.debug',
]);

// Which column keys appear in the compact summary table (order matters).
const SUMMARY_COLUMNS = [
  'api.datastore',
  'api.pubsub',
  'api.subscribe',
  'api.publish',
  'api.window',
  'api.shortcuts',
  'api.settings',
  'api.context',
  'api.files',
  'api.ipc',
  'api.debug',
];

// File extensions we scan inside each feature directory.
const SCAN_EXTS = new Set(['.js', '.mjs', '.cjs', '.html', '.ts']);

function listFilesRecursively(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return out;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...listFilesRecursively(full));
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      if (SCAN_EXTS.has(ext)) out.push(full);
    }
  }
  return out;
}

function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function summarizeManifestCaps(manifest) {
  const caps = manifest && manifest.capabilities;
  if (!caps || typeof caps !== 'object') return '—';
  const parts = [];
  for (const key of Object.keys(caps).sort()) {
    const val = caps[key];
    if (val === true) {
      parts.push(key);
    } else if (val && typeof val === 'object') {
      if (Array.isArray(val.tables) && val.tables.length > 0) {
        parts.push(`${key}[${val.tables.join(', ')}]`);
      } else if (Array.isArray(val.topics) && val.topics.length > 0) {
        parts.push(`${key}[${val.topics.length} topics]`);
      } else {
        const sub = Object.keys(val).filter((k) => val[k] === true);
        if (sub.length > 0) parts.push(`${key}[${sub.join(', ')}]`);
        else parts.push(key);
      }
    }
  }
  return parts.length > 0 ? parts.join(', ') : '—';
}

function analyzeFeature(featureId) {
  const featureDir = path.join(FEATURES_DIR, featureId);
  const manifestPath = path.join(featureDir, 'manifest.json');
  const manifest = readJsonSafe(manifestPath);
  if (!manifest || manifest.manifestVersion !== 3) {
    return null;
  }

  const files = listFilesRecursively(featureDir);
  // Per-surface stats: { total, methods: Map<methodName, count> }
  const surfaceStats = new Map();
  for (const surf of SURFACES) {
    surfaceStats.set(surf.key, { total: 0, methods: new Map() });
  }

  for (const filePath of files) {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      continue;
    }
    for (const surf of SURFACES) {
      // Reset lastIndex because we use `g` flag and reuse the regex object.
      surf.regex.lastIndex = 0;
      const stats = surfaceStats.get(surf.key);
      let m;
      while ((m = surf.regex.exec(content)) !== null) {
        stats.total += 1;
        const method = surf.kind === 'method' || surf.kind === 'ref'
          ? (m[1] || '(ref)')
          : '(call)';
        stats.methods.set(method, (stats.methods.get(method) || 0) + 1);
      }
    }
  }

  return {
    id: featureId,
    manifest,
    surfaceStats,
    fileCount: files.length,
  };
}

function listV2Features() {
  let entries;
  try {
    entries = fs.readdirSync(FEATURES_DIR, { withFileTypes: true });
  } catch (err) {
    return [];
  }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith('.')) continue;
    const manifest = readJsonSafe(path.join(FEATURES_DIR, ent.name, 'manifest.json'));
    if (manifest && manifest.manifestVersion === 3) {
      out.push(ent.name);
    }
  }
  out.sort();
  return out;
}

function formatMethods(methodsMap) {
  // Sort by count desc then name asc for deterministic output.
  const entries = [...methodsMap.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  return entries.map(([name, count]) => `${name} (${count})`).join(', ');
}

function totalShimCalls(feature) {
  let total = 0;
  for (const key of SHIM_COLUMNS) {
    const stats = feature.surfaceStats.get(key);
    if (stats) total += stats.total;
  }
  return total;
}

function renderMatrix(features) {
  const lines = [];
  lines.push('# Tile API Usage Matrix');
  lines.push('');
  lines.push('Generated by `scripts/audit-tile-caps.js`. Input: every feature manifest + source files.');
  lines.push('');
  lines.push(`Features scanned: ${features.length}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  // Header
  const headerCols = ['Feature', 'Manifest caps', ...SUMMARY_COLUMNS.map((k) => {
    const s = SURFACES.find((surf) => surf.key === k);
    return s ? s.label : k;
  }), 'total shim calls'];
  lines.push('| ' + headerCols.join(' | ') + ' |');
  const align = ['---', '---', ...SUMMARY_COLUMNS.map(() => '---:'), '---:'];
  lines.push('| ' + align.join(' | ') + ' |');
  for (const feat of features) {
    const row = [feat.id, summarizeManifestCaps(feat.manifest)];
    for (const key of SUMMARY_COLUMNS) {
      const stats = feat.surfaceStats.get(key);
      row.push(String(stats ? stats.total : 0));
    }
    row.push(String(totalShimCalls(feat)));
    lines.push('| ' + row.join(' | ') + ' |');
  }
  lines.push('');

  // Aggregate totals across all features, per surface (all surfaces, not just summary columns).
  lines.push('## Aggregate totals (all surfaces)');
  lines.push('');
  lines.push('| Surface | Total call sites | Features using |');
  lines.push('| --- | ---: | ---: |');
  for (const surf of SURFACES) {
    let total = 0;
    let featuresUsing = 0;
    for (const feat of features) {
      const stats = feat.surfaceStats.get(surf.key);
      if (stats && stats.total > 0) {
        total += stats.total;
        featuresUsing += 1;
      }
    }
    lines.push(`| ${surf.label} | ${total} | ${featuresUsing} |`);
  }
  lines.push('');

  // Per-feature details.
  lines.push('## Per-feature details');
  lines.push('');
  for (const feat of features) {
    lines.push(`### ${feat.id}`);
    lines.push('');
    lines.push(`- Manifest capabilities: ${summarizeManifestCaps(feat.manifest)}`);
    lines.push(`- Files scanned: ${feat.fileCount}`);
    const hasAny = [...feat.surfaceStats.values()].some((s) => s.total > 0);
    if (!hasAny) {
      lines.push('- No `api.*` usage detected.');
      lines.push('');
      continue;
    }
    for (const surf of SURFACES) {
      const stats = feat.surfaceStats.get(surf.key);
      if (!stats || stats.total === 0) continue;
      if (surf.kind === 'shim') {
        lines.push(`- ${surf.label} (top-level shim): ${stats.total} calls`);
      } else if (surf.kind === 'ref') {
        const methodDetail = formatMethods(stats.methods);
        lines.push(`- ${surf.label} (${stats.total} references): ${methodDetail}`);
      } else {
        const methodDetail = formatMethods(stats.methods);
        lines.push(`- ${surf.label} (${stats.total} calls): ${methodDetail}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

function main() {
  const featureIds = listV2Features();
  const features = [];
  for (const id of featureIds) {
    const info = analyzeFeature(id);
    if (info) features.push(info);
  }
  const out = renderMatrix(features);
  process.stdout.write(out);
  if (!out.endsWith('\n')) process.stdout.write('\n');
}

main();
