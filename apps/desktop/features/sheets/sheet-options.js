/**
 * Per-sheet display options, read from a sheet's saved config.
 *
 * Pure leaf module (no DOM, no electron) so it can be unit tested directly.
 * A config that predates these fields has neither one, and reads as today's
 * behaviour: not maximized, opaque theme background.
 */

export const BACKGROUND_KINDS = ['opaque', 'transparent', 'image'];

/**
 * Resolve the display options of a sheet config, filling in defaults.
 * Never throws; unknown or malformed values fall back to the defaults.
 *
 * @param {object|null|undefined} config saved sheet config
 * @returns {{maximized: boolean, background: {kind: string, image?: string}}}
 */
export const resolveSheetOptions = (config) => {
  const maximized = config?.maximized === true;
  const bg = config?.background;
  const kind = BACKGROUND_KINDS.includes(bg?.kind) ? bg.kind : 'opaque';
  const background = { kind };
  if (kind === 'image') {
    if (typeof bg.image === 'string' && bg.image) {
      background.image = bg.image;
    } else {
      // An image background with no image chosen has nothing to show.
      background.kind = 'opaque';
    }
  }
  return { maximized, background };
};

/**
 * Window-open parameters that realise a sheet's options when it opens.
 * `maximized` is read by the page-host path and `maximize` by the plain
 * window path; both ask for the same thing. Transparency is a creation-time
 * window option.
 *
 * @param {object|null|undefined} config saved sheet config
 * A sheet is a transient window, like a peek: `role: 'quick-view'` with
 * `modal: true` makes it close when focus goes to any other window.
 *
 * `type: 'panel'` matches what peeks pass; main treats a transient panel as a
 * user-gesture open, so a hotkey press raises it over another frontmost app.
 * `center` places it. `pageHost` stays off: a page host gets no tile preload,
 * so the sheet page would lose the tile API and could not read its saved
 * sheets.
 *
 * @returns {{role: 'quick-view', modal: true, type: 'panel', center: true, maximized?: true, maximize?: true, transparent?: true}}
 */
export const windowParamsForSheet = (config) => {
  const { maximized, background } = resolveSheetOptions(config);
  const params = { role: 'quick-view', modal: true, type: 'panel', center: true };
  if (maximized) {
    params.maximized = true;
    params.maximize = true;
  }
  if (background.kind === 'transparent') params.transparent = true;
  return params;
};

/**
 * CSS `background` value that paints a sheet's background on the page root and
 * body. Opaque returns no override, so the stylesheet's theme background
 * stays. Transparent clears it so the transparent window shows the desktop.
 * Image fills the sheet behind the cards.
 *
 * @param {object|null|undefined} background raw or resolved background option
 * @returns {{background?: string}}
 */
export const sheetBackgroundStyle = (background) => {
  return backgroundStyleOf(background);
};

/**
 * Size to scale an image to so it fits within a box, keeping its aspect
 * ratio and never enlarging it.
 *
 * @returns {{width: number, height: number}} whole pixels, at least 1
 */
export const fitWithin = (width, height, maxWidth, maxHeight) => {
  const w = Math.max(1, Math.floor(width) || 1);
  const h = Math.max(1, Math.floor(height) || 1);
  const scale = Math.min(1, maxWidth / w, maxHeight / h);
  if (!(scale > 0)) return { width: 1, height: 1 };
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale))
  };
};

/** Encoded formats tried in order; the first the browser really produces wins. */
/**
 * Decode a base64 `data:` URL into a Blob without any network request (the sheet
 * page's CSP forbids fetch() of data: URLs). Returns null for anything else.
 */
export const dataUrlToBlob = (dataUrl) => {
  const match = /^data:([^;,]*)((?:;[^;,]*)*?),(.*)$/s.exec(typeof dataUrl === 'string' ? dataUrl : '');
  if (!match || !/;base64$/i.test(match[2])) return null;
  let binary;
  try {
    binary = atob(match[3]);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: match[1] || 'application/octet-stream' });
};

export const IMAGE_ENCODINGS =['image/webp', 'image/jpeg'];
export const IMAGE_QUALITY = 0.85;

/** True when a data URL was encoded as one of IMAGE_ENCODINGS. */
export const isStoredImageDataUrl = (value) =>
  typeof value === 'string' && /^data:image\/(webp|jpeg);base64,/.test(value);

/**
 * Return a new config with display options changed. Only the given fields
 * change. Choosing a non-image background drops the stored image data so the
 * config does not carry a large unused blob.
 *
 * @param {object} config saved sheet config
 * @param {{maximized?: boolean, background?: {kind: string, image?: string}}} patch
 */
export const withSheetOptions = (config, patch) => {
  const next = { ...(config || {}) };
  if (typeof patch?.maximized === 'boolean') next.maximized = patch.maximized;
  if (patch?.background) {
    const kind = BACKGROUND_KINDS.includes(patch.background.kind) ? patch.background.kind : 'opaque';
    if (kind === 'image') {
      const image = patch.background.image ?? next.background?.image;
      next.background = typeof image === 'string' && image ? { kind, image } : { kind: 'opaque' };
    } else {
      next.background = { kind };
    }
  }
  return next;
};

/**
 * Whether switching the background between two kinds needs the window
 * reopened. A window's transparency is fixed when it is created, so any
 * change to or from transparent only takes effect on the next open.
 */
export const backgroundNeedsReopen = (fromKind, toKind) =>
  fromKind !== toKind && (fromKind === 'transparent' || toKind === 'transparent');

const backgroundStyleOf = (background) => {
  const { background: bg } = resolveSheetOptions({ background });
  if (bg.kind === 'transparent') return { background: 'transparent' };
  if (bg.kind === 'image') {
    const quoted = bg.image.replace(/[\\"\n\r]/g, (c) => (c === '\\' || c === '"' ? '\\' + c : ' '));
    return { background: `url("${quoted}") center / cover no-repeat fixed` };
  }
  return {};
};
