#!/usr/bin/env node
/**
 * changelog-bump.js
 *
 * Reads git log between the last-bumped marker and the upper-bound ref
 * (default `main`), generates terse one-line bullets clustered by
 * (type, area, day), and merges them into CHANGELOG.md under
 * `## Week of YYYY-MM-DD (Wnn)` / `### YYYY-MM-DD`.
 *
 * Usage:
 *   node scripts/changelog-bump.js [--dry-run] [--since <commit>] [--up-to <ref>]
 *
 *   --up-to defaults to `main`. Pass a feature branch (e.g. `mcp-llm-policy`)
 *   to bump BEFORE finalizing main onto a stack — that way the bump commit
 *   joins the feature stack and a single finalize covers everything. After
 *   main has been advanced onto the stack, the default `main` is correct.
 *
 * Marker:
 *   `<!-- last-bumped: <commit-short-id> -->` — first match in CHANGELOG.md.
 *   On success, the marker is rewritten to the upper-bound ref's HEAD.
 *
 * Skip rules (commit titles):
 *   - chore(*)
 *   - test(*)
 *   - docs(changelog)
 *   - "(working copy)" / "(no description set)"
 *
 * Clustering:
 *   - Same (area, type, day) → one bullet.
 *   - Phase rollup: ≥2 commits whose subjects match `Phase \d+` → one bullet
 *     with the trailing "(Phases X–Y)" suffix.
 *
 * Output bullet form:
 *   - `{area}: {subject}` (type prefix dropped)
 *   - For phase rollups, the leading "Phase N — " is stripped from subject.
 *
 * After mutation, runs `yarn rss` to regenerate the feed.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const CHANGELOG_PATH = resolve('CHANGELOG.md');
const MARKER_RE = /<!--\s*last-bumped:\s*([a-f0-9]+)\s*-->/;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const sinceArgIdx = args.indexOf('--since');
const SINCE_OVERRIDE = sinceArgIdx >= 0 ? args[sinceArgIdx + 1] : null;
const upToArgIdx = args.indexOf('--up-to');
const UP_TO = upToArgIdx >= 0 ? args[upToArgIdx + 1] : 'main';

const SKIP_TYPES = new Set(['chore', 'test']);

function readChangelog() {
  return readFileSync(CHANGELOG_PATH, 'utf-8');
}

function findMarker(content) {
  const m = content.match(MARKER_RE);
  return m ? m[1] : null;
}

function getRevHead(rev) {
  const out = execSync(`git rev-parse --short ${rev}`, {
    encoding: 'utf-8',
  });
  return out.trim();
}

function getCommits(sinceCommit, upTo) {
  // Tab-separated: short_id \t ISO timestamp \t description first line
  const range = `${sinceCommit}..${upTo}`;
  const cmd = `git log --reverse --pretty=format:'%h%x09%aI%x09%s' ${range}`;
  let out;
  try {
    out = execSync(cmd, { encoding: 'utf-8' });
  } catch (err) {
    throw new Error(`git log failed for range ${range}: ${err.message}`);
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const idx1 = line.indexOf('\t');
      const idx2 = line.indexOf('\t', idx1 + 1);
      return {
        commit: line.slice(0, idx1),
        ts: line.slice(idx1 + 1, idx2),
        subject: line.slice(idx2 + 1),
      };
    });
}

function parseSubject(line) {
  // Match: type(area)?: subject  OR  type!: subject  OR  type: subject
  const m = line.match(/^(\w+)(?:\(([^)]+)\))?!?\s*:\s*(.+)$/);
  if (!m) return { type: '', area: '', subject: line };
  return { type: m[1], area: m[2] || '', subject: m[3] };
}

function shouldSkip(parsed, raw) {
  if (!raw || raw.startsWith('(working copy)') || raw === '(no description set)') return true;
  if (raw.startsWith('(empty)')) return true;
  if (SKIP_TYPES.has(parsed.type)) return true;
  if (parsed.type === 'docs' && parsed.area === 'changelog') return true;
  return false;
}

function getDayFromTs(ts) {
  return ts.slice(0, 10);
}

function getISOWeek(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((d.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7,
  );
  return week;
}

function getMondayOfWeek(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum);
  return d.toISOString().slice(0, 10);
}

function clusterCommits(commits) {
  const enriched = commits
    .map((c) => {
      const p = parseSubject(c.subject);
      return { ...c, ...p, day: getDayFromTs(c.ts) };
    })
    .filter((c) => !shouldSkip(c, c.subject));

  const clusters = [];
  for (const c of enriched) {
    const last = clusters[clusters.length - 1];
    if (last && last.area === c.area && last.type === c.type && last.day === c.day) {
      last.commits.push(c);
    } else {
      clusters.push({ area: c.area, type: c.type, day: c.day, commits: [c] });
    }
  }
  return clusters;
}

function renderBullet(cluster) {
  const last = cluster.commits[cluster.commits.length - 1];
  let subject = last.subject;

  const phaseNums = cluster.commits
    .map((c) => {
      const m = c.subject.match(/Phase\s+(\d+)/i);
      return m ? parseInt(m[1], 10) : null;
    })
    .filter((n) => n !== null);

  if (phaseNums.length >= 2) {
    const min = Math.min(...phaseNums);
    const max = Math.max(...phaseNums);
    subject = subject.replace(/Phase\s+\d+\s*[—–\-:]\s*/i, '');
    subject = subject.charAt(0).toLowerCase() + subject.slice(1);
    subject = `${subject} (Phases ${min}–${max})`;
  }

  const label = cluster.area || cluster.type || 'misc';
  return `- ${label}: ${subject}`;
}

function groupClustersByDay(clusters) {
  const days = new Map();
  for (const cl of clusters) {
    if (!days.has(cl.day)) days.set(cl.day, []);
    days.get(cl.day).push(cl);
  }
  return [...days.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}

function findHeadingPosition(content, headingRegex) {
  const m = content.match(headingRegex);
  if (!m) return -1;
  return m.index;
}

function findEndOfSection(content, startIdx, sectionLevel) {
  // Find the next heading at the same or higher level (fewer #).
  // For ## section: stop at next ## or # (or EOF).
  // For ### section: stop at next ### or ## or # (or EOF).
  const lines = content.slice(startIdx).split('\n');
  let offset = 0;
  // Skip the heading line itself
  if (lines.length > 0) offset = lines[0].length + 1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#')) {
      const headingHashes = line.match(/^#+/)[0].length;
      if (headingHashes <= sectionLevel) {
        return startIdx + offset;
      }
    }
    offset += line.length + 1;
  }
  return content.length;
}

function mergeIntoChangelog(content, daysData) {
  // daysData: [[day, [bullets]], ...] in descending day order
  let result = content;

  // Process oldest day first so newer days end up at the top after each prepend.
  const ordered = [...daysData].reverse();

  for (const [day, bullets] of ordered) {
    const monday = getMondayOfWeek(day);
    const week = getISOWeek(day);
    const weekHeading = `## Week of ${monday} (W${String(week).padStart(2, '0')})`;
    const dayHeading = `### ${day}`;

    const weekRe = new RegExp(`^${escapeRegex(weekHeading)}\\s*$`, 'm');
    const dayRe = new RegExp(`^${escapeRegex(dayHeading)}\\s*$`, 'm');

    const weekMatch = result.match(weekRe);

    if (weekMatch) {
      // Week section exists. Find day sub-section under it.
      const weekStart = weekMatch.index;
      const weekEnd = findEndOfSection(result, weekStart, 2);
      const weekBody = result.slice(weekStart, weekEnd);

      const dayMatch = weekBody.match(dayRe);
      if (dayMatch) {
        // Day section exists in week. Prepend bullets just below the day heading.
        const absoluteDayStart = weekStart + dayMatch.index;
        const dayHeadingEnd = absoluteDayStart + dayHeading.length;
        // Insert bullets right after heading + newline; keep existing bullets below.
        const before = result.slice(0, dayHeadingEnd);
        const after = result.slice(dayHeadingEnd);
        const insertion = '\n\n' + bullets.join('\n');
        // after starts with \n, possibly \n\n... we want to drop the first \n\n if present
        // and just put a single \n\n separator before existing bullets.
        const trimmedAfter = after.replace(/^\n+/, '');
        result = before + insertion + '\n\n' + trimmedAfter;
      } else {
        // Create new day section as the first day under this week.
        const weekHeadingEnd = weekStart + weekHeading.length;
        const before = result.slice(0, weekHeadingEnd);
        const after = result.slice(weekHeadingEnd);
        const trimmedAfter = after.replace(/^\n+/, '');
        const insertion = '\n\n' + dayHeading + '\n\n' + bullets.join('\n');
        result = before + insertion + '\n\n' + trimmedAfter;
      }
    } else {
      // Create new week section before the first existing ## heading.
      const firstHeadingIdx = findFirstSectionHeading(result);
      const block = `${weekHeading}\n\n${dayHeading}\n\n${bullets.join('\n')}\n\n`;
      if (firstHeadingIdx === -1) {
        // No existing sections; append.
        result = result.replace(/\s*$/, '\n\n' + block);
      } else {
        result = result.slice(0, firstHeadingIdx) + block + result.slice(firstHeadingIdx);
      }
    }
  }

  return result;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findFirstSectionHeading(content) {
  const m = content.match(/^## /m);
  return m ? m.index : -1;
}

function updateMarker(content, newCommit) {
  const marker = `<!-- last-bumped: ${newCommit} -->`;
  if (MARKER_RE.test(content)) {
    return content.replace(MARKER_RE, marker);
  }
  // Insert marker right after the @marss block (or at top after the H1).
  const marsEnd = content.indexOf('-->');
  if (marsEnd !== -1) {
    const insertAt = marsEnd + 3;
    return content.slice(0, insertAt) + '\n' + marker + content.slice(insertAt);
  }
  return marker + '\n' + content;
}

function main() {
  const content = readChangelog();
  const marker = SINCE_OVERRIDE || findMarker(content);
  if (!marker) {
    console.error(
      'No <!-- last-bumped: <commit> --> marker found in CHANGELOG.md.\n' +
        'First run: pass --since <commit-short-id> to bootstrap.',
    );
    process.exit(2);
  }

  const head = getRevHead(UP_TO);
  if (head === marker) {
    console.log(`No new commits since ${marker}; nothing to bump.`);
    return;
  }

  const commits = getCommits(marker, UP_TO);
  if (commits.length === 0) {
    console.log(`No commits in ${marker}..${UP_TO}; nothing to bump.`);
    return;
  }

  const clusters = clusterCommits(commits);
  if (clusters.length === 0) {
    console.log(
      `${commits.length} commits in range, but all filtered out (chore/test/docs(changelog)/etc).`,
    );
    if (!DRY_RUN) {
      const updated = updateMarker(content, head);
      writeFileSync(CHANGELOG_PATH, updated, 'utf-8');
      console.log(`Updated marker to ${head}.`);
    }
    return;
  }

  const daysData = groupClustersByDay(clusters).map(([day, cls]) => [
    day,
    cls.map(renderBullet),
  ]);

  if (DRY_RUN) {
    console.log('--- DRY RUN ---');
    for (const [day, bullets] of daysData) {
      const monday = getMondayOfWeek(day);
      const week = getISOWeek(day);
      console.log(`\n## Week of ${monday} (W${String(week).padStart(2, '0')})\n`);
      console.log(`### ${day}\n`);
      console.log(bullets.join('\n'));
    }
    console.log(`\n--- (would advance marker ${marker} → ${head}) ---`);
    return;
  }

  let updated = mergeIntoChangelog(content, daysData);
  updated = updateMarker(updated, head);
  writeFileSync(CHANGELOG_PATH, updated, 'utf-8');

  const totalBullets = daysData.reduce((sum, [, bs]) => sum + bs.length, 0);
  console.log(
    `Bumped ${totalBullets} bullet(s) across ${daysData.length} day(s); marker now ${head}.`,
  );

  // Regenerate RSS
  try {
    execSync('node scripts/changelog-to-rss.js', { stdio: 'inherit' });
  } catch (err) {
    console.error('Warning: yarn rss / changelog-to-rss.js failed:', err.message);
  }
}

main();
