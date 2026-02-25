#!/usr/bin/env node
/**
 * changelog-to-rss.js
 *
 * Parses CHANGELOG.md and generates an RSS 2.0 feed XML file.
 *
 * Expected CHANGELOG.md format:
 * - HTML comment block with @marss metadata (title, link, description)
 * - Level-2 headings (##) with ISO dates (YYYY-MM-DD) as feed items
 * - Content under each heading becomes the item description
 *
 * Usage: node scripts/changelog-to-rss.js [input] [output]
 *   input  - path to CHANGELOG.md (default: CHANGELOG.md)
 *   output - path to RSS XML output (default: docs/feed.xml)
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const inputPath = resolve(process.argv[2] || 'CHANGELOG.md');
const outputPath = resolve(process.argv[3] || 'docs/feed.xml');

const content = readFileSync(inputPath, 'utf-8');

// Parse @marss metadata from HTML comment
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

// Parse level-2 headings and their content as feed items
function parseItems(text) {
  const items = [];
  // Split on ## headings (level 2 only, not ### or #)
  const parts = text.split(/^## /m);

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const newlineIdx = part.indexOf('\n');
    if (newlineIdx === -1) continue;

    const heading = part.slice(0, newlineIdx).trim();
    const body = part.slice(newlineIdx + 1).trim();

    // Extract date from heading - expect YYYY-MM-DD
    const dateMatch = heading.match(/(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) continue; // Skip headings without dates

    const dateStr = dateMatch[1];
    const date = new Date(dateStr + 'T12:00:00Z');

    // Title: use the heading text (may include more than just the date)
    const title = heading;

    // Convert markdown body to plain text for RSS description
    const description = markdownToPlainText(body);

    items.push({ title, date, dateStr, description });
  }

  return items;
}

// Convert markdown to plain text for RSS descriptions
function markdownToPlainText(md) {
  let text = md
    // Convert markdown links to "text (URL)" format
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    // Remove checkboxes
    .replace(/^- \[x\] /gm, '- ')
    .replace(/^- \[ \] /gm, '- ')
    // Remove bold markers
    .replace(/\*\*(.+?)\*\*/g, '$1')
    // Remove italic markers
    .replace(/\*(.+?)\*/g, '$1')
    // Remove inline code backticks
    .replace(/`([^`]+)`/g, '$1')
    // Collapse multiple blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

// Escape XML special characters
function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Generate RSS 2.0 XML
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
  if (meta.imageUrl) {
    xml += `    <image>\n      <url>${escapeXml(meta.imageUrl)}</url>\n      <title>${escapeXml(meta.title || 'Changelog')}</title>\n      <link>${escapeXml(meta.link || '')}</link>\n    </image>\n`;
  }

  for (const item of items) {
    const pubDate = item.date.toUTCString();
    const guid = (meta.link || 'urn:changelog') + '#' + item.dateStr;

    xml += `    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml((meta.link || '') + '/raw/main/CHANGELOG.md#' + item.dateStr)}</link>
      <guid isPermaLink="false">${escapeXml(guid)}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${escapeXml(item.description)}</description>
    </item>
`;
  }

  xml += `  </channel>
</rss>
`;

  return xml;
}

// Main
const meta = parseMetadata(content);
const items = parseItems(content);

if (items.length === 0) {
  console.error('Warning: No feed items found (no ## headings with dates)');
}

const rss = generateRss(meta, items);

// Ensure output directory exists
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, rss, 'utf-8');

console.log(`Generated RSS feed: ${outputPath} (${items.length} items)`);
