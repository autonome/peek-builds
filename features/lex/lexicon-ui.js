/**
 * Lexicon UI Generator — Dynamic form generation from AT Protocol lexicon schemas.
 *
 * Given an NSID, fetches the lexicon JSON schema, analyzes its fields,
 * and dynamically generates a form UI for creating records.
 *
 * Resolution strategy (layered):
 * 1. In-memory cache
 * 2. Known GitHub raw URLs (for official and well-known lexicons)
 * 3. Lexicon Store API (api.lexicon.store)
 * 4. Fallback to raw JSON editor
 */

// ============================================================================
// Lexicon Schema Resolver
// ============================================================================

/**
 * Known GitHub repository mappings for lexicon NSIDs.
 * Maps NSID prefix to raw GitHub URL prefix.
 */
const GITHUB_MAPPINGS = {
  'app.bsky':            'https://raw.githubusercontent.com/bluesky-social/atproto/main/lexicons',
  'com.atproto':         'https://raw.githubusercontent.com/bluesky-social/atproto/main/lexicons',
  'chat.bsky':           'https://raw.githubusercontent.com/bluesky-social/atproto/main/lexicons',
  'tools.ozone':         'https://raw.githubusercontent.com/bluesky-social/atproto/main/lexicons',
  'fyi.frontpage':       'https://raw.githubusercontent.com/frontpagefyi/frontpage/main/lexicons',
  'community.lexicon':   'https://raw.githubusercontent.com/lexicon-community/lexicon/main',
};

const schemaCache = new Map();
const pendingResolves = new Map();
let persistedSchemasLoaded = false;

const LEXICON_SCHEMAS_KEY = 'lexiconSchemas';

/**
 * Load persisted schemas from settings into the in-memory cache.
 * Called once on first cache miss.
 */
async function loadPersistedSchemas() {
  if (persistedSchemasLoaded) return;
  persistedSchemasLoaded = true;

  try {
    if (typeof window !== 'undefined' && window.app?.settings) {
      const result = await window.app.settings.getKey(LEXICON_SCHEMAS_KEY);
      if (result.success && result.data && typeof result.data === 'object') {
        let count = 0;
        for (const [nsid, entry] of Object.entries(result.data)) {
          if (entry && entry.schema && !schemaCache.has(nsid)) {
            schemaCache.set(nsid, entry.schema);
            count++;
          }
        }
        if (count > 0) {
          console.log(`[lexicon-ui] Restored ${count} lexicon schemas from persisted cache`);
        }
      }
    }
  } catch (err) {
    console.warn('[lexicon-ui] Failed to load persisted schemas:', err);
  }
}

/**
 * Persist a resolved schema to settings storage.
 */
async function persistSchema(nsid, schema) {
  try {
    if (typeof window !== 'undefined' && window.app?.settings) {
      // Load existing persisted data, merge in the new schema
      const result = await window.app.settings.getKey(LEXICON_SCHEMAS_KEY);
      const existing = (result.success && result.data && typeof result.data === 'object')
        ? result.data
        : {};
      existing[nsid] = { schema, fetchedAt: Date.now() };
      await window.app.settings.setKey(LEXICON_SCHEMAS_KEY, existing);
    }
  } catch (err) {
    console.warn(`[lexicon-ui] Failed to persist schema for ${nsid}:`, err);
  }
}

/**
 * Convert an NSID to a file path for GitHub resolution.
 * e.g. "app.bsky.feed.post" -> "app/bsky/feed/post.json"
 */
function nsidToPath(nsid) {
  return nsid.split('.').join('/') + '.json';
}

/**
 * Try to build a GitHub raw URL for the given NSID.
 */
function githubUrl(nsid) {
  for (const [prefix, baseUrl] of Object.entries(GITHUB_MAPPINGS)) {
    if (nsid.startsWith(prefix)) {
      return `${baseUrl}/${nsidToPath(nsid)}`;
    }
  }
  return null;
}

/**
 * Resolve a lexicon schema by NSID.
 * Uses layered resolution: memory cache -> persisted cache -> GitHub -> Lexicon Store.
 *
 * @param {string} nsid
 * @returns {Promise<Object|null>} The lexicon JSON object, or null if not found.
 */
export async function resolveLexicon(nsid) {
  if (schemaCache.has(nsid)) return schemaCache.get(nsid);

  // On first miss, load persisted schemas into memory
  await loadPersistedSchemas();
  if (schemaCache.has(nsid)) return schemaCache.get(nsid);

  if (pendingResolves.has(nsid)) return pendingResolves.get(nsid);

  const promise = _doResolve(nsid);
  pendingResolves.set(nsid, promise);
  try {
    const result = await promise;
    if (result) {
      schemaCache.set(nsid, result);
      // Persist to settings in background (don't block)
      persistSchema(nsid, result).catch(() => {});
    }
    return result;
  } finally {
    pendingResolves.delete(nsid);
  }
}

async function _doResolve(nsid) {
  // Strategy 1: Known GitHub URLs
  const ghUrl = githubUrl(nsid);
  if (ghUrl) {
    try {
      const res = await fetch(ghUrl);
      if (res.ok) {
        const data = await res.json();
        if (data && data.lexicon) return data;
      }
    } catch (e) {
      console.warn(`[lexicon-ui] GitHub fetch failed for ${nsid}:`, e.message);
    }
  }

  // Strategy 2: Lexicon Store API
  try {
    const res = await fetch(`https://api.lexicon.store/lexicon/${nsid}`);
    if (res.ok) {
      const data = await res.json();
      if (data && data.lexicon) return data;
      // Some responses wrap in a different format
      if (data && data.def) return data.def;
    }
  } catch (e) {
    console.warn(`[lexicon-ui] Lexicon Store fetch failed for ${nsid}:`, e.message);
  }

  // Strategy 3: Try constructing from the NSID authority domain
  // NSID "site.standard.document" -> authority domain "standard.site"
  // Try fetching from that domain's well-known location
  try {
    const parts = nsid.split('.');
    if (parts.length >= 3) {
      // Authority is the first two segments reversed as a domain
      const authority = parts.slice(0, 2).reverse().join('.');
      const lexPath = nsidToPath(nsid);
      const domainUrl = `https://${authority}/lexicons/${lexPath}`;
      const res = await fetch(domainUrl);
      if (res.ok) {
        const data = await res.json();
        if (data && data.lexicon) return data;
      }
    }
  } catch (e) {
    // Domain-based resolution failed, that's fine
  }

  return null;
}

/**
 * Resolve a $ref within a lexicon to its definition.
 * Handles local refs (#name) and external refs (nsid or nsid#name).
 *
 * @param {string} ref - The ref string
 * @param {Object} currentLexicon - The lexicon containing the ref
 * @returns {Promise<Object|null>}
 */
export async function resolveRef(ref, currentLexicon) {
  if (ref.startsWith('#')) {
    const defName = ref.slice(1);
    return currentLexicon?.defs?.[defName] || null;
  }

  const [nsid, fragment] = ref.includes('#') ? ref.split('#') : [ref, 'main'];
  const lexicon = await resolveLexicon(nsid);
  if (!lexicon) return null;
  return lexicon.defs?.[fragment] || null;
}

/**
 * Get the record schema from a lexicon definition.
 * For record types, returns defs.main.record.
 * For procedures, returns defs.main.input.schema.
 */
export function getRecordSchema(lexicon) {
  const main = lexicon?.defs?.main;
  if (!main) return null;

  if (main.type === 'record' && main.record) {
    return main.record;
  }
  if (main.type === 'procedure' && main.input?.schema) {
    return main.input.schema;
  }
  return null;
}

// ============================================================================
// Bluesky Post Detection
// ============================================================================

const BLUESKY_POST_NSID = 'app.bsky.feed.post';
const BLUESKY_POST_MAX_GRAPHEMES = 300;
const BLUESKY_POST_MAX_IMAGES = 4;

/**
 * Check if an NSID is a Bluesky post.
 */
export function isBlueskyPost(nsid) {
  return nsid === BLUESKY_POST_NSID;
}

/**
 * Count graphemes using Intl.Segmenter (accurate) with fallback to .length.
 */
function countGraphemes(text) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    return [...new Intl.Segmenter().segment(text)].length;
  }
  return text.length;
}

// ============================================================================
// Dynamic Form Generator
// ============================================================================

/**
 * Generate a complete HTML form from a lexicon record schema.
 *
 * @param {string} nsid - The lexicon NSID
 * @param {Object} schema - The record's object schema (type: "object")
 * @param {Object} lexicon - The full lexicon for resolving local refs
 * @param {Object} [options] - Options
 * @param {boolean} [options.autoFillCreatedAt] - Auto-fill createdAt with now
 * @returns {Promise<HTMLElement>} The generated form element
 */
export async function generateForm(nsid, schema, lexicon, options = {}) {
  // Special handling for Bluesky posts
  if (isBlueskyPost(nsid)) {
    return generateBlueskyPostForm(nsid, schema, lexicon, options);
  }

  const form = document.createElement('form');
  form.className = 'lexicon-form';
  form.dataset.nsid = nsid;

  if (!schema || !schema.properties) {
    const msg = document.createElement('div');
    msg.className = 'form-message';
    msg.textContent = 'No properties found in this schema. Use raw JSON mode.';
    form.appendChild(msg);
    return form;
  }

  const { properties, required = [] } = schema;

  // Sort fields: required first, then alphabetical, with createdAt last
  const fieldNames = Object.keys(properties).sort((a, b) => {
    const aReq = required.includes(a);
    const bReq = required.includes(b);
    // createdAt always last
    if (a === 'createdAt') return 1;
    if (b === 'createdAt') return -1;
    // Required fields first
    if (aReq && !bReq) return -1;
    if (!aReq && bReq) return 1;
    return a.localeCompare(b);
  });

  for (const name of fieldNames) {
    const fieldSchema = properties[name];
    const isRequired = required.includes(name);
    const fieldEl = await renderField(name, fieldSchema, isRequired, lexicon, 0);
    form.appendChild(fieldEl);
  }

  // Auto-fill createdAt
  if (options.autoFillCreatedAt !== false) {
    const createdAtInput = form.querySelector('[data-field-name="createdAt"] input');
    if (createdAtInput && !createdAtInput.value) {
      createdAtInput.value = new Date().toISOString().slice(0, 16);
    }
  }

  return form;
}

// ============================================================================
// Bluesky Post Composer
// ============================================================================

/**
 * Generate a specialized Bluesky post composer form.
 * Replaces the generic form with a purpose-built post UI:
 * - Text area with grapheme counter (300 limit)
 * - Live preview with highlighted mentions/links/hashtags
 * - Image upload (up to 4) with alt text and aspect ratio
 * - Language selector
 */
function generateBlueskyPostForm(nsid, schema, lexicon, options = {}) {
  const form = document.createElement('form');
  form.className = 'lexicon-form bsky-post-form';
  form.dataset.nsid = nsid;

  // --- Post text area ---
  const textSection = document.createElement('div');
  textSection.className = 'bsky-text-section';

  const textLabel = document.createElement('label');
  textLabel.className = 'field-label';
  textLabel.textContent = 'Post';
  const star = document.createElement('span');
  star.className = 'required-mark';
  star.textContent = ' *';
  textLabel.appendChild(star);
  textSection.appendChild(textLabel);

  const textarea = document.createElement('textarea');
  textarea.name = 'text';
  textarea.className = 'form-textarea bsky-text-input';
  textarea.rows = 5;
  textarea.placeholder = "What's on your mind?";
  textarea.maxLength = 3000; // UTF-8 byte limit, not grapheme limit
  textSection.appendChild(textarea);

  // Grapheme counter
  const counterRow = document.createElement('div');
  counterRow.className = 'bsky-counter-row';

  const counter = document.createElement('div');
  counter.className = 'bsky-grapheme-counter';
  counter.textContent = `0 / ${BLUESKY_POST_MAX_GRAPHEMES}`;
  counterRow.appendChild(counter);
  textSection.appendChild(counterRow);

  // Post preview
  const preview = document.createElement('div');
  preview.className = 'bsky-post-preview';
  preview.style.display = 'none';
  textSection.appendChild(preview);

  // Wire up text input events
  textarea.addEventListener('input', () => {
    const text = textarea.value;
    const graphemes = countGraphemes(text);
    const remaining = BLUESKY_POST_MAX_GRAPHEMES - graphemes;
    counter.textContent = `${graphemes} / ${BLUESKY_POST_MAX_GRAPHEMES}`;
    counter.classList.toggle('over-limit', remaining < 0);
    counter.classList.toggle('near-limit', remaining >= 0 && remaining <= 20);

    // Update preview
    updatePostPreview(preview, text);
  });

  form.appendChild(textSection);

  // --- Image upload section ---
  const imageSection = document.createElement('div');
  imageSection.className = 'bsky-image-section';
  imageSection.dataset.fieldName = '__bsky_images';

  const imageLabel = document.createElement('label');
  imageLabel.className = 'field-label';
  imageLabel.textContent = 'Images';
  imageSection.appendChild(imageLabel);

  const imageHint = document.createElement('div');
  imageHint.className = 'field-hint';
  imageHint.textContent = `Up to ${BLUESKY_POST_MAX_IMAGES} images. Add alt text for accessibility.`;
  imageSection.appendChild(imageHint);

  const imageGrid = document.createElement('div');
  imageGrid.className = 'bsky-image-grid';
  imageSection.appendChild(imageGrid);

  const addImageBtn = document.createElement('button');
  addImageBtn.type = 'button';
  addImageBtn.className = 'bsky-add-image-btn';
  addImageBtn.textContent = '+ Add image';
  imageSection.appendChild(addImageBtn);

  // Hidden file input for image selection
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/jpeg,image/png,image/webp,image/gif';
  fileInput.multiple = true;
  fileInput.style.display = 'none';
  imageSection.appendChild(fileInput);

  const imageCounter = document.createElement('div');
  imageCounter.className = 'bsky-image-counter';
  imageSection.appendChild(imageCounter);

  // Image management state stored on the form element
  form._bskyImages = []; // { file, altText, objectUrl, width, height }

  function updateImageUI() {
    const images = form._bskyImages;
    imageGrid.innerHTML = '';

    images.forEach((img, idx) => {
      const card = document.createElement('div');
      card.className = 'bsky-image-card';

      const thumb = document.createElement('img');
      thumb.className = 'bsky-image-thumb';
      thumb.src = img.objectUrl;
      thumb.alt = img.altText || '';
      card.appendChild(thumb);

      const controls = document.createElement('div');
      controls.className = 'bsky-image-controls';

      const altInput = document.createElement('input');
      altInput.type = 'text';
      altInput.className = 'form-input bsky-alt-input';
      altInput.placeholder = 'Alt text...';
      altInput.value = img.altText || '';
      altInput.addEventListener('input', () => {
        img.altText = altInput.value;
      });
      controls.appendChild(altInput);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'bsky-image-remove';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => {
        URL.revokeObjectURL(img.objectUrl);
        form._bskyImages.splice(idx, 1);
        updateImageUI();
      });
      controls.appendChild(removeBtn);

      card.appendChild(controls);
      imageGrid.appendChild(card);
    });

    const count = images.length;
    addImageBtn.style.display = count >= BLUESKY_POST_MAX_IMAGES ? 'none' : '';
    imageCounter.textContent = count > 0 ? `${count} / ${BLUESKY_POST_MAX_IMAGES} images` : '';
  }

  addImageBtn.addEventListener('click', () => {
    fileInput.value = '';
    fileInput.click();
  });

  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files || []);
    const remaining = BLUESKY_POST_MAX_IMAGES - form._bskyImages.length;
    const toAdd = files.slice(0, remaining);

    for (const file of toAdd) {
      const objectUrl = URL.createObjectURL(file);
      const entry = { file, altText: '', objectUrl, width: 0, height: 0 };

      // Load image to get dimensions for aspect ratio
      const img = new Image();
      img.onload = () => {
        entry.width = img.naturalWidth;
        entry.height = img.naturalHeight;
      };
      img.src = objectUrl;

      form._bskyImages.push(entry);
    }
    updateImageUI();
  });

  form.appendChild(imageSection);

  // --- Language selector ---
  const langSection = document.createElement('div');
  langSection.className = 'form-field';
  langSection.dataset.fieldName = 'langs';

  const langLabel = document.createElement('label');
  langLabel.className = 'field-label';
  langLabel.textContent = 'Language';
  langSection.appendChild(langLabel);

  const langDropdown = renderLanguageDropdown('langs');
  langSection.appendChild(langDropdown);
  form.appendChild(langSection);

  // --- Hidden createdAt ---
  const hiddenCreatedAt = document.createElement('input');
  hiddenCreatedAt.type = 'hidden';
  hiddenCreatedAt.name = 'createdAt';
  hiddenCreatedAt.value = new Date().toISOString();
  form.appendChild(hiddenCreatedAt);

  return form;
}

/**
 * Update the post preview with highlighted mentions, links, and hashtags.
 */
function updatePostPreview(previewEl, text) {
  if (!text.trim()) {
    previewEl.style.display = 'none';
    previewEl.innerHTML = '';
    return;
  }

  previewEl.style.display = '';

  // Find all facet-like spans and highlight them
  const parts = [];
  let lastIndex = 0;

  // Collect all matches with their positions
  const matches = [];

  // URLs
  const urlRegex = /https?:\/\/[^\s)>\]]+/g;
  let m;
  while ((m = urlRegex.exec(text)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length, type: 'link', text: m[0] });
  }

  // Mentions
  const mentionRegex = /(?<![a-zA-Z0-9])@([a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/g;
  while ((m = mentionRegex.exec(text)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length, type: 'mention', text: m[0] });
  }

  // Hashtags
  const tagRegex = /(?<![a-zA-Z0-9])#([^\s#\p{P}]+)/gu;
  while ((m = tagRegex.exec(text)) !== null) {
    if (/^[0-9a-fA-F]{3,8}$/.test(m[1])) continue;
    matches.push({ start: m.index, end: m.index + m[0].length, type: 'tag', text: m[0] });
  }

  // Sort by position and remove overlaps
  matches.sort((a, b) => a.start - b.start);
  const filtered = [];
  let lastEnd = 0;
  for (const match of matches) {
    if (match.start >= lastEnd) {
      filtered.push(match);
      lastEnd = match.end;
    }
  }

  // Build highlighted HTML
  let html = '';
  let pos = 0;
  for (const match of filtered) {
    if (match.start > pos) {
      html += escapePreviewText(text.slice(pos, match.start));
    }
    html += `<span class="bsky-preview-${match.type}">${escapePreviewText(match.text)}</span>`;
    pos = match.end;
  }
  if (pos < text.length) {
    html += escapePreviewText(text.slice(pos));
  }

  previewEl.innerHTML = html;
}

function escapePreviewText(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

// ============================================================================
// Bluesky Post Data Collection
// ============================================================================

/**
 * Collect data from a Bluesky post composer form.
 * Handles text, facets, images, and language.
 *
 * @param {HTMLFormElement} form - The bsky-post-form
 * @param {string} nsid
 * @param {Object} [uploadBlobFn] - async function(file) => blob ref. Injected by caller.
 * @returns {Promise<Object>} The record object
 */
export async function collectBlueskyPostData(form, nsid, uploadBlobFn) {
  const record = { $type: nsid };

  // Text
  const textarea = form.querySelector('[name="text"]');
  const text = textarea?.value || '';
  if (!text.trim()) {
    throw new Error('Post text is required');
  }

  // Validate grapheme count
  const graphemes = countGraphemes(text);
  if (graphemes > BLUESKY_POST_MAX_GRAPHEMES) {
    throw new Error(`Post exceeds ${BLUESKY_POST_MAX_GRAPHEMES} grapheme limit (${graphemes} graphemes)`);
  }

  record.text = text;

  // Detect facets
  const facets = await detectFacets(text);
  if (facets.length > 0) {
    record.facets = facets;
  }

  // createdAt
  const createdAtInput = form.querySelector('[name="createdAt"]');
  record.createdAt = createdAtInput?.value || new Date().toISOString();
  if (!record.createdAt.endsWith('Z') && !record.createdAt.includes('+')) {
    record.createdAt = new Date(record.createdAt).toISOString();
  }

  // Language
  const langSelect = form.querySelector('select[name="langs"]');
  if (langSelect) {
    let langVal = langSelect.value;
    if (langVal === '__other__') {
      const otherInput = form.querySelector('[name="langs__other"]');
      langVal = otherInput?.value || '';
    }
    if (langVal) {
      record.langs = [langVal];
    }
  }

  // Images — upload blobs and build embed
  const images = form._bskyImages || [];
  if (images.length > 0 && uploadBlobFn) {
    const imageEmbeds = [];
    for (const img of images) {
      const blobResult = await uploadBlobFn(img.file);
      const imageEmbed = {
        image: blobResult.blob,
        alt: img.altText || '',
      };
      // Add aspect ratio if dimensions are known
      if (img.width > 0 && img.height > 0) {
        imageEmbed.aspectRatio = {
          width: img.width,
          height: img.height,
        };
      }
      imageEmbeds.push(imageEmbed);
    }
    record.embed = {
      $type: 'app.bsky.embed.images',
      images: imageEmbeds,
    };
  }

  return record;
}

/**
 * Render a single form field from a schema definition.
 */
async function renderField(name, schema, isRequired, lexicon, depth) {
  const wrapper = document.createElement('div');
  wrapper.className = 'form-field';
  wrapper.dataset.fieldName = name;
  if (depth > 0) wrapper.classList.add('nested');

  // Label
  const label = document.createElement('label');
  label.className = 'field-label';
  label.textContent = formatFieldName(name);
  if (isRequired) {
    const star = document.createElement('span');
    star.className = 'required-mark';
    star.textContent = ' *';
    label.appendChild(star);
  }
  wrapper.appendChild(label);

  // Description hint
  if (schema.description) {
    const hint = document.createElement('div');
    hint.className = 'field-hint';
    hint.textContent = schema.description;
    wrapper.appendChild(hint);
  }

  // Constraint hint — show limits inline
  const constraintParts = [];
  if (schema.maxGraphemes) constraintParts.push(`max ${schema.maxGraphemes} graphemes`);
  else if (schema.maxLength && schema.type === 'string') constraintParts.push(`max ${schema.maxLength} chars`);
  if (schema.minLength && schema.type === 'string') constraintParts.push(`min ${schema.minLength} chars`);
  if (schema.minimum !== undefined) constraintParts.push(`min ${schema.minimum}`);
  if (schema.maximum !== undefined) constraintParts.push(`max ${schema.maximum}`);
  if (schema.type === 'array' && schema.maxLength) constraintParts.push(`max ${schema.maxLength} items`);
  if (constraintParts.length > 0) {
    const constraintHint = document.createElement('div');
    constraintHint.className = 'field-constraint';
    constraintHint.textContent = constraintParts.join(' | ');
    wrapper.appendChild(constraintHint);
  }

  // Render the appropriate input based on schema type
  const input = await renderInput(name, schema, lexicon, depth);
  if (input) {
    wrapper.appendChild(input);
  }

  // Add inline validation for constraint feedback
  if (schema.type === 'string' || schema.type === 'integer' || schema.type === 'number') {
    const hasConstraints = schema.maxLength || schema.minLength || schema.maxGraphemes ||
      schema.minGraphemes || schema.minimum !== undefined || schema.maximum !== undefined;
    if (hasConstraints) {
      const errorEl = document.createElement('div');
      errorEl.className = 'field-error';
      errorEl.style.display = 'none';
      wrapper.appendChild(errorEl);

      // Find the actual input element within the rendered input
      const inputEl = wrapper.querySelector('input, textarea');
      if (inputEl) {
        inputEl.addEventListener('blur', () => {
          const val = inputEl.value;
          const error = validateFieldValue(val, schema);
          if (error) {
            errorEl.textContent = error;
            errorEl.style.display = '';
            wrapper.classList.add('has-error');
          } else {
            errorEl.style.display = 'none';
            wrapper.classList.remove('has-error');
          }
        });
      }
    }
  }

  return wrapper;
}

/**
 * Validate a single field value against its schema constraints.
 * Returns an error message string or null if valid.
 */
function validateFieldValue(val, schema) {
  if (!val && val !== 0) return null; // empty is handled by required check

  if (schema.type === 'string' && typeof val === 'string') {
    const byteLen = new TextEncoder().encode(val).length;
    if (schema.maxLength !== undefined && byteLen > schema.maxLength) {
      return `Too long (${byteLen}/${schema.maxLength} bytes)`;
    }
    if (schema.minLength !== undefined && byteLen < schema.minLength) {
      return `Too short (${byteLen}/${schema.minLength} bytes)`;
    }
    if (schema.maxGraphemes !== undefined) {
      const gc = countGraphemes(val);
      if (gc > schema.maxGraphemes) return `Too long (${gc}/${schema.maxGraphemes} graphemes)`;
    }
    if (schema.minGraphemes !== undefined) {
      const gc = countGraphemes(val);
      if (gc < schema.minGraphemes) return `Too short (${gc}/${schema.minGraphemes} graphemes)`;
    }
  }

  if ((schema.type === 'integer' || schema.type === 'number') && val !== '') {
    const num = Number(val);
    if (isNaN(num)) return 'Must be a number';
    if (schema.minimum !== undefined && num < schema.minimum) return `Must be at least ${schema.minimum}`;
    if (schema.maximum !== undefined && num > schema.maximum) return `Must be at most ${schema.maximum}`;
    if (schema.type === 'integer' && !Number.isInteger(num)) return 'Must be a whole number';
  }

  return null;
}

/**
 * Render the input element for a given schema type.
 */
async function renderInput(name, schema, lexicon, depth) {
  // Prevent infinite recursion
  if (depth > 4) {
    return renderJsonFallback(name);
  }

  const type = schema.type;

  // Handle ref — resolve and render inline
  if (type === 'ref') {
    return await renderRefInput(name, schema, lexicon, depth);
  }

  // Handle union
  if (type === 'union') {
    return await renderUnionInput(name, schema, lexicon, depth);
  }

  // Handle array
  if (type === 'array') {
    return await renderArrayInput(name, schema, lexicon, depth);
  }

  // Handle object (nested)
  if (type === 'object') {
    return await renderObjectInput(name, schema, lexicon, depth);
  }

  // Handle string
  if (type === 'string') {
    return renderStringInput(name, schema);
  }

  // Handle integer / number
  if (type === 'integer' || type === 'number') {
    return renderNumberInput(name, schema);
  }

  // Handle boolean
  if (type === 'boolean') {
    return renderBooleanInput(name, schema);
  }

  // Handle blob
  if (type === 'blob') {
    return renderBlobInput(name, schema);
  }

  // Handle bytes
  if (type === 'bytes') {
    return renderJsonFallback(name);
  }

  // Handle cid-link
  if (type === 'cid-link') {
    const input = document.createElement('input');
    input.type = 'text';
    input.name = name;
    input.className = 'form-input';
    input.placeholder = 'CID link...';
    return input;
  }

  // Handle unknown
  if (type === 'unknown') {
    return renderJsonFallback(name);
  }

  // Fallback
  return renderJsonFallback(name);
}

// ============================================================================
// Type-specific input renderers
// ============================================================================

function renderStringInput(name, schema) {
  // const value with no user input needed
  if (schema.const !== undefined) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = schema.const;
    return input;
  }

  // enum -> closed dropdown
  if (schema.enum) {
    return renderDropdown(name, schema.enum, false, schema.default);
  }

  // knownValues -> open dropdown with "Other" option
  if (schema.knownValues) {
    return renderDropdown(name, schema.knownValues, true, schema.default);
  }

  // format-specific inputs
  if (schema.format === 'datetime') {
    const input = document.createElement('input');
    input.type = 'datetime-local';
    input.name = name;
    input.className = 'form-input';
    input.step = '1'; // allow seconds
    if (name === 'createdAt' || name === 'indexedAt') {
      input.value = new Date().toISOString().slice(0, 16);
    }
    return input;
  }

  if (schema.format === 'uri') {
    const input = document.createElement('input');
    input.type = 'url';
    input.name = name;
    input.className = 'form-input';
    input.placeholder = 'https://...';
    return input;
  }

  if (schema.format === 'at-uri') {
    const input = document.createElement('input');
    input.type = 'text';
    input.name = name;
    input.className = 'form-input';
    input.placeholder = 'at://did:plc:.../collection/rkey';
    return input;
  }

  if (schema.format === 'did') {
    const input = document.createElement('input');
    input.type = 'text';
    input.name = name;
    input.className = 'form-input';
    input.placeholder = 'did:plc:...';
    return input;
  }

  if (schema.format === 'handle') {
    const input = document.createElement('input');
    input.type = 'text';
    input.name = name;
    input.className = 'form-input';
    input.placeholder = 'handle.example.com';
    return input;
  }

  if (schema.format === 'at-identifier') {
    const input = document.createElement('input');
    input.type = 'text';
    input.name = name;
    input.className = 'form-input';
    input.placeholder = 'Handle or DID...';
    return input;
  }

  if (schema.format === 'language') {
    return renderLanguageDropdown(name);
  }

  if (schema.format === 'cid') {
    const input = document.createElement('input');
    input.type = 'text';
    input.name = name;
    input.className = 'form-input';
    input.placeholder = 'bafkrei...';
    return input;
  }

  if (schema.format === 'nsid') {
    const input = document.createElement('input');
    input.type = 'text';
    input.name = name;
    input.className = 'form-input';
    input.placeholder = 'com.example.lexicon';
    return input;
  }

  if (schema.format === 'tid' || schema.format === 'record-key') {
    const input = document.createElement('input');
    input.type = 'text';
    input.name = name;
    input.className = 'form-input';
    input.placeholder = `Auto-generated ${schema.format}`;
    return input;
  }

  // Detect long text fields
  const isLongText =
    (schema.maxGraphemes && schema.maxGraphemes > 100) ||
    (schema.maxLength && schema.maxLength > 500) ||
    /content|body|text|description|summary|bio/i.test(name);

  if (isLongText) {
    const container = document.createElement('div');
    container.className = 'textarea-wrap';

    const textarea = document.createElement('textarea');
    textarea.name = name;
    textarea.className = 'form-textarea';
    textarea.rows = 5;
    if (schema.default !== undefined) textarea.value = schema.default;
    container.appendChild(textarea);

    // Character counter
    if (schema.maxGraphemes || schema.maxLength) {
      const counter = document.createElement('div');
      counter.className = 'char-counter';
      const max = schema.maxGraphemes || schema.maxLength;
      const label = schema.maxGraphemes ? 'graphemes' : 'chars';
      counter.textContent = `0 / ${max} ${label}`;
      textarea.addEventListener('input', () => {
        const len = schema.maxGraphemes
          ? [...new Intl.Segmenter().segment(textarea.value)].length
          : textarea.value.length;
        counter.textContent = `${len} / ${max} ${label}`;
        counter.classList.toggle('over-limit', len > max);
      });
      container.appendChild(counter);
    }

    return container;
  }

  // Default: text input
  const input = document.createElement('input');
  input.type = 'text';
  input.name = name;
  input.className = 'form-input';
  if (schema.default !== undefined) input.value = schema.default;
  if (schema.maxLength) input.maxLength = schema.maxLength;
  if (schema.minLength) input.minLength = schema.minLength;
  return input;
}

function renderNumberInput(name, schema) {
  if (schema.enum) {
    return renderDropdown(name, schema.enum.map(String), false, schema.default?.toString());
  }

  const input = document.createElement('input');
  input.type = 'number';
  input.name = name;
  input.className = 'form-input';
  if (schema.minimum !== undefined) input.min = schema.minimum;
  if (schema.maximum !== undefined) input.max = schema.maximum;
  if (schema.default !== undefined) input.value = schema.default;
  if (schema.type === 'integer') input.step = '1';
  return input;
}

function renderBooleanInput(name, schema) {
  const container = document.createElement('div');
  container.className = 'checkbox-wrap';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.name = name;
  input.id = `field-${name}`;
  input.className = 'form-checkbox';
  if (schema.default !== undefined) input.checked = schema.default;

  const label = document.createElement('label');
  label.htmlFor = `field-${name}`;
  label.className = 'checkbox-label';
  label.textContent = formatFieldName(name);

  container.appendChild(input);
  container.appendChild(label);
  return container;
}

function renderBlobInput(name, schema) {
  const container = document.createElement('div');
  container.className = 'blob-upload';
  container.dataset.blobField = name;

  const dropZone = document.createElement('div');
  dropZone.className = 'blob-drop-zone';

  const input = document.createElement('input');
  input.type = 'file';
  input.name = name;
  input.className = 'form-file blob-file-input';
  if (schema.accept) {
    input.accept = schema.accept.join(',');
  }

  const dropLabel = document.createElement('div');
  dropLabel.className = 'blob-drop-label';
  const acceptText = schema.accept ? schema.accept.join(', ') : 'any file';
  dropLabel.textContent = `Choose file or drag and drop (${acceptText})`;

  dropZone.appendChild(input);
  dropZone.appendChild(dropLabel);
  container.appendChild(dropZone);

  // Info line (max size)
  const info = document.createElement('div');
  info.className = 'blob-info';
  if (schema.maxSize) {
    info.textContent = `Max size: ${formatBytes(schema.maxSize)}`;
    container.appendChild(info);
  }

  // Preview area
  const preview = document.createElement('div');
  preview.className = 'blob-preview';
  preview.style.display = 'none';
  container.appendChild(preview);

  // Status text (for upload progress)
  const status = document.createElement('div');
  status.className = 'blob-status';
  status.style.display = 'none';
  container.appendChild(status);

  // Drag and drop handlers
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) {
      input.files = e.dataTransfer.files;
      input.dispatchEvent(new Event('change'));
    }
  });

  // File selection handler
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) {
      preview.style.display = 'none';
      preview.innerHTML = '';
      status.style.display = 'none';
      return;
    }

    // Validate max size
    if (schema.maxSize && file.size > schema.maxSize) {
      status.textContent = `File too large (${formatBytes(file.size)}). Max: ${formatBytes(schema.maxSize)}.`;
      status.className = 'blob-status blob-status-error';
      status.style.display = '';
      input.value = '';
      return;
    }

    status.style.display = 'none';

    // Show preview for images
    if (file.type.startsWith('image/')) {
      const img = document.createElement('img');
      img.className = 'blob-preview-image';
      img.src = URL.createObjectURL(file);
      img.onload = () => URL.revokeObjectURL(img.src);
      preview.innerHTML = '';
      preview.appendChild(img);

      const fileName = document.createElement('div');
      fileName.className = 'blob-preview-filename';
      fileName.textContent = `${file.name} (${formatBytes(file.size)})`;
      preview.appendChild(fileName);
      preview.style.display = '';
    } else {
      // Non-image file: show name and size
      preview.innerHTML = '';
      const fileName = document.createElement('div');
      fileName.className = 'blob-preview-filename';
      fileName.textContent = `${file.name} (${formatBytes(file.size)}, ${file.type || 'unknown type'})`;
      preview.appendChild(fileName);
      preview.style.display = '';
    }
  });

  return container;
}

function renderDropdown(name, values, allowOther, defaultValue) {
  const container = document.createElement('div');
  container.className = 'dropdown-wrap';

  const select = document.createElement('select');
  select.name = name;
  select.className = 'form-select';

  // Empty option
  const emptyOpt = document.createElement('option');
  emptyOpt.value = '';
  emptyOpt.textContent = '-- Select --';
  select.appendChild(emptyOpt);

  for (const val of values) {
    const opt = document.createElement('option');
    opt.value = val;
    // Display the last segment for long refs like "community.lexicon.calendar.event#inperson"
    opt.textContent = val.includes('#') ? val.split('#').pop() : val;
    if (val === defaultValue) opt.selected = true;
    select.appendChild(opt);
  }

  if (allowOther) {
    const otherOpt = document.createElement('option');
    otherOpt.value = '__other__';
    otherOpt.textContent = 'Other...';
    select.appendChild(otherOpt);

    const otherInput = document.createElement('input');
    otherInput.type = 'text';
    otherInput.name = `${name}__other`;
    otherInput.className = 'form-input other-input';
    otherInput.placeholder = 'Enter custom value...';
    otherInput.style.display = 'none';

    select.addEventListener('change', () => {
      otherInput.style.display = select.value === '__other__' ? '' : 'none';
    });

    container.appendChild(select);
    container.appendChild(otherInput);
  } else {
    container.appendChild(select);
  }

  return container;
}

function renderLanguageDropdown(name) {
  const langs = [
    { code: 'en', label: 'English' },
    { code: 'es', label: 'Spanish' },
    { code: 'fr', label: 'French' },
    { code: 'de', label: 'German' },
    { code: 'it', label: 'Italian' },
    { code: 'pt', label: 'Portuguese' },
    { code: 'ja', label: 'Japanese' },
    { code: 'ko', label: 'Korean' },
    { code: 'zh', label: 'Chinese' },
    { code: 'ar', label: 'Arabic' },
    { code: 'hi', label: 'Hindi' },
    { code: 'ru', label: 'Russian' },
    { code: 'nl', label: 'Dutch' },
    { code: 'sv', label: 'Swedish' },
    { code: 'pl', label: 'Polish' },
    { code: 'tr', label: 'Turkish' },
    { code: 'uk', label: 'Ukrainian' },
    { code: 'th', label: 'Thai' },
    { code: 'vi', label: 'Vietnamese' },
    { code: 'id', label: 'Indonesian' },
  ];

  const container = document.createElement('div');
  container.className = 'dropdown-wrap';

  const select = document.createElement('select');
  select.name = name;
  select.className = 'form-select';

  const emptyOpt = document.createElement('option');
  emptyOpt.value = '';
  emptyOpt.textContent = '-- Select language --';
  select.appendChild(emptyOpt);

  for (const lang of langs) {
    const opt = document.createElement('option');
    opt.value = lang.code;
    opt.textContent = `${lang.label} (${lang.code})`;
    select.appendChild(opt);
  }

  // Other option for custom BCP-47 tags
  const otherOpt = document.createElement('option');
  otherOpt.value = '__other__';
  otherOpt.textContent = 'Other...';
  select.appendChild(otherOpt);

  const otherInput = document.createElement('input');
  otherInput.type = 'text';
  otherInput.name = `${name}__other`;
  otherInput.className = 'form-input other-input';
  otherInput.placeholder = 'BCP-47 tag (e.g. pt-BR)';
  otherInput.style.display = 'none';

  select.addEventListener('change', () => {
    otherInput.style.display = select.value === '__other__' ? '' : 'none';
  });

  container.appendChild(select);
  container.appendChild(otherInput);
  return container;
}

// ============================================================================
// Complex type renderers
// ============================================================================

async function renderRefInput(name, schema, lexicon, depth) {
  const refStr = schema.ref;

  // Determine which lexicon context to use for resolution of nested refs
  let resolvedLexicon = lexicon;
  let resolved = await resolveRef(refStr, lexicon);

  // If it's an external ref, try to get the full lexicon for the ref's namespace
  // so that nested local refs within it can also be resolved
  if (resolved && !refStr.startsWith('#')) {
    const [nsid] = refStr.includes('#') ? refStr.split('#') : [refStr];
    const externalLexicon = await resolveLexicon(nsid);
    if (externalLexicon) {
      resolvedLexicon = externalLexicon;
    }
  }

  if (!resolved) {
    // Couldn't resolve — show labeled fallback with ref info
    const container = document.createElement('div');
    container.className = 'ref-unresolved';

    const hint = document.createElement('div');
    hint.className = 'field-hint';
    hint.textContent = `Reference: ${refStr} (could not resolve schema)`;
    container.appendChild(hint);

    const input = document.createElement('textarea');
    input.name = name;
    input.className = 'form-textarea json-fallback';
    input.rows = 3;
    input.placeholder = `Enter JSON for ${refStr}...`;
    container.appendChild(input);

    return container;
  }

  // If resolved is a string type (like knownValues enum), render it directly
  if (resolved.type === 'string') {
    return renderStringInput(name, resolved);
  }

  // If resolved is an object, render its properties inline with a section header
  if (resolved.type === 'object' && resolved.properties) {
    const container = document.createElement('div');
    container.className = 'ref-resolved';

    // Show the ref source for external refs
    if (!refStr.startsWith('#')) {
      const refHint = document.createElement('div');
      refHint.className = 'ref-source-hint';
      refHint.textContent = refStr;
      container.appendChild(refHint);
    }

    const objectEl = await renderObjectInput(name, resolved, resolvedLexicon, depth + 1);
    container.appendChild(objectEl);
    return container;
  }

  // If resolved is a record type, use its record schema
  if (resolved.type === 'record' && resolved.record) {
    return await renderObjectInput(name, resolved.record, resolvedLexicon, depth + 1);
  }

  // For other types, render inline
  return await renderInput(name, resolved, resolvedLexicon, depth + 1);
}

async function renderUnionInput(name, schema, lexicon, depth) {
  const container = document.createElement('div');
  container.className = 'union-field';

  const refs = schema.refs || [];
  if (refs.length === 0) {
    return renderJsonFallback(name);
  }

  // Pre-resolve all refs to get descriptions and determine if they're resolvable
  const resolvedRefs = new Map();
  const refResolutions = await Promise.allSettled(
    refs.map(async (ref) => {
      const resolved = await resolveRef(ref, lexicon);
      if (resolved) resolvedRefs.set(ref, resolved);
      return { ref, resolved };
    })
  );

  // Type selector
  const selector = document.createElement('select');
  selector.className = 'form-select union-selector';
  selector.dataset.unionField = name;

  const emptyOpt = document.createElement('option');
  emptyOpt.value = '';
  emptyOpt.textContent = '-- Select type --';
  selector.appendChild(emptyOpt);

  for (const ref of refs) {
    const opt = document.createElement('option');
    opt.value = ref;
    // Display a readable name with description if available
    const displayRef = ref.includes('#') ? ref.split('#').pop() : ref.split('.').pop();
    const resolved = resolvedRefs.get(ref);
    const desc = resolved?.description ? ` — ${resolved.description}` : '';
    const unresolved = !resolved ? ' (unresolved)' : '';
    opt.textContent = `${displayRef}${desc}${unresolved}`;
    selector.appendChild(opt);
  }

  container.appendChild(selector);

  // Container for the nested form fields — holds all variant sub-forms
  const subFormContainer = document.createElement('div');
  subFormContainer.className = 'union-subform';
  container.appendChild(subFormContainer);

  // Cache rendered sub-forms for each variant to avoid re-rendering on switch
  const subFormCache = new Map();

  // When user selects a type, render its fields
  selector.addEventListener('change', async () => {
    // Hide all existing sub-forms
    for (const child of subFormContainer.children) {
      child.style.display = 'none';
    }

    const selectedRef = selector.value;
    if (!selectedRef) return;

    // Check cache first
    if (subFormCache.has(selectedRef)) {
      subFormCache.get(selectedRef).style.display = '';
      return;
    }

    const resolved = resolvedRefs.get(selectedRef);
    if (!resolved) {
      // Try resolving again (might have been cached since initial load)
      const freshResolved = await resolveRef(selectedRef, lexicon);
      if (!freshResolved) {
        const hint = document.createElement('div');
        hint.className = 'union-unresolved';
        hint.innerHTML = `<div class="field-hint">Could not resolve <code>${selectedRef}</code>. Use raw JSON.</div>`;
        const fallback = renderJsonFallback(`${name}__union_raw`);
        hint.appendChild(fallback);
        subFormContainer.appendChild(hint);
        subFormCache.set(selectedRef, hint);
        return;
      }
      resolvedRefs.set(selectedRef, freshResolved);
    }

    const def = resolvedRefs.get(selectedRef);

    const variantWrapper = document.createElement('div');
    variantWrapper.className = 'union-variant';
    variantWrapper.dataset.unionType = selectedRef;

    // Show the full NSID ref for context
    const refLabel = document.createElement('div');
    refLabel.className = 'union-variant-ref';
    refLabel.textContent = selectedRef;
    variantWrapper.appendChild(refLabel);

    if (def.type === 'object' && def.properties) {
      const objectEl = await renderObjectInput(name, def, lexicon, depth + 1);
      objectEl.dataset.unionType = selectedRef;
      variantWrapper.appendChild(objectEl);
    } else if (def.type === 'string' || def.type === 'integer' || def.type === 'boolean') {
      const inputEl = await renderInput(name, def, lexicon, depth + 1);
      variantWrapper.appendChild(inputEl);
    } else {
      const inputEl = await renderInput(name, def, lexicon, depth + 1);
      variantWrapper.appendChild(inputEl);
    }

    subFormContainer.appendChild(variantWrapper);
    subFormCache.set(selectedRef, variantWrapper);
  });

  // If there's only one ref option, auto-select it
  if (refs.length === 1) {
    selector.value = refs[0];
    selector.dispatchEvent(new Event('change'));
  }

  return container;
}

async function renderArrayInput(name, schema, lexicon, depth) {
  const container = document.createElement('div');
  container.className = 'array-field';
  container.dataset.arrayField = name;

  const itemSchema = schema.items;
  const isComplexItem = itemSchema && (
    itemSchema.type === 'object' ||
    itemSchema.type === 'union' ||
    itemSchema.type === 'ref'
  );

  if (isComplexItem) {
    container.classList.add('array-field-complex');
  }

  const itemsContainer = document.createElement('div');
  itemsContainer.className = 'array-items';
  container.appendChild(itemsContainer);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn-add-item';

  // Better label based on item type
  const itemTypeLabel = itemSchema?.type === 'union' ? 'variant' :
    itemSchema?.type === 'object' ? 'entry' : 'item';
  addBtn.textContent = `+ Add ${itemTypeLabel}`;

  let itemCount = 0;
  const maxLength = schema.maxLength;

  addBtn.addEventListener('click', async () => {
    if (maxLength && itemCount >= maxLength) return;

    const itemWrapper = document.createElement('div');
    itemWrapper.className = 'array-item';
    if (isComplexItem) itemWrapper.classList.add('array-item-complex');
    itemWrapper.dataset.arrayIndex = itemCount;

    // Item header with index and remove button
    const itemHeader = document.createElement('div');
    itemHeader.className = 'array-item-header';

    const indexLabel = document.createElement('span');
    indexLabel.className = 'array-item-index';
    indexLabel.textContent = `#${itemCount + 1}`;
    itemHeader.appendChild(indexLabel);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn-remove-item';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      itemWrapper.remove();
      itemCount--;
      updateCounter();
      // Re-number remaining items
      const remaining = itemsContainer.querySelectorAll('.array-item');
      remaining.forEach((item, i) => {
        item.dataset.arrayIndex = i;
        const idx = item.querySelector('.array-item-index');
        if (idx) idx.textContent = `#${i + 1}`;
      });
    });
    itemHeader.appendChild(removeBtn);

    if (isComplexItem) {
      itemWrapper.appendChild(itemHeader);
    }

    // Render the item input
    const itemContent = document.createElement('div');
    itemContent.className = 'array-item-content';

    if (itemSchema) {
      const itemInput = await renderInput(`${name}[${itemCount}]`, itemSchema, lexicon, depth + 1);
      if (itemInput) itemContent.appendChild(itemInput);
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.name = `${name}[${itemCount}]`;
      input.className = 'form-input';
      itemContent.appendChild(input);
    }

    itemWrapper.appendChild(itemContent);

    // For simple items, put remove button inline
    if (!isComplexItem) {
      const removeBtn2 = document.createElement('button');
      removeBtn2.type = 'button';
      removeBtn2.className = 'btn-remove-item';
      removeBtn2.textContent = 'Remove';
      removeBtn2.addEventListener('click', () => {
        itemWrapper.remove();
        itemCount--;
        updateCounter();
      });
      itemWrapper.appendChild(removeBtn2);
    }

    itemsContainer.appendChild(itemWrapper);
    itemCount++;
    updateCounter();
  });

  const counterEl = document.createElement('div');
  counterEl.className = 'array-counter';

  function updateCounter() {
    if (maxLength) {
      counterEl.textContent = `${itemCount} / ${maxLength} items`;
      addBtn.disabled = itemCount >= maxLength;
    } else {
      counterEl.textContent = itemCount > 0 ? `${itemCount} ${itemTypeLabel}${itemCount !== 1 ? 's' : ''}` : '';
    }
  }

  container.appendChild(addBtn);
  container.appendChild(counterEl);
  return container;
}

async function renderObjectInput(name, schema, lexicon, depth) {
  const container = document.createElement('div');
  container.className = 'object-field';
  container.dataset.objectField = name;
  if (depth > 1) container.classList.add('object-field-deep');

  const { properties, required = [] } = schema;
  if (!properties) return renderJsonFallback(name);

  const propCount = Object.keys(properties).length;

  // For deeply nested objects with multiple properties, make collapsible
  if (depth >= 2 && propCount > 2) {
    container.classList.add('collapsible');

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'object-collapse-toggle';
    toggle.setAttribute('aria-expanded', 'true');
    toggle.innerHTML = `<span class="collapse-icon">&#9660;</span> ${propCount} fields`;

    const content = document.createElement('div');
    content.className = 'object-collapse-content';

    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!expanded));
      content.classList.toggle('collapsed', expanded);
      toggle.querySelector('.collapse-icon').innerHTML = expanded ? '&#9654;' : '&#9660;';
    });

    container.appendChild(toggle);

    // Sort fields: required first, then alphabetical
    const sortedNames = Object.keys(properties).sort((a, b) => {
      const aReq = required.includes(a);
      const bReq = required.includes(b);
      if (aReq && !bReq) return -1;
      if (!aReq && bReq) return 1;
      return a.localeCompare(b);
    });

    for (const propName of sortedNames) {
      const propSchema = properties[propName];
      const isRequired = required.includes(propName);
      const fieldEl = await renderField(propName, propSchema, isRequired, lexicon, depth + 1);
      content.appendChild(fieldEl);
    }

    container.appendChild(content);
  } else {
    for (const [propName, propSchema] of Object.entries(properties)) {
      const isRequired = required.includes(propName);
      const fieldEl = await renderField(propName, propSchema, isRequired, lexicon, depth + 1);
      container.appendChild(fieldEl);
    }
  }

  return container;
}

function renderJsonFallback(name) {
  const textarea = document.createElement('textarea');
  textarea.name = name;
  textarea.className = 'form-textarea json-fallback';
  textarea.rows = 3;
  textarea.placeholder = 'Enter JSON value...';
  return textarea;
}

// ============================================================================
// Form Data Collection
// ============================================================================

/**
 * Collect form data into a record object suitable for createRecord.
 *
 * @param {HTMLFormElement} form
 * @param {Object} schema - The record's object schema
 * @param {Object} lexicon - The full lexicon for resolving refs
 * @param {string} nsid - The lexicon NSID (used for $type)
 * @returns {Promise<Object>} The record object
 */
export async function collectFormData(form, schema, lexicon, nsid, options = {}) {
  // Bluesky post uses specialized collector
  if (isBlueskyPost(nsid) && form.classList.contains('bsky-post-form')) {
    return collectBlueskyPostData(form, nsid, options.uploadBlobFn);
  }

  const record = { $type: nsid };
  const { properties = {}, required = [] } = schema;

  for (const [name, fieldSchema] of Object.entries(properties)) {
    const value = await collectFieldValue(form, name, fieldSchema, lexicon);
    if (value !== undefined && value !== null && value !== '') {
      record[name] = value;
    }
  }

  // Process rich text facets for known post types
  if (record.text && (nsid === 'app.bsky.feed.post')) {
    const facets = await detectFacets(record.text);
    if (facets.length > 0) {
      record.facets = facets;
    }
  }

  // Ensure datetime fields are proper ISO strings
  for (const [name, fieldSchema] of Object.entries(properties)) {
    if (fieldSchema.type === 'string' && fieldSchema.format === 'datetime' && record[name]) {
      // datetime-local gives us "2026-02-19T12:00" — convert to full ISO
      if (!record[name].endsWith('Z') && !record[name].includes('+')) {
        record[name] = new Date(record[name]).toISOString();
      }
    }
  }

  // Upload any blob fields (must happen just before createRecord to avoid expiry)
  if (options.uploadBlobFn) {
    await uploadBlobFields(record, properties, options.uploadBlobFn, lexicon);
  }

  // Client-side validation
  const errors = validateRecord(record, schema);
  if (errors.length > 0) {
    throw new Error(`Validation errors:\n${errors.join('\n')}`);
  }

  return record;
}

/**
 * Recursively find and upload blob fields in a record, replacing __file markers
 * with actual blob references from the PDS.
 */
async function uploadBlobFields(obj, properties, uploadBlobFn, lexicon) {
  if (!obj || typeof obj !== 'object') return;

  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === 'object' && value.__file) {
      // This is a blob field — upload it
      const file = value.__file;
      try {
        const result = await uploadBlobFn(file);
        obj[key] = result.blob;
      } catch (err) {
        throw new Error(`Failed to upload blob for "${key}": ${err.message}`);
      }
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Recurse into nested objects
      const propSchema = properties?.[key];
      const nestedProps = propSchema?.type === 'object' ? propSchema.properties : null;
      await uploadBlobFields(value, nestedProps || {}, uploadBlobFn, lexicon);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object') {
          await uploadBlobFields(item, {}, uploadBlobFn, lexicon);
        }
      }
    }
  }
}

/**
 * Validate a record against its schema constraints.
 * Returns an array of error strings (empty = valid).
 */
function validateRecord(record, schema) {
  const errors = [];
  if (!schema || !schema.properties) return errors;

  const { properties, required = [] } = schema;

  // Check required fields
  for (const name of required) {
    const val = record[name];
    if (val === undefined || val === null || val === '') {
      errors.push(`"${formatFieldName(name)}" is required`);
    }
  }

  // Check field constraints
  for (const [name, fieldSchema] of Object.entries(properties)) {
    const val = record[name];
    if (val === undefined || val === null) continue;

    if (fieldSchema.type === 'string' && typeof val === 'string') {
      if (fieldSchema.maxLength !== undefined && new TextEncoder().encode(val).length > fieldSchema.maxLength) {
        errors.push(`"${formatFieldName(name)}" exceeds max length of ${fieldSchema.maxLength} bytes`);
      }
      if (fieldSchema.minLength !== undefined && new TextEncoder().encode(val).length < fieldSchema.minLength) {
        errors.push(`"${formatFieldName(name)}" is shorter than min length of ${fieldSchema.minLength} bytes`);
      }
      if (fieldSchema.maxGraphemes !== undefined) {
        const graphemes = countGraphemes(val);
        if (graphemes > fieldSchema.maxGraphemes) {
          errors.push(`"${formatFieldName(name)}" exceeds max of ${fieldSchema.maxGraphemes} graphemes (has ${graphemes})`);
        }
      }
      if (fieldSchema.minGraphemes !== undefined) {
        const graphemes = countGraphemes(val);
        if (graphemes < fieldSchema.minGraphemes) {
          errors.push(`"${formatFieldName(name)}" is shorter than min of ${fieldSchema.minGraphemes} graphemes`);
        }
      }
    }

    if ((fieldSchema.type === 'integer' || fieldSchema.type === 'number') && typeof val === 'number') {
      if (fieldSchema.minimum !== undefined && val < fieldSchema.minimum) {
        errors.push(`"${formatFieldName(name)}" must be at least ${fieldSchema.minimum}`);
      }
      if (fieldSchema.maximum !== undefined && val > fieldSchema.maximum) {
        errors.push(`"${formatFieldName(name)}" must be at most ${fieldSchema.maximum}`);
      }
    }

    if (fieldSchema.type === 'array' && Array.isArray(val)) {
      if (fieldSchema.maxLength !== undefined && val.length > fieldSchema.maxLength) {
        errors.push(`"${formatFieldName(name)}" has too many items (max ${fieldSchema.maxLength})`);
      }
      if (fieldSchema.minLength !== undefined && val.length < fieldSchema.minLength) {
        errors.push(`"${formatFieldName(name)}" needs at least ${fieldSchema.minLength} items`);
      }
    }
  }

  return errors;
}

async function collectFieldValue(form, name, schema, lexicon) {
  const type = schema.type;

  // Handle const
  if (schema.const !== undefined) return schema.const;

  // Handle ref — collect nested object
  if (type === 'ref') {
    const resolved = await resolveRef(schema.ref, lexicon);
    if (resolved?.type === 'object') {
      return collectObjectValue(form, name, resolved, lexicon);
    }
    if (resolved?.type === 'string') {
      return collectSimpleValue(form, name, resolved);
    }
    return collectSimpleValue(form, name, schema);
  }

  // Handle union
  if (type === 'union') {
    return collectUnionValue(form, name, schema, lexicon);
  }

  // Handle array
  if (type === 'array') {
    return collectArrayValue(form, name, schema, lexicon);
  }

  // Handle object
  if (type === 'object') {
    return collectObjectValue(form, name, schema, lexicon);
  }

  // Handle boolean
  if (type === 'boolean') {
    const checkbox = form.querySelector(`[name="${name}"]`);
    return checkbox ? checkbox.checked : undefined;
  }

  // Handle number/integer
  if (type === 'integer' || type === 'number') {
    const input = form.querySelector(`[name="${name}"]`);
    if (!input || input.value === '') return undefined;
    return type === 'integer' ? parseInt(input.value, 10) : parseFloat(input.value);
  }

  // Handle blob
  if (type === 'blob') {
    // Return file info — actual upload happens in the submit handler
    const fileInput = form.querySelector(`[name="${name}"]`);
    if (fileInput?.files?.length > 0) {
      return { __file: fileInput.files[0] };
    }
    return undefined;
  }

  // Handle string (including format variants, enums, etc.)
  return collectSimpleValue(form, name, schema);
}

function collectSimpleValue(form, name, schema) {
  // Check for dropdown with "Other" option
  const select = form.querySelector(`select[name="${name}"]`);
  if (select) {
    if (select.value === '__other__') {
      const otherInput = form.querySelector(`[name="${name}__other"]`);
      return otherInput?.value || undefined;
    }
    return select.value || undefined;
  }

  const input = form.querySelector(`[name="${name}"]`);
  if (!input) return undefined;

  const val = input.value;
  return val || undefined;
}

async function collectObjectValue(form, name, schema, lexicon) {
  const container = form.querySelector(`[data-object-field="${name}"]`);
  if (!container) return undefined;

  const obj = {};
  const { properties = {} } = schema;
  let hasValue = false;

  for (const [propName, propSchema] of Object.entries(properties)) {
    const val = await collectFieldValue(container, propName, propSchema, lexicon);
    if (val !== undefined && val !== null && val !== '') {
      obj[propName] = val;
      hasValue = true;
    }
  }

  return hasValue ? obj : undefined;
}

async function collectUnionValue(form, name, schema, lexicon) {
  const selector = form.querySelector(`[data-union-field="${name}"]`);
  if (!selector || !selector.value) return undefined;

  const selectedRef = selector.value;

  // Find the active variant container (the one that's visible)
  const unionField = selector.closest('.union-field');
  if (!unionField) return undefined;

  const subformContainer = unionField.querySelector('.union-subform');
  if (!subformContainer) return undefined;

  // Find the visible variant
  const activeVariant = subformContainer.querySelector(`.union-variant[data-union-type="${selectedRef}"]`)
    || subformContainer.querySelector(`[data-union-type="${selectedRef}"]`);

  if (activeVariant) {
    // Find the object-field within the variant
    const objectField = activeVariant.querySelector('[data-object-field]')
      || (activeVariant.dataset.objectField ? activeVariant : null);

    if (objectField) {
      const resolved = await resolveRef(selectedRef, lexicon);
      if (resolved?.type === 'object') {
        // Use the variant container as the form context for collecting values
        const searchContext = activeVariant;
        const obj = await collectObjectValue(searchContext, name, resolved, lexicon);
        if (obj) {
          obj.$type = selectedRef;
          return obj;
        }
      }
    }

    // Check for raw JSON fallback in unresolved unions
    const rawTextarea = activeVariant.querySelector(`[name="${name}__union_raw"]`);
    if (rawTextarea && rawTextarea.value.trim()) {
      try {
        const parsed = JSON.parse(rawTextarea.value);
        parsed.$type = selectedRef;
        return parsed;
      } catch {
        throw new Error(`Invalid JSON for union field "${name}"`);
      }
    }
  }

  // Legacy fallback: look for any object-field in the subform
  const legacySubform = subformContainer.querySelector('[data-object-field]');
  if (legacySubform) {
    const resolved = await resolveRef(selectedRef, lexicon);
    if (resolved?.type === 'object') {
      const obj = await collectObjectValue(subformContainer, name, resolved, lexicon);
      if (obj) {
        obj.$type = selectedRef;
        return obj;
      }
    }
  }

  return undefined;
}

async function collectArrayValue(form, name, schema, lexicon) {
  const container = form.querySelector(`[data-array-field="${name}"]`);
  if (!container) return undefined;

  const items = container.querySelectorAll(':scope > .array-items > .array-item');
  if (items.length === 0) return undefined;

  const itemSchema = schema.items;
  const values = [];

  for (const item of items) {
    const content = item.querySelector('.array-item-content') || item;

    // Handle union items
    if (itemSchema?.type === 'union') {
      const unionSelector = content.querySelector('.union-selector');
      if (unionSelector && unionSelector.value) {
        const unionVal = await collectUnionValue(content, name, itemSchema, lexicon);
        if (unionVal) values.push(unionVal);
      }
      continue;
    }

    // Handle object items
    if (itemSchema?.type === 'object') {
      const objectField = content.querySelector('[data-object-field]');
      if (objectField) {
        const objVal = await collectObjectValue(content, objectField.dataset.objectField, itemSchema, lexicon);
        if (objVal) values.push(objVal);
      }
      continue;
    }

    // Handle ref items
    if (itemSchema?.type === 'ref') {
      const resolved = await resolveRef(itemSchema.ref, lexicon);
      if (resolved?.type === 'object') {
        const objectField = content.querySelector('[data-object-field]');
        if (objectField) {
          const objVal = await collectObjectValue(content, objectField.dataset.objectField, resolved, lexicon);
          if (objVal) values.push(objVal);
          continue;
        }
      }
    }

    // Handle blob items
    if (itemSchema?.type === 'blob') {
      const fileInput = content.querySelector('input[type="file"]');
      if (fileInput?.files?.length > 0) {
        values.push({ __file: fileInput.files[0] });
      }
      continue;
    }

    // Simple types
    const input = content.querySelector('input, textarea, select');
    if (input && input.value) {
      if (itemSchema?.type === 'integer') {
        values.push(parseInt(input.value, 10));
      } else if (itemSchema?.type === 'number') {
        values.push(parseFloat(input.value));
      } else if (itemSchema?.type === 'boolean') {
        values.push(input.checked);
      } else {
        values.push(input.value);
      }
    }
  }

  return values.length > 0 ? values : undefined;
}

// ============================================================================
// Rich Text Facet Detection
// ============================================================================

/**
 * Detect mentions, links, and hashtags in text and generate facets.
 * @param {string} text
 * @returns {Promise<Array>} Facets array for app.bsky.feed.post
 */
async function detectFacets(text) {
  const encoder = new TextEncoder();
  const facets = [];

  // Detect URLs
  const urlRegex = /https?:\/\/[^\s)>\]]+/g;
  let match;
  while ((match = urlRegex.exec(text)) !== null) {
    const beforeBytes = encoder.encode(text.slice(0, match.index));
    const matchBytes = encoder.encode(match[0]);
    facets.push({
      index: {
        byteStart: beforeBytes.length,
        byteEnd: beforeBytes.length + matchBytes.length,
      },
      features: [{
        $type: 'app.bsky.richtext.facet#link',
        uri: match[0],
      }],
    });
  }

  // Detect mentions (@handle.domain)
  const mentionRegex = /(?<![a-zA-Z0-9])@([a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/g;
  while ((match = mentionRegex.exec(text)) !== null) {
    const beforeBytes = encoder.encode(text.slice(0, match.index));
    const matchBytes = encoder.encode(match[0]);
    // Attempt to resolve handle to DID (best-effort)
    let did = null;
    try {
      const res = await fetch(
        `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(match[1])}`
      );
      if (res.ok) {
        const data = await res.json();
        did = data.did;
      }
    } catch {}

    if (did) {
      facets.push({
        index: {
          byteStart: beforeBytes.length,
          byteEnd: beforeBytes.length + matchBytes.length,
        },
        features: [{
          $type: 'app.bsky.richtext.facet#mention',
          did,
        }],
      });
    }
  }

  // Detect hashtags
  const tagRegex = /(?<![a-zA-Z0-9])#([^\s#\p{P}]+)/gu;
  while ((match = tagRegex.exec(text)) !== null) {
    // Skip if it looks like a hex color
    if (/^[0-9a-fA-F]{3,8}$/.test(match[1])) continue;

    const beforeBytes = encoder.encode(text.slice(0, match.index));
    const matchBytes = encoder.encode(match[0]);
    facets.push({
      index: {
        byteStart: beforeBytes.length,
        byteEnd: beforeBytes.length + matchBytes.length,
      },
      features: [{
        $type: 'app.bsky.richtext.facet#tag',
        tag: match[1],
      }],
    });
  }

  return facets;
}

// ============================================================================
// Raw JSON Editor mode
// ============================================================================

/**
 * Create a raw JSON editor for manual record construction.
 * @param {string} nsid
 * @returns {HTMLElement}
 */
export function createRawJsonEditor(nsid) {
  const container = document.createElement('div');
  container.className = 'raw-json-editor';

  const label = document.createElement('label');
  label.className = 'field-label';
  label.textContent = 'Record JSON';
  container.appendChild(label);

  const hint = document.createElement('div');
  hint.className = 'field-hint';
  hint.textContent = 'Enter the full record JSON. $type will be added automatically.';
  container.appendChild(hint);

  const textarea = document.createElement('textarea');
  textarea.className = 'form-textarea json-editor';
  textarea.name = '__raw_json';
  textarea.rows = 12;
  textarea.spellcheck = false;
  textarea.value = JSON.stringify({
    $type: nsid,
    createdAt: new Date().toISOString(),
  }, null, 2);
  container.appendChild(textarea);

  return container;
}

/**
 * Parse the raw JSON editor value.
 * @param {HTMLElement} container
 * @param {string} nsid
 * @returns {Object}
 */
export function parseRawJson(container, nsid) {
  const textarea = container.querySelector('[name="__raw_json"]');
  if (!textarea) throw new Error('No JSON editor found');

  const parsed = JSON.parse(textarea.value);
  parsed.$type = nsid;
  return parsed;
}

// ============================================================================
// NSID Friendly Name Utility
// ============================================================================

/**
 * Well-known AT Protocol lexicon NSIDs mapped to human-readable names.
 */
const FRIENDLY_NAMES = {
  'app.bsky.feed.post': 'Post',
  'app.bsky.feed.like': 'Like',
  'app.bsky.feed.repost': 'Repost',
  'app.bsky.feed.generator': 'Feed Generator',
  'app.bsky.feed.threadgate': 'Thread Gate',
  'app.bsky.feed.postgate': 'Post Gate',
  'app.bsky.graph.follow': 'Follow',
  'app.bsky.graph.block': 'Block',
  'app.bsky.graph.list': 'List',
  'app.bsky.graph.listitem': 'List Item',
  'app.bsky.graph.listblock': 'List Block',
  'app.bsky.graph.starterpack': 'Starter Pack',
  'app.bsky.actor.profile': 'Profile',
  'app.bsky.labeler.service': 'Labeler',
  'chat.bsky.actor.declaration': 'Chat Settings',
  'com.whtwnd.blog.entry': 'Blog Entry',
  'blue.linkat.board': 'Board',
  'fyi.frontpage.post': 'Frontpage Post',
  'site.standard.publication': 'Publication',
  'site.standard.document': 'Document',
  'site.standard.graph.subscription': 'Subscription',
};

/**
 * Convert an AT Protocol NSID to a human-readable friendly name.
 *
 * Uses a tiered strategy:
 * 1. Hardcoded lookup for well-known lexicons
 * 2. Smart parsing fallback: takes the last NSID segment,
 *    splits camelCase, and title-cases the result.
 *
 * @param {string} nsid - The lexicon NSID (e.g. "app.bsky.feed.post")
 * @returns {string} A human-readable name (e.g. "Post")
 */
export function nsidToFriendlyName(nsid) {
  if (FRIENDLY_NAMES[nsid]) return FRIENDLY_NAMES[nsid];

  const parts = nsid.split('.');
  const last = parts[parts.length - 1];

  // Split camelCase and capitalize
  return last
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, c => c.toUpperCase());
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format a camelCase or snake_case field name for display.
 */
function formatFieldName(name) {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Check if a lexicon is a record type (can have records created).
 */
export function isRecordType(lexicon) {
  return lexicon?.defs?.main?.type === 'record';
}
