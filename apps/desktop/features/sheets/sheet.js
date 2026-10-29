/**
 * Sheet - Widget sheet with freeform card layout
 *
 * Each card hosts a webview pointing to a URL (peek:// or https://).
 * Uses peek-grid in freeform mode with drag/resize in edit mode.
 */

import { loadSheet, saveSheet, loadSheetsMap, deleteSheet } from './sheet-store.js';
import { withSheetName } from './sheet-commands.js';
import { startNameEdit, isNameEditing } from './inline-name-edit.js';
import { DEFAULT_CARD_WIDTH, DEFAULT_CARD_HEIGHT } from 'peek://app/lib/card-size.js';
import { pushLayout } from 'peek://app/lib/push-layout.js';
import { heightForRatio, clearOfRects } from 'peek://app/lib/aspect-resize.js';
import { createKeydownHandler, getCards } from 'peek://app/lib/grid-nav.js';
import {
  MIN_CARD_W, MIN_CARD_H, isDrag, rectFromPoints, dragRectToGrid
} from './drag-rect.js';
import {
  acceleratorFromKeyEvent, resolveSheetHotkey, withSheetHotkey, findHotkeyConflict,
  SHEETS_CHANGED_TOPIC, SHEET_DELETED_TOPIC
} from './sheet-hotkeys.js';
import {
  sheetBackgroundStyle, resolveSheetOptions, withSheetOptions, backgroundNeedsReopen,
  fitWithin, dataUrlToBlob, isStoredImageDataUrl, IMAGE_ENCODINGS, IMAGE_QUALITY
} from './sheet-options.js';
import {
  CARD_IMAGE_MAX_SIDE, dragHasFiles, pickImageFiles, imageCardBounds, fitCardsInView, isImageItem
} from './image-drop.js';
import {
  classifyPaste, pastePoint, urlCardBounds, shouldIgnorePaste
} from './paste.js';

const api = window.app;

let sheetId = null;
let sheetConfig = null;

/**
 * Parse sheetId from URL query params
 */
const getSheetIdFromUrl = () => {
  const params = new URLSearchParams(window.location.search);
  return params.get('sheetId');
};

/**
 * Load sheet config from feature_settings
 */
const loadSheetConfig = () => loadSheet(api, sheetId);

/**
 * Save sheet config to feature_settings
 */
const saveSheetConfig = async () => {
  if (!sheetConfig) return;
  const result = await saveSheet(api, sheetId, sheetConfig);
  if (result && result.error) {
    console.error('[sheets] Failed to save config:', result.error);
    return;
  }
};

/**
 * Once an image card's picture has loaded, make sure the card has its ratio:
 * cards saved without one read it from the loaded image, and a card whose height
 * does not match its width is snapped (width kept, height fixed) and saved.
 */
const fitImageCard = (item, card, img) => {
  if (!img.naturalWidth || !img.naturalHeight) return;
  if (!(item.aspect > 0)) item.aspect = img.naturalWidth / img.naturalHeight;
  card.dataset.aspect = String(item.aspect);

  const grid = document.querySelector('peek-grid.cards');
  const bounds = grid?.freeformLayout?.[item.id];
  if (!bounds) return;
  const h = heightForRatio(bounds.w, item.aspect);
  if (Math.abs(h - bounds.h) <= 1) return;
  // Snapping must not put the card on top of another; leave it as it is then.
  const others = Object.entries(grid.freeformLayout)
    .filter(([id]) => id !== item.id)
    .map(([, r]) => r);
  if (!clearOfRects({ ...bounds, h }, others)) return;
  item.height = h;
  grid.freeformLayout = { ...grid.freeformLayout, [item.id]: { ...bounds, h } };
  saveSheetConfig();
};

/**
 * Create a card element with a webview for a sheet item
 */
const createCard = (item) => {
  const card = document.createElement('peek-card');
  card.id = item.id;
  card.dataset.id = item.id;

  // Remove button floats over the card's top-right corner, shown on hover
  const removeBtn = document.createElement('button');
  removeBtn.className = 'card-remove-btn';
  removeBtn.textContent = '\u00d7';
  removeBtn.title = 'Remove card';
  // Keep the press away from the grid's drag handling, which would capture the pointer.
  removeBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    removeCard(item.id);
  });
  card.appendChild(removeBtn);

  if (isImageItem(item)) {
    const img = document.createElement('img');
    img.className = 'card-image';
    img.src = item.image;
    img.draggable = false;
    // Resizing keeps the image's ratio, so the image fills the card with no bands.
    if (item.aspect > 0) card.dataset.aspect = String(item.aspect);
    img.addEventListener('load', () => fitImageCard(item, card, img));
    card.appendChild(img);
    return card;
  }

  // Webview
  const webview = document.createElement('webview');
  webview.className = 'card-webview';
  webview.src = item.url;
  card.appendChild(webview);

  // A webview swallows pointer events, so thin transparent strips along the card
  // edges pass presses on to the grid's edge-resize and drag handling.
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const strip = document.createElement('div');
    strip.className = `card-edge-strip card-edge-${side}`;
    card.appendChild(strip);
  }

  return card;
};

/** Images pasted or dropped that are still being encoded: {id, x, y, w, h, file}. */
const pendingCards = [];

/** Spinner card standing in for an image until it is encoded. data-ghost keeps the grid from dragging it. */
const createPendingCard = (id) => {
  const card = document.createElement('peek-card');
  card.id = id;
  card.dataset.id = id;
  card.dataset.ghost = '';
  card.className = 'pending-card';
  card.draggable = false;
  const spinner = document.createElement('div');
  spinner.className = 'pending-spinner';
  card.appendChild(spinner);
  return card;
};

const SLOT_COLS = 3;
const SLOT_W = DEFAULT_CARD_WIDTH;
const SLOT_H = DEFAULT_CARD_HEIGHT;
const SLOT_GAP = 12;

/** Bounds of the nth auto-placed slot (3 columns, row by row). */
const slotFor = (index) => ({
  x: (index % SLOT_COLS) * (SLOT_W + SLOT_GAP),
  y: Math.floor(index / SLOT_COLS) * (SLOT_H + SLOT_GAP),
  w: SLOT_W,
  h: SLOT_H
});

/**
 * Render all cards from config
 */
const renderCards = () => {
  const grid = document.querySelector('peek-grid.cards');
  grid.innerHTML = '';

  const items = sheetConfig ? sheetConfig.items : [];

  // Build freeform layout map from config
  const layout = {};
  for (const item of items) {
    layout[item.id] = {
      x: item.x,
      y: item.y,
      w: item.width,
      h: item.height
    };
  }

  // Create card elements
  for (const item of items) {
    const card = createCard(item);
    grid.appendChild(card);
  }

  // Images still being encoded show as placeholders; they are not part of the saved sheet.
  for (const job of pendingCards) {
    layout[job.id] = { x: job.x, y: job.y, w: job.w, h: job.h };
    grid.appendChild(createPendingCard(job.id));
  }

  document.querySelector('.empty-state').style.display = (items.length || pendingCards.length) ? 'none' : '';

  // Set freeform layout on grid
  grid.freeformLayout = layout;
};

/**
 * Add a new card with a URL
 */
const addCard = async (url, rect = null) => {
  if (!url) return;

  const id = crypto.randomUUID().slice(0, 8);

  // Place at the drawn rectangle, else in the next free slot
  const slot = rect || slotFor(sheetConfig.items.length);
  const newItem = {
    id,
    url,
    x: slot.x,
    y: slot.y,
    width: slot.w,
    height: slot.h
  };

  // Cards under a drawn rectangle are pushed aside the way they are on a drop.
  if (rect) {
    const grid = document.querySelector('peek-grid.cards');
    const rects = [...sheetConfig.items.map(it => ({ x: it.x, y: it.y, w: it.width, h: it.height })), rect];
    const pushed = pushLayout(rects, rects.length - 1, rect, {
      bounds: gridBounds(grid),
      gap: grid.gap,
      minW: MIN_CARD_W,
      minH: MIN_CARD_H
    });
    sheetConfig.items.forEach((it, i) => {
      it.x = pushed[i].x;
      it.y = pushed[i].y;
      it.width = pushed[i].w;
      it.height = pushed[i].h;
    });
  }

  sheetConfig.items.push(newItem);
  await saveSheetConfig();
  renderCards();
  updateEditState();
};

/**
 * Remove a card by id
 */
const removeCard = async (cardId) => {
  sheetConfig.items = sheetConfig.items.filter(item => item.id !== cardId);
  await saveSheetConfig();
  renderCards();
  updateEditState();
};

/**
 * Cards can always be dragged and resized (there is no separate edit mode);
 * the remove control shows while the pointer is over a card (sheet.css).
 */
const updateEditState = () => {
  document.querySelector('peek-grid.cards').freeformEditing = true;
};

/** Rectangle drawn on empty space that the next added card takes; null for auto-placement. */
let pendingRect = null;

/** The grid's visible area in grid coordinates, as peek-grid computes it for pushing. */
const gridBounds = (grid) => {
  const inner = grid.shadowRoot?.querySelector('.grid');
  const top = inner ? inner.getBoundingClientRect().top : 0;
  const width = inner?.clientWidth || grid.clientWidth || 600;
  return { left: 0, top: 0, right: width, bottom: Math.max(MIN_CARD_H, window.innerHeight - top - grid.gap) };
};

/**
 * Show URL input dialog
 */
const showAddDialog = () => {
  const dialog = document.querySelector('.add-dialog');
  const input = dialog.querySelector('.add-dialog-input');
  dialog.style.display = '';
  input.value = '';
  input.focus();
};

/**
 * Hide URL input dialog
 */
const hideAddDialog = () => {
  const dialog = document.querySelector('.add-dialog');
  dialog.style.display = 'none';
  pendingRect = null;
};

/**
 * Handle dialog confirm
 */
const confirmAddDialog = () => {
  const input = document.querySelector('.add-dialog-input');
  const url = input.value.trim();
  if (url) {
    addCard(url, pendingRect);
  }
  hideAddDialog();
};

/** Outline element shown while drawing, and the in-progress gesture (null when idle). */
let drawing = null;

const endDrawing = () => {
  if (!drawing) return;
  drawing.outline.remove();
  drawing = null;
};

/**
 * Pressing on empty grid space and dragging draws a rectangle; releasing opens
 * the add dialog, and the card is created at that rectangle. Escape or
 * cancelling the dialog discards it. A press that barely moves does nothing.
 */
const setupDrawCard = (grid) => {
  grid.addEventListener('pointerdown', (e) => {
    // Cards are light-DOM children, so only a press on the grid itself is empty space.
    if (e.button !== 0 || e.target !== grid || drawing) return;
    const outline = document.createElement('div');
    outline.className = 'draw-outline';
    outline.style.display = 'none';
    document.body.appendChild(outline);
    drawing = { pointerId: e.pointerId, start: { x: e.clientX, y: e.clientY }, outline };
    grid.setPointerCapture(e.pointerId);
  });

  grid.addEventListener('pointermove', (e) => {
    if (!drawing || e.pointerId !== drawing.pointerId) return;
    const end = { x: e.clientX, y: e.clientY };
    if (!isDrag(drawing.start, end)) return;
    const r = rectFromPoints(drawing.start, end);
    const s = drawing.outline.style;
    s.display = '';
    s.left = `${r.x}px`;
    s.top = `${r.y}px`;
    s.width = `${r.w}px`;
    s.height = `${r.h}px`;
  });

  grid.addEventListener('pointerup', (e) => {
    if (!drawing || e.pointerId !== drawing.pointerId) return;
    const { start } = drawing;
    const end = { x: e.clientX, y: e.clientY };
    endDrawing();
    if (!isDrag(start, end)) return;
    const inner = grid.shadowRoot?.querySelector('.grid');
    const box = inner ? inner.getBoundingClientRect() : grid.getBoundingClientRect();
    pendingRect = dragRectToGrid(start, end, { x: box.left, y: box.top }, {
      snap: grid.freeformSnap,
      bounds: gridBounds(grid)
    });
    showAddDialog();
  });

  grid.addEventListener('pointercancel', endDrawing);
};

const keyNavState = { selectedIndex: -1 };

/** True while a key belongs to a text field, the title edit, or an open dialog/panel. */
const keyNavShouldIgnore = (e) => {
  if (e.defaultPrevented) return true;
  const t = e.target;
  if (t && t.closest && t.closest('input, textarea, select, [contenteditable], peek-input, peek-select')) return true;
  const open = (sel) => {
    const el = document.querySelector(sel);
    return !!el && el.style.display !== 'none';
  };
  return open('.add-dialog') || open('.options-panel');
};

const keyNavHandler = createKeydownHandler(keyNavState, {
  spatial: true,
  shouldIgnore: keyNavShouldIgnore,
  // Escape stays with the escape handler below (it closes the window or ends a draw)
  onActivate: () => {
    const card = getCards()[keyNavState.selectedIndex];
    const webview = card && card.querySelector('webview');
    if (webview) webview.focus();
  }
});

/**
 * Set up event listeners
 */
const setupEvents = () => {
  document.addEventListener('keydown', keyNavHandler);

  // Add dialog
  document.querySelector('.btn-add').addEventListener('click', showAddDialog);
  document.querySelector('.add-dialog-backdrop').addEventListener('click', hideAddDialog);
  document.querySelector('.btn-cancel').addEventListener('click', hideAddDialog);
  document.querySelector('.btn-confirm').addEventListener('click', confirmAddDialog);

  // Enter key in dialog input
  document.querySelector('.add-dialog-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      confirmAddDialog();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      hideAddDialog();
    }
  });

  // Listen for freeform layout changes from peek-grid (drag/resize)
  const grid = document.querySelector('peek-grid.cards');
  setupDrawCard(grid);
  grid.addEventListener('freeform-layout-change', (e) => {
    const { layout } = e.detail;

    // Update config items with new positions
    for (const item of sheetConfig.items) {
      const bounds = layout[item.id];
      if (bounds) {
        item.x = bounds.x;
        item.y = bounds.y;
        item.width = bounds.w;
        item.height = bounds.h;
      }
    }

    saveSheetConfig();
  });
};

/**
 * Paint the configured background. Opaque leaves the stylesheet's theme
 * background; transparent clears it (the window itself is created transparent
 * by the opener); image fills the sheet behind the cards.
 */
const applyBackground = () => {
  const bgStyle = sheetBackgroundStyle(sheetConfig.background);
  const value = bgStyle.background || '';
  document.documentElement.style.background = value;
  document.body.style.background = value;
};

/** Background kind the window was opened with; transparency cannot change after that. */
let openedBackgroundKind = 'opaque';

/**
 * Downscale a picked image to at most the screen size and encode it as WebP
 * (JPEG where WebP is not produced), returning a data URL.
 */
const encodeImageWithin = async (file, maxWidth, maxHeight) => {
  const bitmap = await createImageBitmap(file);
  const { width, height } = fitWithin(bitmap.width, bitmap.height, maxWidth, maxHeight);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  for (const type of IMAGE_ENCODINGS) {
    const url = canvas.toDataURL(type, IMAGE_QUALITY);
    if (isStoredImageDataUrl(url)) return { url, width, height };
  }
  throw new Error('image could not be encoded');
};

const encodeBackgroundImage = async (file) => {
  const ratio = window.devicePixelRatio || 1;
  const { url } = await encodeImageWithin(
    file,
    Math.round(window.screen.width * ratio), Math.round(window.screen.height * ratio)
  );
  return url;
};

const IMAGE_ENCODE_CONCURRENCY = 3;

/** Natural pixel size of an image file, read from its header without re-encoding. */
const readImageSize = (file) => new Promise((resolve, reject) => {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    resolve({ width: img.naturalWidth, height: img.naturalHeight });
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    reject(new Error('image could not be read'));
  };
  img.src = url;
});

/**
 * Add one image card per dropped or pasted image file. The first card is
 * centred on the point (relative to the grid); the rest follow it left to right,
 * wrapping to a new row at the grid's right edge. Images that fail to encode are
 * skipped.
 */
const addImageCards = async (files, point) => {
  const grid = document.querySelector('peek-grid.cards');
  // Natural sizes first (a header read, no re-encode) so the final layout is known up front.
  const naturals = await Promise.all(files.map((file) => readImageSize(file).catch((err) => {
    console.error('[sheets] Failed to read image:', err);
    return null;
  })));
  const sized = files.map((file, i) => ({ file, natural: naturals[i] })).filter((s) => s.natural);
  if (!sized.length) return;
  const first = imageCardBounds(point, sized[0].natural, grid.freeformSnap);
  const sizes = sized.map((s) => {
    const b = imageCardBounds(point, s.natural, grid.freeformSnap);
    return { w: b.w, h: b.h };
  });
  const rects = fitCardsInView(sizes, gridBounds(grid), grid.gap, { x: first.x, y: first.y }, grid.freeformSnap);

  // Placeholders appear at once at their final positions; they are never saved.
  const jobs = sized.map((s, i) => {
    const job = { id: crypto.randomUUID().slice(0, 8), file: s.file, x: rects[i].x, y: rects[i].y, w: rects[i].w, h: rects[i].h };
    pendingCards.push(job);
    return job;
  });
  renderCards();

  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try {
        const img = await encodeImageWithin(job.file, CARD_IMAGE_MAX_SIDE, CARD_IMAGE_MAX_SIDE);
        pendingCards.splice(pendingCards.indexOf(job), 1);
        // Another card may have been pushed aside meanwhile; keep the placeholder's current spot.
        const bounds = grid.freeformLayout?.[job.id] || { x: job.x, y: job.y, w: job.w, h: job.h };
        const item = {
          id: job.id, kind: 'image', image: img.url, aspect: img.width / img.height,
          x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h
        };
        sheetConfig.items.push(item);
        const placeholder = grid.querySelector(`peek-card[data-id="${job.id}"]`);
        if (placeholder) placeholder.replaceWith(createCard(item));
        else renderCards();
      } catch (err) {
        console.error('[sheets] Failed to encode image:', err);
        pendingCards.splice(pendingCards.indexOf(job), 1);
        grid.querySelector(`peek-card[data-id="${job.id}"]`)?.remove();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(IMAGE_ENCODE_CONCURRENCY, jobs.length) }, worker));
  await saveSheetConfig();
  renderCards();
  updateEditState();
};

/** Accept dropped image files on the grid; other drags (links, text) are left alone. */
const setupImageDrop = () => {
  const grid = document.querySelector('peek-grid.cards');
  grid.addEventListener('dragover', (e) => {
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  grid.addEventListener('drop', async (e) => {
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    const files = pickImageFiles(e.dataTransfer);
    if (!files.length) return;
    const rect = grid.getBoundingClientRect();
    try {
      await addImageCards(files, { x: e.clientX - rect.left, y: e.clientY - rect.top });
    } catch (err) {
      console.error('[sheets] Failed to add dropped image:', err);
    }
  });
};

/**
 * Pasting an image or a URL adds a card, centred on the last pointer position
 * when it is over the grid, else in the middle of the visible grid. Pastes into
 * text fields, or while the add dialog or options panel is open, are left alone.
 */
const setupPaste = () => {
  const grid = document.querySelector('peek-grid.cards');
  let pointer = null;
  document.addEventListener('pointermove', (e) => {
    const box = grid.getBoundingClientRect();
    pointer = { x: e.clientX - box.left, y: e.clientY - box.top };
  });
  document.addEventListener('pointerleave', () => { pointer = null; });

  document.addEventListener('paste', async (e) => {
    const isOpen = (sel) => document.querySelector(sel)?.style.display !== 'none';
    if (shouldIgnorePaste({
      target: document.activeElement,
      dialogOpen: isOpen('.add-dialog'),
      panelOpen: isOpen('.options-panel')
    })) return;
    const pasted = classifyPaste(e.clipboardData);
    if (!pasted) return;
    e.preventDefault();
    const bounds = gridBounds(grid);
    const point = pastePoint(pointer, { width: bounds.right, height: bounds.bottom });
    try {
      if (pasted.kind === 'images') {
        await addImageCards(pasted.files, point);
      } else {
        await addCard(pasted.url, urlCardBounds(point, { w: SLOT_W, h: SLOT_H }, grid.freeformSnap));
      }
    } catch (err) {
      console.error('[sheets] Failed to add pasted card:', err);
    }
  });
};

/** The options panel's name box, kept in step with renames made elsewhere. */
let optionsNameInput = null;

/**
 * Save a new name from the options panel or the header, and update the header,
 * window title and name box. A blank or unchanged name only restores the display.
 */
const commitName = async (input) => {
  const next = withSheetName(sheetConfig, input);
  if (next !== sheetConfig && next.name !== sheetConfig.name) {
    sheetConfig = next;
    await saveSheetConfig();
    // Name lists (command options, the sheets grid) follow the new name.
    api.pubsub.publish(SHEETS_CHANGED_TOPIC, { sheetId });
  }
  const titleEl = document.querySelector('.sheet-title');
  if (!titleEl.querySelector('input')) titleEl.textContent = sheetConfig.name;
  document.title = sheetConfig.name;
  if (optionsNameInput) optionsNameInput.value = sheetConfig.name || '';
};

/** Click the header title to rename in place. */
const setupTitleEdit = () => {
  const titleEl = document.querySelector('.sheet-title');
  titleEl.addEventListener('click', () => {
    startNameEdit(titleEl, {
      name: sheetConfig.name || '',
      save: (name) => commitName(name)
    });
  });
  // Esc ends only the edit or the rectangle being drawn; otherwise it closes the transient sheet window.
  api.escape?.onEscape?.(() => {
    if (drawing) {
      endDrawing();
      return { handled: true };
    }
    return { handled: isNameEditing() };
  });
};

/**
 * Wire the options panel: open maximized, background kind, background image.
 */
const setupOptionsPanel = () => {
  const panel = document.querySelector('.options-panel');
  const maximized = panel.querySelector('.opt-maximized');
  const group = panel.querySelector('.opt-background');
  const imageRow = panel.querySelector('.opt-image-row');
  const status = panel.querySelector('.opt-image-status');
  const note = panel.querySelector('.opt-note');

  const openedMaximized = resolveSheetOptions(sheetConfig).maximized;
  // "Image" picked but no file chosen yet: nothing to save, only the picker to show.
  let choosingImage = false;

  const refresh = () => {
    const opts = resolveSheetOptions(sheetConfig);
    maximized.checked = opts.maximized;
    group.value = choosingImage ? 'image' : opts.background.kind;
    imageRow.style.display = group.value === 'image' ? '' : 'none';
    status.textContent = opts.background.image ? 'Image set' : 'No image chosen';
    const notes = [];
    if (backgroundNeedsReopen(openedBackgroundKind, opts.background.kind)) {
      notes.push('Transparency is set when the window is created: applies next time the sheet opens.');
    }
    if (opts.maximized !== openedMaximized) notes.push('Open maximized applies next time the sheet opens.');
    note.textContent = notes.join(' ');
  };

  const update = async (patch) => {
    sheetConfig = withSheetOptions(sheetConfig, patch);
    await saveSheetConfig();
    applyBackground();
    refresh();
  };

  // ----- Name -----
  const nameInput = panel.querySelector('.opt-name');
  nameInput.value = sheetConfig.name || '';
  optionsNameInput = nameInput;
  nameInput.addEventListener('change', () => commitName(nameInput.value));
  nameInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      nameInput.blur();
    }
  });

  // ----- Key to open this sheet -----
  const keyInput = panel.querySelector('.opt-key');
  const keyClear = panel.querySelector('.opt-key-clear');
  const keyScope = panel.querySelector('.opt-key-scope');
  const keyNote = panel.querySelector('.opt-key-note');

  const refreshKey = (message) => {
    const hk = resolveSheetHotkey(sheetConfig);
    keyInput.value = hk ? hk.keys : '';
    keyScope.value = hk ? hk.scope : 'global';
    keyNote.textContent = message || (hk && hk.scope === 'app'
      ? 'In-app keys work only while a Peek window has focus and the Sheets feature is running.'
      : 'Global keys work from any app and start the Sheets feature when pressed.');
  };

  // Save the key, then tell the feature to redeclare its keys.
  const updateKey = async (hotkey) => {
    sheetConfig = withSheetHotkey(sheetConfig, hotkey);
    await saveSheetConfig();
    api.pubsub.publish(SHEETS_CHANGED_TOPIC, { sheetId });
    refreshKey();
  };

  keyInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Tab') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      keyInput.blur();
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      await updateKey(null);
      return;
    }
    const keys = acceleratorFromKeyEvent(e);
    if (!keys) return;
    const sheetsMap = await loadSheetsMap(api);
    const conflict = findHotkeyConflict(sheetsMap, sheetId, keys);
    if (conflict) {
      refreshKey(`${keys} is already the key for "${conflict.name}".`);
      return;
    }
    const scope = resolveSheetHotkey(sheetConfig)?.scope || keyScope.value || 'global';
    await updateKey({ keys, scope });
  });

  keyClear.addEventListener('click', () => updateKey(null));

  keyScope.addEventListener('change', (e) => {
    const hk = resolveSheetHotkey(sheetConfig);
    const scope = e.detail?.value === 'app' ? 'app' : 'global';
    if (hk) updateKey({ keys: hk.keys, scope });
    else refreshKey();
  });

  refreshKey();

  // ----- Delete this sheet -----
  // A deleted sheet's window closes (here and in any other window of it) so a
  // later edit cannot save the sheet back.
  api.pubsub.subscribe(SHEET_DELETED_TOPIC, (msg) => {
    if (msg?.sheetId === sheetId) api.window.close(undefined, { force: true });
  });
  panel.querySelector('.opt-delete').addEventListener('click', async () => {
    if (!confirm(`Delete sheet "${sheetConfig.name || 'Untitled'}"? This cannot be undone.`)) return;
    const result = await deleteSheet(api, sheetId);
    if (result && result.error) {
      console.error('[ext:sheets] Failed to delete sheet:', result.error);
      return;
    }
    api.pubsub.publish(SHEET_DELETED_TOPIC, { sheetId });
    api.pubsub.publish(SHEETS_CHANGED_TOPIC, { sheetId });
  });

  document.querySelector('.btn-options').addEventListener('click', () => {
    panel.style.display = panel.style.display === 'none' ? '' : 'none';
  });

  maximized.addEventListener('change', (e) => {
    update({ maximized: e.detail?.checked === true });
  });

  group.addEventListener('change', (e) => {
    const kind = e.detail?.value;
    choosingImage = kind === 'image';
    if (kind === 'image' && !resolveSheetOptions(sheetConfig).background.image) {
      refresh();
      return;
    }
    update({ background: { kind } });
  });

  // Main opens the native chooser (api.dialogs.open); a hidden
  // <input type=file>.click() surfaces no chooser in this window.
  panel.querySelector('.opt-pick-image').addEventListener('click', async () => {
    try {
      const picked = await api.dialogs.open({ kind: 'image' });
      if (!picked?.success) {
        if (!picked?.canceled) status.textContent = 'Could not open the file chooser';
        return;
      }
      const dataUrl = picked.data?.dataUrl;
      if (!dataUrl) {
        status.textContent = 'That file could not be used as an image';
        return;
      }
      status.textContent = 'Processing...';
      const file = dataUrlToBlob(dataUrl);
      if (!file) {
        status.textContent = 'That file could not be used as an image';
        return;
      }
      const image = await encodeBackgroundImage(file);
      choosingImage = false;
      await update({ background: { kind: 'image', image } });
    } catch (err) {
      console.error('[sheets] Failed to set background image:', err);
      status.textContent = 'That file could not be used as an image';
    }
  });

  refresh();
};

/**
 * Read this window's see-through state from main and draw it.
 *
 * The look is entirely see-through.css plus the `body.see-through` block in
 * sheet.css, both gated on a class on `<body>`; the state itself lives in main
 * as a window param, which is why it survives a restart. Reading it here is
 * also what applies a switch that was already on when the session was saved,
 * before any announcement arrives.
 */
const applySeeThrough = async () => {
  try {
    const result = await api?.window?.getSeeThrough?.();
    const on = result?.success === true && result.data?.seeThrough === true;
    document.body.classList.toggle('see-through', on);
  } catch (error) {
    console.log('[sheets] see-through state unavailable:', error);
  }
};

/**
 * Follow the see-through switch. `window:see-through` is a broadcast, so
 * rather than matching the window id in the message the view simply re-reads
 * its own state — one answer, and no second idea of which window this is.
 */
const setupSeeThrough = () => {
  api?.pubsub?.subscribe('window:see-through', () => { applySeeThrough(); });
  applySeeThrough();
};

/**
 * Initialize sheet
 */
const init = async () => {
  sheetId = getSheetIdFromUrl();
  if (!sheetId) {
    console.error('[sheets] No sheetId in URL');
    return;
  }

  sheetConfig = await loadSheetConfig();
  if (!sheetConfig) {
    console.error('[sheets] Sheet config not found:', sheetId);
    sheetConfig = {
      version: 1,
      name: 'Untitled Sheet',
      createdAt: Date.now(),
      items: []
    };
  }

  applyBackground();
  openedBackgroundKind = resolveSheetOptions(sheetConfig).background.kind;
  setupOptionsPanel();

  // Set page title
  const titleEl = document.querySelector('.sheet-title');
  titleEl.textContent = sheetConfig.name;
  document.title = sheetConfig.name;

  setupTitleEdit();
  setupEvents();
  setupImageDrop();
  setupPaste();
  renderCards();
  updateEditState();

  // The view is drawn; a spec can wait for this rather than for a card count.
  document.body.dataset.ready = 'true';
};

// On module evaluation, ahead of `init()` and of its first await, so a switch
// flipped while the view is still loading is not missed. This is a deferred
// module script, so `<body>` already exists.
setupSeeThrough();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
