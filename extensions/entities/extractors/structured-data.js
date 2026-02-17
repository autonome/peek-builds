/**
 * Structured data entity extractor
 *
 * Extracts entities from JSON-LD, schema.org markup, and Open Graph meta tags.
 */

/**
 * Extract structured data entities from HTML content
 * @param {string} html - HTML content of the page
 * @param {string} url - Source URL for context
 * @returns {Array<Object>} Extracted entities
 */
export function extractStructuredDataEntities(html, url) {
  if (!html || typeof html !== 'string') return [];

  const entities = [];

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Extract from JSON-LD scripts
    const jsonLdEntities = extractJsonLd(doc, url);
    entities.push(...jsonLdEntities);

    // Extract from Open Graph meta tags
    const ogEntities = extractOpenGraph(doc, url);
    entities.push(...ogEntities);

    // Extract from standard meta tags
    const metaEntities = extractMetaTags(doc, url);
    entities.push(...metaEntities);
  } catch (err) {
    console.warn('[entities:structured-data] Parse error:', err.message);
  }

  return entities;
}

/**
 * Extract entities from JSON-LD script tags
 */
function extractJsonLd(doc, url) {
  const entities = [];
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');

  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent);
      const items = Array.isArray(data) ? data : [data];

      for (const item of items) {
        // Handle @graph arrays
        if (item['@graph'] && Array.isArray(item['@graph'])) {
          for (const graphItem of item['@graph']) {
            const entity = jsonLdItemToEntity(graphItem, url);
            if (entity) entities.push(entity);
          }
        } else {
          const entity = jsonLdItemToEntity(item, url);
          if (entity) entities.push(entity);
        }
      }
    } catch {
      // Invalid JSON-LD, skip
    }
  }

  return entities;
}

/**
 * Convert a single JSON-LD item to an entity
 */
function jsonLdItemToEntity(item, url) {
  if (!item || !item['@type']) return null;

  const type = Array.isArray(item['@type']) ? item['@type'][0] : item['@type'];
  const name = item.name || item.headline || item.title;

  if (!name || typeof name !== 'string' || name.trim().length < 2) return null;

  // Map schema.org types to entity types
  const typeMap = {
    // People
    'Person': 'person',
    // Organizations
    'Organization': 'organization',
    'Corporation': 'organization',
    'LocalBusiness': 'organization',
    'Restaurant': 'organization',
    'Store': 'organization',
    'EducationalOrganization': 'organization',
    'GovernmentOrganization': 'organization',
    'NGO': 'organization',
    'SportsTeam': 'organization',
    'Airline': 'organization',
    'MedicalOrganization': 'organization',
    // Events
    'Event': 'event',
    'MusicEvent': 'event',
    'SportsEvent': 'event',
    'BusinessEvent': 'event',
    'EducationEvent': 'event',
    'Festival': 'event',
    'TheaterEvent': 'event',
    'ExhibitionEvent': 'event',
    // Places
    'Place': 'place',
    'PostalAddress': 'place',
    'LandmarksOrHistoricalBuildings': 'place',
    'TouristAttraction': 'place',
    'City': 'place',
    'Country': 'place',
    'State': 'place',
    // Products
    'Product': 'product',
    'IndividualProduct': 'product',
    'SoftwareApplication': 'product',
    'MobileApplication': 'product',
    'WebApplication': 'product',
    'VideoGame': 'product',
    // Creative works
    'Article': 'creative_work',
    'NewsArticle': 'creative_work',
    'BlogPosting': 'creative_work',
    'Book': 'creative_work',
    'MusicRecording': 'creative_work',
    'MusicAlbum': 'creative_work',
    'Movie': 'creative_work',
    'TVSeries': 'creative_work',
    'Podcast': 'creative_work',
    'Course': 'creative_work',
    'Recipe': 'creative_work',
    'HowTo': 'creative_work',
    'Review': 'creative_work',
    'VideoObject': 'creative_work',
    'CreativeWork': 'creative_work',
  };

  const entityType = typeMap[type];
  if (!entityType) return null;

  const attributes = {};

  // Common attributes
  if (item.url) attributes.url = item.url;
  if (item.description) attributes.description = String(item.description).slice(0, 500);
  if (item.image) {
    attributes.image = typeof item.image === 'string' ? item.image :
                       (item.image.url || item.image['@id'] || '');
  }
  if (item.sameAs) {
    attributes.sameAs = Array.isArray(item.sameAs) ? item.sameAs : [item.sameAs];
  }

  // Type-specific attributes
  switch (entityType) {
    case 'person':
      if (item.email) attributes.email = item.email;
      if (item.telephone) attributes.phone = item.telephone;
      if (item.jobTitle) attributes.jobTitle = item.jobTitle;
      if (item.worksFor) {
        attributes.organization = typeof item.worksFor === 'string' ?
          item.worksFor : (item.worksFor.name || '');
      }
      break;

    case 'organization':
      if (item.email) attributes.email = item.email;
      if (item.telephone) attributes.phone = item.telephone;
      if (item.logo) {
        attributes.logo = typeof item.logo === 'string' ? item.logo :
                          (item.logo.url || '');
      }
      if (item.address) {
        attributes.address = typeof item.address === 'string' ? item.address :
          formatAddress(item.address);
      }
      break;

    case 'event':
      if (item.startDate) attributes.startDate = item.startDate;
      if (item.endDate) attributes.endDate = item.endDate;
      if (item.location) {
        attributes.location = typeof item.location === 'string' ? item.location :
          (item.location.name || formatAddress(item.location.address) || '');
      }
      if (item.performer) {
        attributes.performer = typeof item.performer === 'string' ? item.performer :
          (item.performer.name || '');
      }
      break;

    case 'place':
      if (item.address) {
        attributes.address = typeof item.address === 'string' ? item.address :
          formatAddress(item.address);
      }
      if (item.geo) {
        attributes.latitude = item.geo.latitude;
        attributes.longitude = item.geo.longitude;
      }
      break;

    case 'product':
      if (item.brand) {
        attributes.brand = typeof item.brand === 'string' ? item.brand :
          (item.brand.name || '');
      }
      if (item.offers) {
        const offer = Array.isArray(item.offers) ? item.offers[0] : item.offers;
        if (offer && offer.price) {
          attributes.price = `${offer.priceCurrency || '$'}${offer.price}`;
        }
      }
      // SoftwareApplication-specific
      if (item.applicationCategory) attributes.category = item.applicationCategory;
      if (item.operatingSystem) attributes.operatingSystem = item.operatingSystem;
      break;

    case 'creative_work':
      if (item.author) {
        attributes.author = typeof item.author === 'string' ? item.author :
          (item.author.name || '');
      }
      if (item.publisher) {
        attributes.publisher = typeof item.publisher === 'string' ? item.publisher :
          (item.publisher.name || '');
      }
      if (item.datePublished) attributes.datePublished = item.datePublished;
      if (item.dateModified) attributes.dateModified = item.dateModified;
      // Recipe-specific
      if (item.recipeCategory) attributes.category = item.recipeCategory;
      if (item.cookTime) attributes.cookTime = item.cookTime;
      if (item.prepTime) attributes.prepTime = item.prepTime;
      // Course-specific
      if (item.provider) {
        attributes.provider = typeof item.provider === 'string' ? item.provider :
          (item.provider.name || '');
      }
      // Review-specific
      if (item.reviewRating) {
        attributes.rating = item.reviewRating.ratingValue || '';
      }
      if (item.itemReviewed) {
        attributes.itemReviewed = typeof item.itemReviewed === 'string' ? item.itemReviewed :
          (item.itemReviewed.name || '');
      }
      break;
  }

  // Validate: require sufficient fields to avoid storing generic/templated entries
  const meaningfulFields = Object.values(attributes).filter(v =>
    v && (typeof v === 'string' ? v.trim().length > 0 : true)
  ).length;

  // Type-specific minimum field requirements
  switch (entityType) {
    case 'person':
      // Person needs at least 1 additional field beyond name (email, url, jobTitle, org, etc.)
      if (meaningfulFields < 1) return null;
      break;
    case 'organization':
      if (meaningfulFields < 1) return null;
      break;
    case 'event':
      // Events need a start date at minimum
      if (!attributes.startDate) return null;
      break;
    case 'product':
      // Products need at least price or description
      if (!attributes.price && !attributes.description) return null;
      break;
  }

  // Confidence based on field richness: 0.9 for 3+ fields, 0.85 for fewer
  const confidence = meaningfulFields >= 3 ? 0.9 : 0.85;

  return {
    name: name.trim(),
    entityType,
    confidence,
    extractor: 'json-ld',
    attributes,
    sourceUrl: url,
    schemaType: type
  };
}

/**
 * Format a schema.org PostalAddress object into a readable string
 */
function formatAddress(address) {
  if (!address || typeof address === 'string') return address || '';
  const parts = [
    address.streetAddress,
    address.addressLocality,
    address.addressRegion,
    address.postalCode,
    address.addressCountry
  ].filter(Boolean);
  return parts.join(', ');
}

/**
 * Extract entities from Open Graph meta tags
 */
function extractOpenGraph(doc, url) {
  const entities = [];

  // og:type can indicate entity types
  const ogType = getMetaContent(doc, 'og:type');
  const ogTitle = getMetaContent(doc, 'og:title');
  const ogDescription = getMetaContent(doc, 'og:description');
  const ogImage = getMetaContent(doc, 'og:image');
  const ogSiteName = getMetaContent(doc, 'og:site_name');

  // Extract profile info (og:type = profile)
  if (ogType === 'profile' && ogTitle) {
    const firstName = getMetaContent(doc, 'profile:first_name');
    const lastName = getMetaContent(doc, 'profile:last_name');
    const fullName = (firstName && lastName) ? `${firstName} ${lastName}` : ogTitle;

    entities.push({
      name: fullName.trim(),
      entityType: 'person',
      confidence: 0.9,
      extractor: 'opengraph',
      attributes: {
        url,
        description: ogDescription || '',
        image: ogImage || '',
        source: ogSiteName || ''
      },
      sourceUrl: url
    });
  }

  // Extract business info (og:type = business.business)
  if (ogType && ogType.startsWith('business') && ogTitle) {
    entities.push({
      name: ogTitle.trim(),
      entityType: 'organization',
      confidence: 0.85,
      extractor: 'opengraph',
      attributes: {
        url,
        description: ogDescription || '',
        image: ogImage || ''
      },
      sourceUrl: url
    });
  }

  // Extract article author (only if it looks like a real name — at least 2 words)
  const articleAuthor = getMetaContent(doc, 'article:author');
  if (articleAuthor && !articleAuthor.startsWith('http') && articleAuthor.trim().includes(' ')) {
    entities.push({
      name: articleAuthor.trim(),
      entityType: 'person',
      confidence: 0.7,
      extractor: 'opengraph',
      attributes: { role: 'author' },
      sourceUrl: url
    });
  }

  return entities;
}

/**
 * Extract entities from standard meta tags
 */
function extractMetaTags(doc, url) {
  const entities = [];

  // author meta tag
  const author = getMetaContent(doc, 'author');
  if (author && author.trim().length > 2 && !author.startsWith('http')) {
    entities.push({
      name: author.trim(),
      entityType: 'person',
      confidence: 0.7,
      extractor: 'meta',
      attributes: { role: 'author' },
      sourceUrl: url
    });
  }

  // publisher meta tag
  const publisher = getMetaContent(doc, 'publisher');
  if (publisher && publisher.trim().length > 2) {
    entities.push({
      name: publisher.trim(),
      entityType: 'organization',
      confidence: 0.7,
      extractor: 'meta',
      attributes: { role: 'publisher' },
      sourceUrl: url
    });
  }

  return entities;
}

/**
 * Get meta tag content by property or name
 */
function getMetaContent(doc, key) {
  const meta = doc.querySelector(
    `meta[property="${key}"], meta[name="${key}"]`
  );
  return meta ? meta.getAttribute('content') : '';
}

/**
 * Extract page-level metadata (OG tags, title, description, favicon)
 * for enriching URL items. Separate from entity extraction.
 * @param {string} html - HTML content of the page
 * @param {string} url - Source URL for resolving relative URLs
 * @returns {Object|null} Page metadata or null if nothing useful found
 */
export function extractPageMetadata(html, url) {
  if (!html || typeof html !== 'string') return null;

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const metadata = {};

    // Helper to get meta content
    const getMeta = (name) => {
      const el = doc.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
      return el ? el.getAttribute('content')?.trim() : '';
    };

    metadata.title = getMeta('og:title') || doc.querySelector('title')?.textContent?.trim() || '';
    metadata.description = getMeta('og:description') || getMeta('description') || '';
    metadata.ogImage = getMeta('og:image') || '';
    metadata.siteName = getMeta('og:site_name') || '';
    metadata.ogType = getMeta('og:type') || '';

    // Favicon
    const iconLink = doc.querySelector('link[rel="icon"], link[rel="shortcut icon"]');
    if (iconLink) {
      const href = iconLink.getAttribute('href');
      if (href) {
        try { metadata.favicon = new URL(href, url).toString(); } catch { metadata.favicon = href; }
      }
    }

    return (metadata.title || metadata.description || metadata.ogImage) ? metadata : null;
  } catch { return null; }
}
