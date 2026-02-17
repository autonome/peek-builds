/**
 * Regex-based entity extractors
 *
 * Extracts emails, phone numbers, dates (with event/label context),
 * prices (with product context), addresses, and tracking numbers from
 * page text content using regular expressions.
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

  // Extract dates WITH context only - standalone dates are noise.
  // A date must be associated with a nearby event name, deadline, or meaningful label.
  for (const pattern of DATE_PATTERNS) {
    pattern.lastIndex = 0;
    let dateMatch;
    const seenDates = new Set();
    while ((dateMatch = pattern.exec(text)) !== null) {
      const normalized = dateMatch[0].trim();
      if (seenDates.has(normalized.toLowerCase())) continue;
      seenDates.add(normalized.toLowerCase());

      const context = extractDateContext(text, dateMatch.index);
      if (context) {
        entities.push({
          name: `${context} ${normalized}`,
          entityType: 'date',
          confidence: 0.8,
          extractor: 'regex',
          attributes: { originalText: normalized, context: context },
          sourceUrl: url
        });
      }
      // If no context found, skip this date — it's noise
    }
  }

  // Extract prices WITH context only - standalone prices are noise.
  // A price must be associated with a nearby product/service name.
  PRICE_CONTEXT_RE.lastIndex = 0;
  let priceMatch;
  const seenPrices = new Set();
  while ((priceMatch = PRICE_CONTEXT_RE.exec(text)) !== null) {
    const priceText = priceMatch[0].trim();
    if (seenPrices.has(priceText)) continue;
    seenPrices.add(priceText);

    const productName = extractPriceContext(text, priceMatch.index);
    if (productName) {
      // Create a meaningful price entity: "ProductName — $X.XX"
      entities.push({
        name: `${productName} ${priceText}`,
        entityType: 'price',
        confidence: 0.85,
        extractor: 'regex',
        attributes: {
          price: priceText,
          product: productName,
          originalText: priceText
        },
        sourceUrl: url
      });
    }
    // If no product context found, skip this price — it's noise
  }

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

  return entities;
}
