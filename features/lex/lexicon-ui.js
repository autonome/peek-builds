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

  // Render the appropriate input based on schema type
  const input = await renderInput(name, schema, lexicon, depth);
  if (input) {
    wrapper.appendChild(input);
  }

  return wrapper;
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

  const input = document.createElement('input');
  input.type = 'file';
  input.name = name;
  input.className = 'form-file';
  if (schema.accept) {
    input.accept = schema.accept.join(',');
  }

  const info = document.createElement('div');
  info.className = 'blob-info';
  if (schema.maxSize) {
    info.textContent = `Max size: ${formatBytes(schema.maxSize)}`;
  }

  container.appendChild(input);
  if (schema.maxSize) container.appendChild(info);
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
  const resolved = await resolveRef(refStr, lexicon);

  if (!resolved) {
    // Couldn't resolve — show text input with hint
    const input = document.createElement('input');
    input.type = 'text';
    input.name = name;
    input.className = 'form-input';
    input.placeholder = `Reference: ${refStr} (could not resolve)`;
    return input;
  }

  // If resolved is a string type (like knownValues enum), render it directly
  if (resolved.type === 'string') {
    return renderStringInput(name, resolved);
  }

  // If resolved is an object, render its properties inline
  if (resolved.type === 'object' && resolved.properties) {
    return await renderObjectInput(name, resolved, lexicon, depth + 1);
  }

  // For other types, render inline
  return await renderInput(name, resolved, lexicon, depth + 1);
}

async function renderUnionInput(name, schema, lexicon, depth) {
  const container = document.createElement('div');
  container.className = 'union-field';

  const refs = schema.refs || [];
  if (refs.length === 0) {
    return renderJsonFallback(name);
  }

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
    // Display a readable name
    const displayRef = ref.includes('#') ? ref.split('#').pop() : ref.split('.').pop();
    opt.textContent = displayRef;
    selector.appendChild(opt);
  }

  container.appendChild(selector);

  // Container for the nested form fields
  const subFormContainer = document.createElement('div');
  subFormContainer.className = 'union-subform';
  container.appendChild(subFormContainer);

  // When user selects a type, render its fields
  selector.addEventListener('change', async () => {
    subFormContainer.innerHTML = '';
    const selectedRef = selector.value;
    if (!selectedRef) return;

    const resolved = await resolveRef(selectedRef, lexicon);
    if (!resolved) {
      subFormContainer.innerHTML = '<div class="field-hint">Could not resolve this type. Use raw JSON.</div>';
      return;
    }

    if (resolved.type === 'object' && resolved.properties) {
      const objectEl = await renderObjectInput(name, resolved, lexicon, depth + 1);
      // Mark with $type
      objectEl.dataset.unionType = selectedRef;
      subFormContainer.appendChild(objectEl);
    } else {
      const inputEl = await renderInput(name, resolved, lexicon, depth + 1);
      subFormContainer.appendChild(inputEl);
    }
  });

  return container;
}

async function renderArrayInput(name, schema, lexicon, depth) {
  const container = document.createElement('div');
  container.className = 'array-field';
  container.dataset.arrayField = name;

  const itemsContainer = document.createElement('div');
  itemsContainer.className = 'array-items';
  container.appendChild(itemsContainer);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn-add-item';
  addBtn.textContent = '+ Add item';

  let itemCount = 0;
  const maxLength = schema.maxLength;

  addBtn.addEventListener('click', async () => {
    if (maxLength && itemCount >= maxLength) return;

    const itemWrapper = document.createElement('div');
    itemWrapper.className = 'array-item';

    const itemSchema = schema.items;
    if (itemSchema) {
      const itemInput = await renderInput(`${name}[${itemCount}]`, itemSchema, lexicon, depth + 1);
      if (itemInput) itemWrapper.appendChild(itemInput);
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.name = `${name}[${itemCount}]`;
      input.className = 'form-input';
      itemWrapper.appendChild(input);
    }

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn-remove-item';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      itemWrapper.remove();
      itemCount--;
      updateCounter();
    });
    itemWrapper.appendChild(removeBtn);

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
      counterEl.textContent = itemCount > 0 ? `${itemCount} item${itemCount !== 1 ? 's' : ''}` : '';
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

  const { properties, required = [] } = schema;
  if (!properties) return renderJsonFallback(name);

  for (const [propName, propSchema] of Object.entries(properties)) {
    const isRequired = required.includes(propName);
    const fieldEl = await renderField(propName, propSchema, isRequired, lexicon, depth + 1);
    container.appendChild(fieldEl);
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
export async function collectFormData(form, schema, lexicon, nsid) {
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

  return record;
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
  const subform = form.querySelector(`[data-union-field="${name}"]`)
    ?.closest('.union-field')
    ?.querySelector('.union-subform [data-object-field]');

  if (subform) {
    const resolved = await resolveRef(selectedRef, lexicon);
    if (resolved?.type === 'object') {
      const obj = await collectObjectValue(subform.closest('.union-subform'), name, resolved, lexicon);
      if (obj) {
        obj.$type = selectedRef;
        return obj;
      }
    }
  }

  return undefined;
}

function collectArrayValue(form, name, schema, lexicon) {
  const container = form.querySelector(`[data-array-field="${name}"]`);
  if (!container) return undefined;

  const items = container.querySelectorAll('.array-item');
  if (items.length === 0) return undefined;

  const values = [];
  items.forEach((item, i) => {
    const input = item.querySelector('input, textarea, select');
    if (input && input.value) {
      // For simple types
      if (schema.items?.type === 'integer') {
        values.push(parseInt(input.value, 10));
      } else if (schema.items?.type === 'number') {
        values.push(parseFloat(input.value));
      } else {
        values.push(input.value);
      }
    }
  });

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
