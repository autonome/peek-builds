/**
 * Block rows for the tag-query view: what one item's block contains and how it
 * is rendered.
 *
 * blockRowsModel() decides the type, title and rows without touching the DOM,
 * so the choice is unit tested. createBlockRenderer() turns that model into
 * elements, using the shared card helpers, affordance module and markdown
 * renderer (loaded on first use so the model stays importable in node).
 */

/** Item types that appear in the query document; every other type is left out. */
export const BLOCK_TYPES = ['text', 'url', 'image'];

const HEADING_MARKER = /^#+\s*/;
const NO_TITLE = '\u0000no-title';

function firstLine(text) {
  return (typeof text === 'string' ? text : '').split('\n').find(line => line.trim()) || '';
}

function stripHeading(line) {
  return line.replace(HEADING_MARKER, '').trim();
}

/** Parsed metadata object; an unparseable or missing value is {}. */
function metadataOf(item) {
  if (item.metadata && typeof item.metadata === 'object') return item.metadata;
  if (typeof item.metadata !== 'string') return {};
  try {
    const parsed = JSON.parse(item.metadata);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Notes of a url or image item: the `notes` metadata field. */
export function notesOf(item) {
  const notes = metadataOf(item).notes;
  return typeof notes === 'string' ? notes.trim() : '';
}

/** Where an image item's picture is loaded from, or null when it has none. */
export function imageSource(item) {
  const meta = metadataOf(item);
  const candidates = [item.content, meta.src, meta.url];
  for (const value of candidates) {
    if (typeof value === 'string' && /^(https:\/\/|data:image\/|peek:\/\/)/i.test(value.trim())) {
      return value.trim();
    }
  }
  if (item.thumbnail) return `peek://thumbnail/${item.thumbnail}`;
  return null;
}

/** True when the item's type is shown in the query document. */
export function isBlockItem(item) {
  return !!item && BLOCK_TYPES.includes(item.type);
}

/**
 * What a block holds for an item. Returns null for a type that is left out.
 *
 * `rows` lists the rows in order; a folded block shows only the first row. Url
 * and image blocks start with a 'title' row; a text block is one 'body' row of
 * its full content (its title only feeds the outline). Titles: text uses the stored title, else the first content line
 * without its heading marker; url uses the stored title, else the first line
 * of its notes, else the URL; image uses the stored title, else the first line
 * of its notes, else 'Image'. An empty text item is 'Untitled'.
 *
 * @param {object} item
 * @param {(item: object, fallback?: string) => string} [extractTitle] the shared
 *   card-helpers `extractTitle`; without it the stored title or the title in
 *   the item's metadata is read, the same precedence
 * @returns {{type: string, title: string, rows: string[], bodyMarkdown?: string,
 *   url?: string, notes?: string, imageSrc?: string|null}|null}
 */
export function blockRowsModel(item, extractTitle) {
  if (!isBlockItem(item)) return null;

  // extractTitle returns its fallback when the item has no title of its own.
  const raw = extractTitle
    ? extractTitle(item, NO_TITLE)
    : (item.title || metadataOf(item).title || NO_TITLE);
  const ownTitle = raw === NO_TITLE || typeof raw !== 'string' ? '' : stripHeading(raw);

  if (item.type === 'text') {
    const content = typeof item.content === 'string' ? item.content : '';
    const title = ownTitle || stripHeading(firstLine(content)) || 'Untitled';
    // The title is only for the outline; the body shows the whole content.
    return {
      type: 'text',
      title,
      rows: ['body'],
      bodyMarkdown: content.trim(),
    };
  }

  const notes = notesOf(item);
  const notesFirst = stripHeading(firstLine(notes));

  if (item.type === 'url') {
    const url = typeof item.content === 'string' ? item.content.trim() : '';
    const title = ownTitle || notesFirst || url || 'Untitled';
    return {
      type: 'url',
      title,
      rows: notes ? ['title', 'link', 'notes'] : ['title', 'link'],
      url,
      notes,
    };
  }

  const imageSrc = imageSource(item);
  const title = ownTitle || notesFirst || 'Image';
  const rows = ['title'];
  if (imageSrc) rows.push('image');
  if (notes) rows.push('notes');
  return { type: 'image', title, rows, imageSrc, notes };
}

/**
 * Renderer for the surface: `(item) => {left, title, body} | null`.
 *
 * @param {object} deps
 * @param {object} deps.api window.app
 * @param {() => object[]} deps.getRules current affordance rules
 * @param {(itemId: string) => string[]} deps.getTagNames the item's tag names
 * @param {(itemId: string, affordance: object) => void} [deps.onToggle] runs after a
 *   checkbox click published its tag action; `affordance.checked` is the new state
 */
export async function createBlockRenderer({ api, getRules, getTagNames, onToggle }) {
  const { extractTitle, getItemDisplayInfo, createUrlSpan, createFaviconEl } =
    await import('peek://app/lib/card-helpers.js');
  const { createAffordanceElements } = await import('peek://app/lib/tag-action-affordances.js');
  const { renderMarkdown } = await import('./preview-sidebar.js');

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  return function renderBlock(item) {
    const model = blockRowsModel(item, extractTitle);
    if (!model) return null;

    const left = el('div', 'qs-block-left');
    const affordances = createAffordanceElements(item.id, getTagNames(item.id), getRules(), api, { onToggle });
    if (affordances) left.appendChild(affordances);

    const isText = model.type === 'text';
    const title = el('div', isText ? 'qs-block-title qs-title-hidden' : 'qs-block-title', model.title);

    const body = el('div', isText ? 'qs-block-body qs-body-text' : 'qs-block-body');
    for (const row of model.rows.filter(r => r !== 'title')) {
      if (row === 'body') {
        const md = el('div', 'qs-md');
        md.innerHTML = renderMarkdown(model.bodyMarkdown);
        body.appendChild(md);
      } else if (row === 'link') {
        const info = getItemDisplayInfo(item);
        const link = el('div', 'qs-link');
        link.append(createFaviconEl(info.faviconUrl), createUrlSpan(info.subtitle || model.url));
        body.appendChild(link);
      } else if (row === 'image') {
        const img = el('img', 'qs-image');
        img.src = model.imageSrc;
        img.alt = model.title;
        img.draggable = false;
        body.appendChild(img);
      } else if (row === 'notes') {
        body.appendChild(el('div', 'qs-notes', model.notes));
      }
    }
    return { left, title, body };
  };
}
