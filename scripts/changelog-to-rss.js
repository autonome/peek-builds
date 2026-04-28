#!/usr/bin/env node
/**
 * changelog-to-rss.js
 *
 * Parses CHANGELOG.md and emits a rolling RSS 2.0 feed of the last N days
 * of changes (default: 7). One <item> per bullet under `### YYYY-MM-DD`
 * sub-headings (the post-2026-04-29 format). Older `## YYYY-MM-DD` weekly
 * sections are ignored — RSS is "what shipped recently", not the archive.
 *
 * Usage: node scripts/changelog-to-rss.js [input] [output] [--days N]
 *   input  - path to CHANGELOG.md  (default: CHANGELOG.md)
 *   output - path to RSS XML out   (default: docs/feed.xml)
 *   --days N - rolling window in days (default: 7)
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flagDaysIdx = process.argv.indexOf('--days');
const ROLLING_DAYS = flagDaysIdx >= 0 ? parseInt(process.argv[flagDaysIdx + 1], 10) : 7;

const inputPath = resolve(positional[0] || 'CHANGELOG.md');
const outputPath = resolve(positional[1] || 'docs/feed.xml');

const content = readFileSync(inputPath, 'utf-8');

function parseMetadata(text) {
  const match = text.match(/<!--\s*\n\s*@marss\s*\n([\s\S]*?)-->/);
  if (!match) {
    console.error('Warning: No @marss metadata block found in changelog');
    return { title: 'Changelog', link: '', description: '' };
  }
  const meta = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key && value) meta[key] = value;
  }
  return meta;
}

// Walk the file collecting per-bullet items under `### YYYY-MM-DD` sub-headings.
function parseBulletItems(text) {
  const lines = text.split('\n');
  const items = [];
  let currentDate = null;

  for (const line of lines) {
    const dayMatch = line.match(/^### (\d{4}-\d{2}-\d{2})\s*$/);
    if (dayMatch) {
      currentDate = dayMatch[1];
      continue;
    }
    // Reset on a new ## heading (week boundary or older format)
    if (/^## /.test(line)) {
      currentDate = null;
      continue;
    }
    if (!currentDate) continue;
    const bulletMatch = line.match(/^- (.+)$/);
    if (!bulletMatch) continue;
    items.push({ date: currentDate, body: bulletMatch[1].trim() });
  }

  return items;
}

function withinRollingWindow(items, days) {
  if (items.length === 0) return [];
  const newest = items
    .map((i) => i.date)
    .sort((a, b) => b.localeCompare(a))[0];
  const cutoff = new Date(newest + 'T12:00:00Z');
  cutoff.setUTCDate(cutoff.getUTCDate() - (days - 1));
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return items.filter((i) => i.date >= cutoffStr);
}

function markdownInlineToPlain(s) {
  return s
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function stableGuid(date, body) {
  const h = createHash('sha1').update(`${date}\n${body}`).digest('hex');
  return `urn:peek:changelog:${date}:${h.slice(0, 12)}`;
}

function generateRss(meta, items) {
  const now = new Date().toUTCString();

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(meta.title || 'Changelog')}</title>
    <link>${escapeXml(meta.link || '')}</link>
    <description>${escapeXml(meta.description || '')}</description>
    <lastBuildDate>${now}</lastBuildDate>
    <generator>changelog-to-rss.js</generator>
`;

  if (meta.link) {
    const feedUrl = meta.feedUrl || (meta.link ? meta.link + '/feed.xml' : '');
    xml += `    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml"/>\n`;
  }
  if (meta.language) {
    xml += `    <language>${escapeXml(meta.language)}</language>\n`;
  }
  if (meta.copyright) {
    xml += `    <copyright>${escapeXml(meta.copyright)}</copyright>\n`;
  }

  // Newest first
  const sorted = [...items].sort((a, b) =>
    a.date === b.date ? 0 : b.date.localeCompare(a.date),
  );

  for (const item of sorted) {
    const date = new Date(item.date + 'T12:00:00Z');
    const pubDate = date.toUTCString();
    const plain = markdownInlineToPlain(item.body);
    const title = plain.length > 200 ? plain.slice(0, 197) + '...' : plain;
    const guid = stableGuid(item.date, item.body);
    const itemLink = (meta.link || '') + '/blob/main/CHANGELOG.md#' + item.date;

    xml += `    <item>
      <title>${escapeXml(title)}</title>
      <link>${escapeXml(itemLink)}</link>
      <guid isPermaLink="false">${escapeXml(guid)}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${escapeXml(plain)}</description>
    </item>
`;
  }

  xml += `  </channel>
</rss>
`;
  return xml;
}

const meta = parseMetadata(content);
const allItems = parseBulletItems(content);
const items = withinRollingWindow(allItems, ROLLING_DAYS);

if (items.length === 0) {
  console.error(
    `Warning: No bullets found within last ${ROLLING_DAYS} days under ### YYYY-MM-DD sub-headings.`,
  );
}

const rss = generateRss(meta, items);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, rss, 'utf-8');

console.log(`Generated RSS feed: ${outputPath} (${items.length} items, ${ROLLING_DAYS}-day window)`);
