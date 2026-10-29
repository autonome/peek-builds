/**
 * A sheet's list-card thumbnail: where it is kept and when it is retaken.
 *
 * The screenshot is a small JPEG data URL kept under its own settings key,
 * `sheet-thumb:<id>`, beside (not inside) the `sheets` map, so every sheet
 * save and every list load does not carry the image bytes.
 *
 * The scheduler has no DOM or electron dependency; timers and the clock are
 * injected so it can be tested.
 */

export const THUMBNAIL_WIDTH = 400;
export const THUMBNAIL_QUALITY = 70;

/** First capture after the sheet has loaded and drawn its cards. */
export const FIRST_CAPTURE_DELAY_MS = 2000;
/** Quiet time after the last edit before the thumbnail is retaken. */
export const EDIT_SETTLE_MS = 4000;
/** Never capture more often than this. */
export const MIN_CAPTURE_INTERVAL_MS = 10000;

export const thumbnailKey = (sheetId) => `sheet-thumb:${sheetId}`;

export const isThumbnailDataUrl = (v) => typeof v === 'string' && v.startsWith('data:image/jpeg;base64,');

/**
 * How long to wait before a requested capture may run.
 * @param {number} now
 * @param {number|null} lastCapturedAt
 * @param {number} settleMs wanted quiet time
 * @returns {number} ms to wait, at least settleMs and never inside the minimum interval
 */
export const captureWaitMs = (now, lastCapturedAt, settleMs) => {
  if (lastCapturedAt === null || lastCapturedAt === undefined) return settleMs;
  const sinceLast = now - lastCapturedAt;
  return Math.max(settleMs, MIN_CAPTURE_INTERVAL_MS - sinceLast);
};

/**
 * Debounced capture requests. Each request restarts the wait; the capture
 * runs once the wait ends.
 * @param {object} deps
 * @param {() => Promise<void>} deps.capture
 * @param {() => number} [deps.now]
 * @param {(fn: Function, ms: number) => any} [deps.setTimer]
 * @param {(handle: any) => void} [deps.clearTimer]
 */
export const createThumbnailScheduler = ({
  capture,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) => {
  let timer = null;
  let lastCapturedAt = null;
  let running = false;

  const request = (settleMs) => {
    clearTimer(timer);
    timer = setTimer(async () => {
      timer = null;
      if (running) return;
      running = true;
      try {
        await capture();
      } finally {
        lastCapturedAt = now();
        running = false;
      }
    }, captureWaitMs(now(), lastCapturedAt, settleMs));
  };

  return {
    /** The sheet has just loaded and drawn. */
    requestFirst: () => request(FIRST_CAPTURE_DELAY_MS),
    /** The sheet was edited. */
    requestAfterEdit: () => request(EDIT_SETTLE_MS),
    cancel: () => { clearTimer(timer); timer = null; }
  };
};

const readValue = (result) => (result && !result.error ? (result.data ?? result.value ?? null) : null);

/** @returns {Promise<string|null>} the stored thumbnail data URL, or null */
export const loadThumbnail = async (api, sheetId) => {
  const value = readValue(await api.settings.get(thumbnailKey(sheetId)));
  return isThumbnailDataUrl(value) ? value : null;
};

export const saveThumbnail = (api, sheetId, dataUrl) => api.settings.set(thumbnailKey(sheetId), dataUrl);

export const clearThumbnail = async (api, sheetId) => {
  try { await api.settings.set(thumbnailKey(sheetId), null); } catch { /* best effort */ }
};

/** Screenshot this window and store it as the sheet's thumbnail. */
export const captureSheetThumbnail = async (api, sheetId) => {
  const shot = await api.window.captureSelf({ width: THUMBNAIL_WIDTH, quality: THUMBNAIL_QUALITY });
  const dataUrl = shot?.data?.dataUrl;
  if (!shot?.success || !isThumbnailDataUrl(dataUrl)) return false;
  const result = await saveThumbnail(api, sheetId, dataUrl);
  return !(result && result.error);
};
