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
export const pickImageFile = (dataTransfer) => {
  if (!dataTransfer) return null;
  for (const file of Array.from(dataTransfer.files || [])) {
    if (file && isImageType(file.type)) return file;
  }
  for (const item of Array.from(dataTransfer.items || [])) {
    if (item && item.kind === 'file' && isImageType(item.type)) {
      const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
      if (file) return file;
    }
  }
  return null;
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

/** Whether a stored sheet item is an image card; items without a kind are webview cards. */
export const isImageItem = (item) => item?.kind === 'image' && typeof item.image === 'string' && item.image !== '';
