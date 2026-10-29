/**
 * Pure helpers for pasting onto a sheet: classify what the clipboard holds,
 * normalize URL text, and pick where the new card goes. No DOM access beyond
 * the DataTransfer-shaped objects passed in.
 */

import { pickImageFiles } from './image-drop.js';

const SCHEME_URL = /^(https?|peek):\/\/\S+$/i;
const BARE_DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?$/i;

/**
 * Turn pasted text into a URL to open, or null when it is not a URL. Accepts
 * http(s):// and peek:// URLs as is, and a bare domain (optionally with a path)
 * as https://. Text with whitespace is never a URL.
 */
export const normalizePastedUrl = (text) => {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  if (SCHEME_URL.test(trimmed)) return trimmed;
  if (BARE_DOMAIN.test(trimmed)) return `https://${trimmed}`;
  return null;
};

/**
 * Classify clipboard contents: an image file wins over text.
 *
 * @param {DataTransfer} clipboardData
 * @returns {{kind: 'images', files: File[]} | {kind: 'url', url: string} | null}
 */
export const classifyPaste = (clipboardData) => {
  if (!clipboardData) return null;
  const files = pickImageFiles(clipboardData);
  if (files.length) return { kind: 'images', files };
  const text = typeof clipboardData.getData === 'function' ? clipboardData.getData('text/plain') : '';
  const url = normalizePastedUrl(text);
  return url ? { kind: 'url', url } : null;
};

/**
 * Where a pasted card is centred: the last pointer position when it is over the
 * grid, else the middle of the grid's visible area. Points are relative to the grid.
 *
 * @param {{x: number, y: number}|null} pointer last pointer position relative to the grid
 * @param {{width: number, height: number}} visible visible size of the grid
 * @returns {{x: number, y: number}}
 */
export const pastePoint = (pointer, visible) => {
  const w = Math.max(0, Number(visible?.width) || 0);
  const h = Math.max(0, Number(visible?.height) || 0);
  if (pointer && pointer.x >= 0 && pointer.y >= 0 && pointer.x <= w && pointer.y <= h) {
    return { x: pointer.x, y: pointer.y };
  }
  return { x: w / 2, y: h / 2 };
};

/**
 * Bounds for a pasted URL card of the given size, centred on a point, snapped
 * to the grid and never at a negative position.
 */
export const urlCardBounds = (point, size, snap = 0) => {
  const w = Math.max(1, Number(size?.w) || 1);
  const h = Math.max(1, Number(size?.h) || 1);
  const roundTo = (v) => (snap ? Math.round(v / snap) * snap : Math.round(v));
  return {
    x: Math.max(0, roundTo((Number(point?.x) || 0) - w / 2)),
    y: Math.max(0, roundTo((Number(point?.y) || 0) - h / 2)),
    w,
    h
  };
};

/**
 * Whether the paste should be left alone: focus is in a text field or editable
 * element, or the add dialog / options panel is open.
 */
export const shouldIgnorePaste = ({ target, dialogOpen, panelOpen }) => {
  if (dialogOpen || panelOpen) return true;
  if (!target) return false;
  const tag = String(target.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
};
