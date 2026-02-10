/**
 * Microformats entity extractor
 *
 * Parses microformats2 markup (h-card, h-event, h-adr) from page HTML
 * to extract people, organizations, events, and places.
 *
 * Uses DOM parsing since we receive HTML strings from content extraction.
 */

/**
 * Extract microformat entities from HTML content
 * @param {string} html - HTML content of the page
 * @param {string} url - Source URL for context
 * @returns {Array<Object>} Extracted entities
 */
export function extractMicroformatEntities(html, url) {
  if (!html || typeof html !== 'string') return [];

  const entities = [];

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Extract h-card (people and organizations)
    const hCards = doc.querySelectorAll('.h-card, .vcard');
    for (const card of hCards) {
      const entity = parseHCard(card, url);
      if (entity) entities.push(entity);
    }

    // Extract h-event (events)
    const hEvents = doc.querySelectorAll('.h-event, .vevent');
    for (const event of hEvents) {
      const entity = parseHEvent(event, url);
      if (entity) entities.push(entity);
    }

    // Extract h-adr (addresses/places)
    const hAdrs = doc.querySelectorAll('.h-adr, .adr');
    for (const adr of hAdrs) {
      const entity = parseHAdr(adr, url);
      if (entity) entities.push(entity);
    }
  } catch (err) {
    console.warn('[entities:microformats] Parse error:', err.message);
  }

  return entities;
}

/**
 * Parse an h-card element into a person or organization entity
 */
function parseHCard(el, url) {
  const name = getText(el, '.p-name, .fn') ||
               getText(el, '.p-given-name') + ' ' + getText(el, '.p-family-name');

  if (!name || name.trim().length < 2) return null;

  const orgName = getText(el, '.p-org, .org');
  const email = getText(el, '.u-email, .email');
  const homepage = getAttr(el, '.u-url, .url', 'href');
  const photo = getAttr(el, '.u-photo, .photo', 'src');
  const tel = getText(el, '.p-tel, .tel');
  const role = getText(el, '.p-job-title, .p-role, .role, .title');

  // Determine if this is an org or person
  // If name matches org name, or has org suffix, treat as org
  const isOrg = orgName && orgName.trim() === name.trim();
  const entityType = isOrg ? 'organization' : 'person';

  const attributes = {};
  if (email) attributes.email = email;
  if (homepage) attributes.homepage = homepage;
  if (photo) attributes.photo = photo;
  if (tel) attributes.phone = tel;
  if (role) attributes.role = role;
  if (orgName && !isOrg) attributes.organization = orgName;

  return {
    name: name.trim(),
    entityType,
    confidence: 0.95,
    extractor: 'microformats',
    attributes,
    sourceUrl: url
  };
}

/**
 * Parse an h-event element into an event entity
 */
function parseHEvent(el, url) {
  const name = getText(el, '.p-name, .summary');
  if (!name || name.trim().length < 2) return null;

  const dtStart = getText(el, '.dt-start, .dtstart') ||
                  getAttr(el, '.dt-start, .dtstart', 'datetime');
  const dtEnd = getText(el, '.dt-end, .dtend') ||
                getAttr(el, '.dt-end, .dtend', 'datetime');
  const location = getText(el, '.p-location, .location');
  const description = getText(el, '.p-description, .description');
  const eventUrl = getAttr(el, '.u-url, .url', 'href');

  const attributes = {};
  if (dtStart) attributes.startDate = dtStart;
  if (dtEnd) attributes.endDate = dtEnd;
  if (location) attributes.location = location;
  if (description) attributes.description = description.slice(0, 500);
  if (eventUrl) attributes.url = eventUrl;

  return {
    name: name.trim(),
    entityType: 'event',
    confidence: 0.95,
    extractor: 'microformats',
    attributes,
    sourceUrl: url
  };
}

/**
 * Parse an h-adr element into a place entity
 */
function parseHAdr(el, url) {
  const streetAddress = getText(el, '.p-street-address, .street-address');
  const locality = getText(el, '.p-locality, .locality');
  const region = getText(el, '.p-region, .region');
  const postalCode = getText(el, '.p-postal-code, .postal-code');
  const country = getText(el, '.p-country-name, .country-name');

  // Build a name from address components
  const parts = [locality, region, country].filter(Boolean);
  const name = parts.join(', ');

  if (!name || name.trim().length < 2) return null;

  const attributes = {};
  if (streetAddress) attributes.streetAddress = streetAddress;
  if (locality) attributes.locality = locality;
  if (region) attributes.region = region;
  if (postalCode) attributes.postalCode = postalCode;
  if (country) attributes.country = country;

  return {
    name: name.trim(),
    entityType: 'place',
    confidence: 0.9,
    extractor: 'microformats',
    attributes,
    sourceUrl: url
  };
}

/**
 * Get text content from first matching child element
 */
function getText(parent, selectors) {
  const el = parent.querySelector(selectors);
  return el ? el.textContent.trim() : '';
}

/**
 * Get attribute value from first matching child element
 */
function getAttr(parent, selectors, attr) {
  const el = parent.querySelector(selectors);
  return el ? (el.getAttribute(attr) || '') : '';
}
