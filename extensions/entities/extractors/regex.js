/**
 * Regex-based entity extractors
 *
 * Extracts emails, phone numbers, dates (with event/label context),
 * prices (with product context), addresses, tracking numbers, and
 * person names (lightweight NER using name database) from page text
 * content using regular expressions.
 */

import { ensureNameDatabase, isKnownFirstName, isLikelyPersonName } from '../name-validator.js';

// Email pattern
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

// Phone pattern - international and US formats
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}|\+\d{1,3}[-.\s]?\d{1,4}[-.\s]?\d{1,4}[-.\s]?\d{1,9}/g;

// Date patterns - common formats
const DATE_PATTERNS = [
  // ISO: 2026-02-10
  /\b\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b/g,
  // US: February 10, 2026 or Feb 10, 2026
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{1,2},?\s+\d{4}\b/gi,
  // EU: 10 February 2026
  /\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{4}\b/gi,
  // Slash: 02/10/2026 or 10/02/2026
  /\b(?:0[1-9]|1[0-2])\/(?:0[1-9]|[12]\d|3[01])\/\d{4}\b/g,
];

// Price/currency pattern - used with exec() to get match positions for context extraction.
// Prices are only extracted when associated with a nearby product/service name.
const PRICE_CONTEXT_RE = /(?:\$|EUR|GBP|USD|CAD|AUD|JPY|CHF)\s?[\d,]+(?:\.\d{2})?|\d+(?:,\d{3})*(?:\.\d{2})?\s?(?:USD|EUR|GBP|CAD|AUD|JPY|CHF)/gi;

// US/international street address pattern
// Matches patterns like "123 Main St", "456 Oak Avenue, Suite 200"
const ADDRESS_RE = /\b\d{1,5}\s+(?:[A-Z][a-zA-Z]*\s*){1,4}(?:Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Road|Rd|Lane|Ln|Way|Court|Ct|Place|Pl|Circle|Cir|Trail|Trl|Parkway|Pkwy|Highway|Hwy)\.?(?:\s*,?\s*(?:Suite|Ste|Apt|Unit|#)\s*\w+)?\b/gi;

// Tracking number patterns
const TRACKING_PATTERNS = [
  // UPS
  { carrier: 'UPS', pattern: /\b1Z[A-Z0-9]{16}\b/g },
  // FedEx
  { carrier: 'FedEx', pattern: /\b\d{12,22}\b/g },
  // USPS
  { carrier: 'USPS', pattern: /\b(?:9[234]|7[01])\d{20,22}\b/g },
];

// Person name pattern: 2-3 capitalized words, with optional nobiliary particles
// Matches: "John Smith", "Maria van den Berg", "Jean de la Cruz"
const PERSON_NAME_RE = /\b[A-Z][a-z]+(?:\s+(?:van|de|den|von|el|al|ibn|la|del|di|du|le|da)\s+)?(?:\s+(?:van|de|den|von|el|al|ibn|la|del|di|du|le|da)\s+)?[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g;

// Common false positive words that form capitalized sequences but aren't person names
const NER_FALSE_POSITIVES = new Set([
  'new york', 'los angeles', 'san francisco', 'san diego', 'san jose',
  'las vegas', 'el paso', 'santa cruz', 'santa monica', 'santa barbara',
  'united states', 'united kingdom', 'south africa', 'north america',
  'south america', 'north carolina', 'south carolina', 'west virginia',
  'north dakota', 'south dakota', 'new zealand', 'new hampshire',
  'new jersey', 'new mexico', 'new orleans', 'costa rica',
  'hong kong', 'sri lanka', 'puerto rico', 'buenos aires',
  'terms of service', 'privacy policy', 'read more', 'learn more',
  'sign up', 'log in', 'sign in', 'click here', 'find out',
  'get started', 'contact us', 'about us', 'see more', 'view all',
  'share this', 'follow us', 'join us', 'free shipping',
  'add to cart', 'buy now', 'next page', 'last updated',
  'all rights reserved', 'no comments', 'related posts',
]);

/**
 * Extract the meaningful context/label near a date match.
 * Looks at the text before the date (up to 80 chars) for an event name, deadline,
 * appointment, or other meaningful label. Returns null if no useful context is found.
 * @param {string} text - Full text
 * @param {number} matchIndex - Index of the date match in text
 * @returns {string|null} Context label or null
 */
function extractDateContext(text, matchIndex) {
  // Look at text before the date (up to 80 chars)
  const beforeStart = Math.max(0, matchIndex - 80);
  const before = text.slice(beforeStart, matchIndex).trim();

  // Split by common delimiters (newlines, bullets, pipes, dashes, commas, semicolons)
  const segments = before.split(/[\n\r|•·–—,;]/).filter(s => s.trim().length > 0);
  const lastSegment = (segments.length > 0 ? segments[segments.length - 1] : '').trim();

  if (!lastSegment || lastSegment.length < 2) return null;

  // Remove trailing noise phrases that sit between a label and the date.
  // Use word boundary (\b) to avoid partial-word matches (e.g., "at" inside "createdAt").
  const cleaned = lastSegment
    .replace(/\s*\b(?:on|at|from|until|by|before|after|due|date|posted|published|updated|created|scheduled\s+for|starts?|ends?|beginning|starting|ending)\b\s*:?\s*$/i, '')
    .replace(/\s*[-:]\s*$/, '')
    .trim();

  // Reject if what remains is too short or is just numbers/punctuation
  if (!cleaned || cleaned.length < 2) return null;
  if (/^[\d\s.,;:!?$%/\-]+$/.test(cleaned)) return null;

  // Reject generic noise words that don't constitute meaningful context
  const noiseWords = /^(?:the|a|an|and|or|for|to|in|on|at|is|it|was|has|this|that|our|your|last|next|from|also|see|more|view|click|here|back|page|home|menu)\s*$/i;
  if (noiseWords.test(cleaned)) return null;

  // Reject metadata-like prefixes (createdAt, updatedAt, publishedAt, etc.)
  if (/^(?:createdAt|updatedAt|modifiedAt|publishedAt|deletedAt|syncedAt|lastModified|timestamp|datetime|created|updated|modified|published|deleted)\s*$/i.test(cleaned)) return null;

  // Reject filesystem/directory listing noise:
  // - ends with "/" (directory name, e.g. "elephant/")
  // - looks like a filename (word.ext)
  // - single token without spaces (likely an identifier, not meaningful context)
  if (/\/$/.test(cleaned)) return null;
  if (/^[\w.-]+\.\w{1,5}$/.test(cleaned)) return null;
  if (!/\s/.test(cleaned) && cleaned.length < 15) return null;

  // Take up to ~60 chars, trim to last word boundary
  let label = cleaned.slice(-60).trim();
  if (cleaned.length > 60) {
    const spaceIdx = label.indexOf(' ');
    if (spaceIdx > 0) label = label.slice(spaceIdx + 1);
  }

  return label || null;
}

/**
 * Extract the likely product/subject name near a price match.
 * Looks at the text before the price (up to 80 chars) for meaningful words.
 * Returns null if no useful context is found.
 * @param {string} text - Full text
 * @param {number} matchIndex - Index of the price match in text
 * @returns {string|null} Product/subject name or null
 */
function extractPriceContext(text, matchIndex) {
  // Look at text before the price (up to 80 chars)
  const beforeStart = Math.max(0, matchIndex - 80);
  const before = text.slice(beforeStart, matchIndex).trim();

  // Also look at text after the price (up to 40 chars) for patterns like "$9.99/month"
  const afterEnd = Math.min(text.length, matchIndex + 30);
  const after = text.slice(matchIndex, afterEnd);

  // Try to find a product-like noun phrase in the preceding text.
  // Split by common delimiters (newlines, bullets, pipes, dashes used as separators)
  const segments = before.split(/[\n\r|•·–—]/).filter(s => s.trim().length > 0);
  const lastSegment = (segments.length > 0 ? segments[segments.length - 1] : '').trim();

  if (!lastSegment || lastSegment.length < 2) return null;

  // Remove trailing noise phrases like "starting at", "from", "only", "just", "price:", etc.
  // These appear between the product name and the price.
  const cleaned = lastSegment
    .replace(/\s*(?:starting\s+(?:at|from)|starts?\s+at|from|only|just|price\s*:|cost\s*:|for\s+(?:just|only))\s*$/i, '')
    .replace(/\s*[-:]\s*$/, '') // Remove trailing dash or colon separators
    .trim();

  // Reject if what remains is too short or is just numbers/punctuation
  if (!cleaned || cleaned.length < 2) return null;
  if (/^[\d\s.,;:!?$%]+$/.test(cleaned)) return null;

  // Reject if it looks like generic navigation/UI text
  const noiseWords = /^(?:home|menu|cart|checkout|login|sign\s*in|search|buy|add|view|more|see|get|shop|order|click|here|back|next|previous|the|a|an|and|or|for|to|in|on|at|is|it)\s*$/i;
  if (noiseWords.test(cleaned)) return null;

  // Take up to ~60 chars, trim to last word boundary
  let name = cleaned.slice(-60).trim();
  // If we cut mid-word, trim to last space
  if (cleaned.length > 60) {
    const spaceIdx = name.indexOf(' ');
    if (spaceIdx > 0) name = name.slice(spaceIdx + 1);
  }

  return name || null;
}

/**
 * Extract person names from text using lightweight NER.
 * Scans for capitalized word sequences (2-3 words) where the first word
 * matches a known first name from the name database.
 * Confidence is set just above the minimum threshold (0.71).
 * @param {string} text - Text content to scan
 * @param {string} url - Source URL for context
 * @returns {Array<Object>} Extracted person entities
 */
function extractPersonNames(text, url) {
  const entities = [];
  const seen = new Set();

  PERSON_NAME_RE.lastIndex = 0;
  let match;
  while ((match = PERSON_NAME_RE.exec(text)) !== null) {
    const name = match[0].trim();

    // Deduplicate
    const nameKey = name.toLowerCase();
    if (seen.has(nameKey)) continue;

    // Filter common false positives
    if (NER_FALSE_POSITIVES.has(nameKey)) continue;

    // First word must be a known first name
    const firstWord = name.split(/\s+/)[0];
    if (!isKnownFirstName(firstWord)) continue;

    // Double-check with isLikelyPersonName for extra validation
    const check = isLikelyPersonName(name);
    if (!check.likely) continue;

    seen.add(nameKey);
    entities.push({
      name,
      entityType: 'person',
      confidence: 0.71,
      extractor: 'regex-ner',
      attributes: {},
      sourceUrl: url
    });
  }

  return entities;
}

/**
 * Extract all regex-based entities from text content
 * @param {string} text - Text content to scan
 * @param {string} url - Source URL for context
 * @returns {Array<Object>} Extracted entities
 */
export function extractRegexEntities(text, url) {
  if (!text || typeof text !== 'string') return [];

  const entities = [];

  // Extract emails (filter automated/system addresses)
  const BLOCKED_EMAIL_PREFIXES = [
    'noreply', 'no-reply', 'no_reply', 'donotreply', 'do-not-reply', 'do_not_reply',
    'notification', 'notifications', 'automated', 'mailer-daemon', 'postmaster',
    'webmaster', 'hostmaster', 'abuse', 'bounce', 'auto', 'daemon',
  ];
  const emails = text.match(EMAIL_RE) || [];
  const seenEmails = new Set();
  for (const email of emails) {
    const normalized = email.toLowerCase();
    if (seenEmails.has(normalized)) continue;
    seenEmails.add(normalized);
    // Skip automated/system email addresses
    const localPart = normalized.split('@')[0];
    if (BLOCKED_EMAIL_PREFIXES.some(p => localPart === p || localPart.startsWith(p + '+'))) continue;
    entities.push({
      name: normalized,
      entityType: 'email',
      confidence: 0.9,
      extractor: 'regex',
      attributes: { address: normalized, domain: normalized.split('@')[1] },
      sourceUrl: url
    });
  }

  // Extract phone numbers — require formatting (separators, parens, or + prefix).
  // A bare sequence of digits is NOT a phone number.
  const phones = text.match(PHONE_RE) || [];
  const seenPhones = new Set();
  for (const phone of phones) {
    const trimmed = phone.trim();
    const digitsOnly = trimmed.replace(/\D/g, '');
    // Skip numbers that are too short (likely not phone numbers)
    if (digitsOnly.length < 7) continue;
    // Require at least one formatting character (dash, dot, space, paren, plus).
    // Bare digit sequences like "2262633506" are not phone numbers.
    if (/^\d+$/.test(trimmed)) continue;
    const normalized = trimmed.replace(/[\s.\-()]/g, '');
    if (seenPhones.has(normalized)) continue;
    seenPhones.add(normalized);
    entities.push({
      name: trimmed,
      entityType: 'phone',
      confidence: 0.7,
      extractor: 'regex',
      attributes: { number: trimmed },
      sourceUrl: url
    });
  }

  // Date and price regex extraction DISABLED — too noisy.
  // The date regex pulls surrounding garbage text as "context" (e.g. sports match titles).
  // The price regex matches currency codes in non-price contexts (e.g. "2025 AUD" as a price).
  // Dates and prices from structured data (JSON-LD) are still extracted by other extractors.

  // Extract street addresses
  ADDRESS_RE.lastIndex = 0;
  const addresses = text.match(ADDRESS_RE) || [];
  const seenAddresses = new Set();
  for (const addr of addresses) {
    const normalized = addr.trim().replace(/\s+/g, ' ');
    const key = normalized.toLowerCase();
    if (seenAddresses.has(key)) continue;
    seenAddresses.add(key);
    entities.push({
      name: normalized,
      entityType: 'place',
      confidence: 0.6,
      extractor: 'regex',
      attributes: { address: normalized },
      sourceUrl: url
    });
  }

  // Extract tracking numbers
  for (const { carrier, pattern } of TRACKING_PATTERNS) {
    pattern.lastIndex = 0;
    const matches = text.match(pattern) || [];
    for (const num of matches) {
      entities.push({
        name: num,
        entityType: 'tracking_number',
        confidence: 0.7,
        extractor: 'regex',
        attributes: { carrier, number: num },
        sourceUrl: url
      });
    }
  }

  // Extract person names via lightweight NER (name database lookup)
  const personNames = extractPersonNames(text, url);
  entities.push(...personNames);

  return entities;
}
