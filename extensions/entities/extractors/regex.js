/**
 * Regex-based entity extractors
 *
 * Extracts emails, phone numbers, dates, prices, and tracking numbers
 * from page text content using regular expressions.
 */

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

// Price/currency pattern
const PRICE_RE = /(?:\$|EUR|GBP|USD|CAD|AUD|JPY|CHF)\s?[\d,]+(?:\.\d{2})?|\d+(?:,\d{3})*(?:\.\d{2})?\s?(?:USD|EUR|GBP|CAD|AUD|JPY|CHF)/gi;

// Tracking number patterns
const TRACKING_PATTERNS = [
  // UPS
  { carrier: 'UPS', pattern: /\b1Z[A-Z0-9]{16}\b/g },
  // FedEx
  { carrier: 'FedEx', pattern: /\b\d{12,22}\b/g },
  // USPS
  { carrier: 'USPS', pattern: /\b(?:9[234]|7[01])\d{20,22}\b/g },
];

/**
 * Extract all regex-based entities from text content
 * @param {string} text - Text content to scan
 * @param {string} url - Source URL for context
 * @returns {Array<Object>} Extracted entities
 */
export function extractRegexEntities(text, url) {
  if (!text || typeof text !== 'string') return [];

  const entities = [];

  // Extract emails
  const emails = text.match(EMAIL_RE) || [];
  const seenEmails = new Set();
  for (const email of emails) {
    const normalized = email.toLowerCase();
    if (seenEmails.has(normalized)) continue;
    seenEmails.add(normalized);
    entities.push({
      name: normalized,
      entityType: 'email',
      confidence: 0.9,
      extractor: 'regex',
      attributes: { address: normalized, domain: normalized.split('@')[1] },
      sourceUrl: url
    });
  }

  // Extract phone numbers
  const phones = text.match(PHONE_RE) || [];
  const seenPhones = new Set();
  for (const phone of phones) {
    const normalized = phone.replace(/[\s.\-()]/g, '');
    // Skip numbers that are too short (likely not phone numbers)
    if (normalized.replace(/\D/g, '').length < 7) continue;
    if (seenPhones.has(normalized)) continue;
    seenPhones.add(normalized);
    entities.push({
      name: phone.trim(),
      entityType: 'phone',
      confidence: 0.85,
      extractor: 'regex',
      attributes: { number: phone.trim() },
      sourceUrl: url
    });
  }

  // Extract dates
  for (const pattern of DATE_PATTERNS) {
    // Reset lastIndex for each pattern
    pattern.lastIndex = 0;
    const matches = text.match(pattern) || [];
    const seenDates = new Set();
    for (const dateStr of matches) {
      const normalized = dateStr.trim();
      if (seenDates.has(normalized.toLowerCase())) continue;
      seenDates.add(normalized.toLowerCase());
      entities.push({
        name: normalized,
        entityType: 'date',
        confidence: 0.8,
        extractor: 'regex',
        attributes: { originalText: normalized },
        sourceUrl: url
      });
    }
  }

  // Extract prices
  const prices = text.match(PRICE_RE) || [];
  const seenPrices = new Set();
  for (const price of prices) {
    const normalized = price.trim();
    if (seenPrices.has(normalized)) continue;
    seenPrices.add(normalized);
    entities.push({
      name: normalized,
      entityType: 'price',
      confidence: 0.85,
      extractor: 'regex',
      attributes: { originalText: normalized },
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

  return entities;
}
