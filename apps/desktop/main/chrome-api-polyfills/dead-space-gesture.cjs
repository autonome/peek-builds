/**
 * Dead-space double-click detection, shared by every preload that reports the
 * content-area window gesture to main: runtime-external-preload.cjs (hybrid
 * page-host content) and tile-preload.cts (plain peek:// feature windows).
 *
 * Electron sandboxed preloads cannot require sibling files, so the build
 * (scripts/inline-dead-space-gesture.mjs) replaces the marked
 * `require('./dead-space-gesture.cjs')` line in each dist preload with this
 * file's source. This file is the single implementation; it is also loadable
 * directly under node for the unit tests (dead-space-gesture.test.ts).
 *
 * A double-click is reported only over "dead" content: not over an editable or
 * interactive control, not over a card, and not on text it selected. Main
 * (hybrid-window-gesture.ts) maps the report to a maximize toggle.
 */
'use strict';

const NON_EDITABLE_INPUT_TYPES = ['button', 'checkbox', 'radio', 'submit', 'reset', 'image', 'file', 'range', 'color', 'hidden'];
const INTERACTIVE_TAGS = ['button', 'a', 'summary', 'option', 'label', 'video', 'audio'];
const INTERACTIVE_ROLES = ['button', 'link', 'checkbox', 'radio', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'option', 'textbox'];

function isEditableElement(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return !NON_EDITABLE_INPUT_TYPES.includes(type);
  }
  if ((el.getAttribute('role') || '').toLowerCase() === 'textbox') return true;
  return false;
}

// Broader than isEditableElement: also discrete controls a click is meant to
// activate (buttons, links, media, widget roles). `extraTags` lets a caller add
// its own component tags (the tile preload adds the card element).
function isInteractiveTarget(el, extraTags) {
  if (isEditableElement(el)) return true;
  const tag = (el.tagName || '').toLowerCase();
  if (INTERACTIVE_TAGS.includes(tag)) return true;
  if (extraTags && extraTags.includes(tag)) return true;
  const role = (el.getAttribute ? (el.getAttribute('role') || '') : '').toLowerCase();
  return INTERACTIVE_ROLES.includes(role);
}

function gestureSuppressed(e, win, extraTags) {
  // 1) Interactive/editable target anywhere along the (shadow-aware) event path.
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  for (const node of path) {
    if (!node || node.nodeType !== 1) continue;
    if (isInteractiveTarget(node, extraTags)) return true;
  }
  // 2) The multi-click landed ON text and selected it. A bare "some selection
  //    exists" test is too coarse: Chromium snaps a double-click in dead space to
  //    the nearest word and selects that. The precise signal is whether the click
  //    point falls within the selected text's own rects.
  try {
    const sel = win.getSelection && win.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount > 0 && String(sel).length > 0) {
      const rects = sel.getRangeAt(0).getClientRects();
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (e.clientX >= r.left && e.clientX <= r.right
          && e.clientY >= r.top && e.clientY <= r.bottom) return true;
      }
    }
  } catch (_) { /* getSelection unavailable */ }
  return false;
}

// Installs the document listeners. `doc`/`win` are injected so tests can fake
// them. `send(payload)` delivers `{ detent, dragDx, dragDy }` to main.
function installDeadSpaceGesture(doc, win, send, extraTags) {
  // Press point of the most recent mousedown, so the terminating click can
  // measure travel (a click-drag's click can still carry detail 2). Read and
  // cleared by exactly one click.
  let downX = null;
  let downY = null;
  doc.addEventListener('mousedown', function (e) {
    downX = e.clientX;
    downY = e.clientY;
  }, true);
  doc.addEventListener('click', function (e) {
    const x0 = downX;
    const y0 = downY;
    downX = null;
    downY = null;
    const detent = e.detail; // native multi-click count: 2 = double-click
    if (detent !== 2) return;
    if (gestureSuppressed(e, win, extraTags)) return;
    const dragDx = x0 === null ? 0 : e.clientX - x0;
    const dragDy = y0 === null ? 0 : e.clientY - y0;
    // Chromium's incidental nearest-word selection would otherwise stay
    // highlighted after the window resizes.
    try {
      const sel = win.getSelection && win.getSelection();
      if (sel && !sel.isCollapsed) sel.removeAllRanges();
    } catch (_) { /* getSelection unavailable */ }
    try { send({ detent, dragDx, dragDy }); } catch (_) { /* no main */ }
  }, true);
}

module.exports = { isEditableElement, isInteractiveTarget, gestureSuppressed, installDeadSpaceGesture };
