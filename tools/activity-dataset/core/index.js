import { normalize } from './normalize.js';
import * as bursts from './probes/bursts.js';
import * as combinedGroups from './probes/combined-groups.js';
import * as entityGroups from './probes/entity-groups.js';
import * as forgottenSaves from './probes/forgotten-saves.js';
import * as habits from './probes/habits.js';
import * as interests from './probes/interests.js';
import * as notesToPages from './probes/notes-to-pages.js';
import * as sessionGroups from './probes/session-groups.js';
import * as textSimilarity from './probes/text-similarity.js';

export { normalize };

export const PROBES = [
  entityGroups,
  textSimilarity,
  sessionGroups,
  combinedGroups,
  interests,
  bursts,
  forgottenSaves,
  notesToPages,
  habits,
];

export function runProbes(tables, options = {}) {
  return PROBES.map((probe) => probe.run(tables, options));
}

export function analyze(raw, options = {}) {
  const tables = normalize(raw);
  return { tables, results: runProbes(tables, options) };
}

const fmt = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : v == null ? '' : String(v));
const cell = (v) => fmt(v).replace(/\|/g, '\\|').replace(/\s+/g, ' ');

function table(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n');
}

// Row values shown in report.md: scalars as-is, lists as a count or a short joined string.
function flattenRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.endsWith('Id') || k === 'id') continue;
    if (Array.isArray(v)) out[k] = k === 'titles' ? v.slice(0, 3).join('; ') : v.length;
    else if (v && typeof v === 'object') continue;
    else out[k] = v;
  }
  return out;
}

export function renderReport(results, { topRows = 10 } = {}) {
  const lines = ['# Activity dataset report', ''];
  lines.push(
    table(
      ['probe', 'summary', 'purity', 'coverage', 'groups', 'precisionAt5'],
      results.map((r) => {
        const s = r.score ?? {};
        const summary = Object.entries(r.summary)
          .map(([k, v]) => `${k}=${fmt(v)}`)
          .join(' ');
        return [r.name, summary, s.purity, s.coverage, s.groups, s.precisionAt5];
      }),
    ),
  );
  for (const r of results) {
    lines.push('', `## ${r.name}`, '');
    if (!r.rows.length) {
      lines.push(r.summary.skipped ? `Skipped: ${r.summary.skipped}.` : 'No rows.');
      continue;
    }
    const flat = r.rows.slice(0, topRows).map(flattenRow);
    const headers = [...new Set(flat.flatMap((row) => Object.keys(row)))];
    lines.push(table(headers, flat.map((row) => headers.map((h) => row[h]))));
  }
  return lines.join('\n') + '\n';
}
