/**
 * Pure helpers for dropping an image onto a sheet. No DOM access beyond the
 * DataTransfer-shaped objects passed in, so they can be unit tested directly.
 */

/** Longest side, in pixels, of an image stored on a card. */
export const CARD_IMAGE_MAX_SIDE = 1600;

/** Width a freshly dropped image card gets, before the aspect ratio sets its height. */
export const IMAGE_CARD_WIDTH = 300;

/** Smallest height a dropped image card gets, so a very wide image stays grabbable. */
export const IMAGE_CARD_MIN_HEIGHT = 60;

/** Tallest a dropped image card gets, so a very tall image does not run off the sheet. */
export const IMAGE_CARD_MAX_HEIGHT = 600;

const isImageType = (type) => typeof type === 'string' && /^image\//i.test(type);

/** Whether a drag carries files, so the sheet only reacts to file or image drags. */
export const dragHasFiles = (dataTransfer) => {
  const types = dataTransfer?.types;
  if (!types) return false;
  return Array.from(types).includes('Files');
};

/**
 * First image file in a DataTransfer (a file from Finder, or an image dragged
 * from a web page, which arrives as a file). Falls back to items when the
 * files list is empty. Returns null when there is none; links and text are
 * ignored.
 */
export const pickImageFile = (dataTransfer) => pickImageFiles(dataTransfer)[0] || null;

/**
 * Every image file in a DataTransfer. The files list wins when it holds any
 * image, since the same images usually also appear as items; items are only
 * read when the files list has none. Links and text are ignored.
 */
export const pickImageFiles = (dataTransfer) => {
  if (!dataTransfer) return [];
  const fromFiles = Array.from(dataTransfer.files || []).filter((file) => file && isImageType(file.type));
  if (fromFiles.length) return fromFiles;
  const fromItems = [];
  for (const item of Array.from(dataTransfer.items || [])) {
    if (item && item.kind === 'file' && isImageType(item.type)) {
      const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
      if (file && !fromItems.includes(file)) fromItems.push(file);
    }
  }
  return fromItems;
};

/**
 * Card bounds for a dropped image: centred on the drop point, snapped to the
 * grid, width fixed and height following the image's aspect ratio. Never
 * placed at a negative position.
 *
 * @param {{x: number, y: number}} point drop point relative to the grid
 * @param {{width: number, height: number}} image natural image size
 * @param {number} [snap] grid snap in px (0 = off)
 * @returns {{x: number, y: number, w: number, h: number}}
 */
export const imageCardBounds = (point, image, snap = 0) => {
  const iw = Math.max(1, Number(image?.width) || 1);
  const ih = Math.max(1, Number(image?.height) || 1);
  const w = IMAGE_CARD_WIDTH;
  const h = Math.min(IMAGE_CARD_MAX_HEIGHT, Math.max(IMAGE_CARD_MIN_HEIGHT, Math.round(w * ih / iw)));
  const roundTo = (v) => (snap ? Math.round(v / snap) * snap : Math.round(v));
  const px = Number(point?.x) || 0;
  const py = Number(point?.y) || 0;
  return {
    x: Math.max(0, roundTo(px - w / 2)),
    y: Math.max(0, roundTo(py - h / 2)),
    w,
    h
  };
};

/**
 * Lay several cards out left to right from a start point (the first card's
 * top-left), a gap apart. A card that would pass the right edge starts a new
 * row below the tallest card of the row above, back at the start column. The
 * first card of a row is never wrapped, so a card wider than the grid still
 * gets placed.
 *
 * @param {{x: number, y: number}} start top-left of the first card
 * @param {Array<{w: number, h: number}>} sizes card sizes in order
 * @param {number} width grid width (right edge)
 * @param {number} gap space between cards
 * @returns {Array<{x: number, y: number, w: number, h: number}>}
 */
export const layoutCardRow = (start, sizes, width, gap) => {
  const rects = [];
  let x = start.x;
  let y = start.y;
  let rowHeight = 0;
  for (const { w, h } of sizes) {
    if (x > start.x && x + w > width) {
      x = start.x;
      y += rowHeight + gap;
      rowHeight = 0;
    }
    rects.push({ x, y, w, h });
    x += w + gap;
    rowHeight = Math.max(rowHeight, h);
  }
  return rects;
};

/** Whether a stored sheet item is an image card; items without a kind are webview cards. */
export const isImageItem = (item) => item?.kind === 'image' && typeof item.image === 'string' && item.image !== '';
