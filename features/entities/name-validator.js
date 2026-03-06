/**
 * Entity Name Validator — Phase 1 of the entity validation framework
 *
 * Pure JS, zero dependencies. Validates entity type claims using:
 * 1. Name pattern heuristics (CamelCase, org suffixes, honorifics, etc.)
 * 2. Local name database lookup (~2000 first names, ~1000 surnames)
 *
 * See docs/entity-validation-research.md for design rationale.
 */

// Lazy-loaded name sets (initialized on first use)
let _firstNames = null;
let _surnames = null;

/**
 * Load the name database. Called lazily on first validation.
 * Works in both Node.js/Electron and browser (preload) contexts.
 */
async function loadNameDatabase() {
  if (_firstNames !== null) return;

  try {
    // Dynamic import works in both ESM contexts
    const data = await import('./data/names.json', { assert: { type: 'json' } }).then(m => m.default);
    _firstNames = new Set(data.firstNames.map(n => n.toLowerCase()));
    _surnames = new Set(data.surnames.map(n => n.toLowerCase()));
  } catch {
    // Fallback: try fetch (browser context)
    try {
      const url = new URL('./data/names.json', import.meta.url);
      const resp = await fetch(url);
      const data = await resp.json();
      _firstNames = new Set(data.firstNames.map(n => n.toLowerCase()));
      _surnames = new Set(data.surnames.map(n => n.toLowerCase()));
    } catch {
      console.warn('[name-validator] Could not load name database, using empty sets');
      _firstNames = new Set();
      _surnames = new Set();
    }
  }
}

// Synchronous name sets for the migration context (loaded separately)
let _syncFirstNames = null;
let _syncSurnames = null;

/**
 * Load names synchronously from a pre-parsed object.
 * Used by the datastore migration which runs in Node.js synchronous context.
 * @param {{ firstNames: string[], surnames: string[] }} data
 */
export function loadNameDatabaseSync(data) {
  _firstNames = new Set(data.firstNames.map(n => n.toLowerCase()));
  _surnames = new Set(data.surnames.map(n => n.toLowerCase()));
}

// --- Organization suffix patterns ---
const ORG_SUFFIXES = /\b(Inc|LLC|Ltd|Corp|Corporation|Co|Company|Foundation|Association|Institute|University|Museum|Academy|Society|Bureau|Agency|Commission|Committee|Council|Board|Authority|Trust|Fund|Group|Holdings|Partners|Ventures|Studios|Labs|Media|Press|Publishing|Records|Entertainment|Networks?|Solutions|Services|Systems|Technologies|Consulting|International|Global|National|Federal|Worldwide)\b\.?$/i;

const ORG_SUFFIX_ANYWHERE = /\b(Inc|LLC|Ltd|Corp|Corporation|Foundation|Association|Institute|University|Museum|Academy|Society)\b\.?/i;

// --- Honorifics/titles that indicate persons ---
const HONORIFIC_PATTERN = /^(Mr|Mrs|Ms|Miss|Dr|Prof|Professor|Sir|Dame|Lady|Lord|Rev|Reverend|Fr|Father|Sr|Sister|Sgt|Sargent|Lt|Cpt|Capt|Captain|Maj|Major|Col|Colonel|Gen|General|Adm|Admiral|Sen|Senator|Rep|Representative|Gov|Governor|Pres|President|Hon|Judge|Justice)\b\.?\s/i;

// --- CamelCase detection (internal caps in a single word) ---
// Matches: IndieWeb, YouTube, GitHub, WordPress, TikTok, LinkedIn
// Does NOT match: John, JOHN, john
const CAMELCASE_PATTERN = /^[A-Z][a-z]+(?:[A-Z][a-z]*)+$/;

// --- ALL_CAPS detection ---
const ALL_CAPS_PATTERN = /^[A-Z]{2,}$/;

// --- "The X" pattern ---
const THE_PATTERN = /^The\s+/;

// --- URL/path-like names ---
const URL_LIKE_PATTERN = /^(https?:\/\/|www\.|\/|[a-z]+\.[a-z]{2,})/i;
const PATH_LIKE_PATTERN = /[/\\]|\.(?:com|org|net|edu|gov|io|html|php|asp|js|css)\b/i;


/**
 * Classify a name based on structural patterns alone (no database lookup).
 * Returns the likely entity type and confidence.
 *
 * @param {string} name - The entity name to classify
 * @returns {{ likelyType: string, confidence: number, reason: string }}
 */
export function classifyNamePattern(name) {
  if (!name || typeof name !== 'string') {
    return { likelyType: 'unknown', confidence: 0, reason: 'empty name' };
  }

  const trimmed = name.trim();
  const words = trimmed.split(/\s+/);

  // URL-like or path-like — not an entity name
  if (URL_LIKE_PATTERN.test(trimmed) || PATH_LIKE_PATTERN.test(trimmed)) {
    return { likelyType: 'not_entity', confidence: 0.9, reason: 'URL or path-like name' };
  }

  // Org suffixes (high confidence)
  if (ORG_SUFFIXES.test(trimmed) || ORG_SUFFIX_ANYWHERE.test(trimmed)) {
    return { likelyType: 'organization', confidence: 0.9, reason: 'contains organization suffix' };
  }

  // Honorific prefix → person
  if (HONORIFIC_PATTERN.test(trimmed)) {
    return { likelyType: 'person', confidence: 0.85, reason: 'starts with honorific/title' };
  }

  // "The X" pattern → likely organization or creative work
  if (THE_PATTERN.test(trimmed) && words.length >= 2) {
    return { likelyType: 'organization', confidence: 0.7, reason: 'starts with "The"' };
  }

  // Single-word checks
  if (words.length === 1) {
    // CamelCase single word → brand/org
    if (CAMELCASE_PATTERN.test(trimmed)) {
      return { likelyType: 'organization', confidence: 0.8, reason: 'CamelCase brand name' };
    }

    // ALL CAPS → acronym/abbreviation
    if (ALL_CAPS_PATTERN.test(trimmed)) {
      return { likelyType: 'organization', confidence: 0.6, reason: 'ALL_CAPS abbreviation' };
    }

    // Single word, title case — ambiguous (could be "Apple", "Madonna", etc.)
    return { likelyType: 'ambiguous', confidence: 0.4, reason: 'single word name' };
  }

  // Multi-word CamelCase (e.g., "IndieWeb Movement") — first word is CamelCase
  if (CAMELCASE_PATTERN.test(words[0])) {
    return { likelyType: 'organization', confidence: 0.7, reason: 'leading CamelCase word' };
  }

  // Two-word title case — could be person or org, need name DB to distinguish
  if (words.length === 2 && words.every(w => /^[A-Z][a-z]+$/.test(w))) {
    return { likelyType: 'ambiguous', confidence: 0.5, reason: 'two-word title case' };
  }

  // Names with "&" or "and" between words → likely organization
  if (/\b&\b/.test(trimmed) || /\band\b/i.test(trimmed)) {
    return { likelyType: 'organization', confidence: 0.6, reason: 'contains "&" or "and"' };
  }

  return { likelyType: 'unknown', confidence: 0.3, reason: 'no strong pattern match' };
}


/**
 * Check if a name matches known person name patterns using the local name database.
 *
 * @param {string} name - The name to check
 * @returns {{ likely: boolean, confidence: number, reason: string }}
 */
export function isLikelyPersonName(name) {
  if (!name || typeof name !== 'string') {
    return { likely: false, confidence: 0, reason: 'empty name' };
  }

  // Ensure name DB is loaded (should already be if validateEntityType was called)
  if (!_firstNames) {
    return { likely: false, confidence: 0.3, reason: 'name database not loaded' };
  }

  const trimmed = name.trim();
  const words = trimmed.split(/\s+/);

  // Strip honorific for lookup
  let lookupName = trimmed;
  const honorificMatch = trimmed.match(HONORIFIC_PATTERN);
  if (honorificMatch) {
    lookupName = trimmed.slice(honorificMatch[0].length).trim();
    const lookupWords = lookupName.split(/\s+/);
    // With honorific, even one word is credible
    if (lookupWords.length >= 1) {
      const firstName = lookupWords[0].toLowerCase();
      if (_firstNames.has(firstName)) {
        return { likely: true, confidence: 0.9, reason: 'honorific + known first name' };
      }
      // Honorific alone is a strong signal
      return { likely: true, confidence: 0.75, reason: 'has honorific prefix' };
    }
  }

  // Single word — check if it is a known first name (e.g., "Madonna", "Jesus")
  if (words.length === 1) {
    const lower = trimmed.toLowerCase();
    if (_firstNames.has(lower)) {
      return { likely: true, confidence: 0.5, reason: 'single word matches known first name' };
    }
    return { likely: false, confidence: 0.2, reason: 'single word, not a known first name' };
  }

  // Multi-word: check first and last
  const first = words[0].toLowerCase();
  const last = words[words.length - 1].toLowerCase();

  const firstMatch = _firstNames.has(first);
  const lastMatch = _surnames.has(last);

  if (firstMatch && lastMatch) {
    return { likely: true, confidence: 0.9, reason: 'known first name + known surname' };
  }
  if (firstMatch) {
    return { likely: true, confidence: 0.7, reason: 'known first name' };
  }
  if (lastMatch) {
    return { likely: true, confidence: 0.5, reason: 'known surname' };
  }

  // Two-word title case names are plausible as person names even without DB match
  if (words.length === 2 && words.every(w => /^[A-Z][a-z]+$/.test(w))) {
    return { likely: false, confidence: 0.4, reason: 'title case but no name DB match' };
  }

  return { likely: false, confidence: 0.2, reason: 'no person name pattern match' };
}


/**
 * Validate whether a name matches its claimed entity type.
 * This is the main entry point — call before storing an entity.
 *
 * @param {string} name - The entity name
 * @param {string} claimedType - The claimed entity type (person, organization, etc.)
 * @returns {{ valid: boolean, suggestedType?: string, reason?: string }}
 */
export function validateEntityType(name, claimedType) {
  if (!name || typeof name !== 'string' || !claimedType) {
    return { valid: false, reason: 'missing name or type' };
  }

  const trimmed = name.trim();

  // URL-like or path-like names should never be entities
  if (URL_LIKE_PATTERN.test(trimmed) || PATH_LIKE_PATTERN.test(trimmed)) {
    return { valid: false, reason: 'name looks like URL or path' };
  }

  const pattern = classifyNamePattern(trimmed);
  const personCheck = isLikelyPersonName(trimmed);

  // --- Person type validation ---
  if (claimedType === 'person') {
    // CamelCase → definitely not a person
    if (pattern.likelyType === 'organization' && pattern.reason === 'CamelCase brand name') {
      return { valid: false, suggestedType: 'organization', reason: pattern.reason };
    }

    // Org suffix → not a person
    if (pattern.likelyType === 'organization' && pattern.reason === 'contains organization suffix') {
      return { valid: false, suggestedType: 'organization', reason: pattern.reason };
    }

    // "The X" pattern → not a person
    if (pattern.likelyType === 'organization' && pattern.reason === 'starts with "The"') {
      return { valid: false, suggestedType: 'organization', reason: pattern.reason };
    }

    // ALL_CAPS → not a person
    if (pattern.likelyType === 'organization' && pattern.reason === 'ALL_CAPS abbreviation') {
      return { valid: false, suggestedType: 'organization', reason: pattern.reason };
    }

    // Leading CamelCase → not a person
    if (pattern.likelyType === 'organization' && pattern.reason === 'leading CamelCase word') {
      return { valid: false, suggestedType: 'organization', reason: pattern.reason };
    }

    // Single word: only valid if in first names DB
    if (trimmed.split(/\s+/).length === 1) {
      if (personCheck.likely) {
        return { valid: true }; // Known mononym (Madonna, Jesus, etc.)
      }
      return { valid: false, reason: 'single-word name not in known first names database' };
    }

    // Multi-word: if name DB says not likely AND pattern says org, reject
    if (!personCheck.likely && pattern.likelyType === 'organization') {
      return { valid: false, suggestedType: 'organization', reason: pattern.reason };
    }

    // Multi-word: person check passed or ambiguous — allow
    return { valid: true };
  }

  // --- Organization type validation ---
  if (claimedType === 'organization') {
    // Honorific prefix → this is a person, not an org
    if (pattern.likelyType === 'person' && pattern.reason === 'starts with honorific/title') {
      return { valid: false, suggestedType: 'person', reason: pattern.reason };
    }

    // Otherwise, organizations are hard to invalidate by name alone
    return { valid: true };
  }

  // --- Other types: minimal validation ---
  // For events, products, creative works — just check for URL/path
  return { valid: true };
}


/**
 * Check if a word is a known first name in the database.
 * Returns false if the database hasn't been loaded yet.
 * @param {string} word - Single word to check (case-insensitive)
 * @returns {boolean}
 */
export function isKnownFirstName(word) {
  if (!_firstNames || !word) return false;
  return _firstNames.has(word.toLowerCase());
}

/**
 * Ensure the name database is loaded. Call this before using validateEntityType
 * or isLikelyPersonName in async contexts.
 */
export async function ensureNameDatabase() {
  await loadNameDatabase();
}
