/**
 * Pure state for the translation models manager view (`models.html`). The view keeps one state
 * object and folds every `translate:models:*` answer from main
 * (`main/page-translate/model-topics.ts`) into it with the `apply*` functions here; `modelsView`
 * turns it into the rows to draw. No `window.app` here, so `tests/unit/translate-models.test.js`
 * runs it under Node.
 *
 * Directions, not pairs: main lists and deletes one model direction at a time (`es` → `en`),
 * because a pair that pivots through English shares its English legs with other pairs. The view
 * offers every direction the catalogue has, so a pivot pair is two downloads the user can see.
 */

import { languageName } from './translate-logic.js';

export const MODELS_TOPICS = Object.freeze({
  list: 'translate:models:list',
  listed: 'translate:models:listed',
  estimate: 'translate:models:estimate',
  estimated: 'translate:models:estimated',
  download: 'translate:models:download',
  progress: 'translate:models:progress',
  delete: 'translate:models:delete',
});

export const INITIAL_MODELS_STATE = Object.freeze({
  loaded: false,
  installed: [],
  available: null,
  error: null,
  /** key → 'estimating' | 'downloading' | 'deleting' */
  busy: {},
  /** key → text of the last failure for that direction */
  failures: {},
  /** the download waiting on the user's yes, `{from, to, downloadBytes, diskBytes}`, or null */
  prompt: null,
});

export function directionKey(from, to) {
  return `${from}>${to}`;
}

/** `37.0 MB`, `512 KB`, `0 B`; decimal units, as file sizes are shown on macOS. */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1000) return `${Math.round(n)} B`;
  if (n < 1e6) return `${Math.round(n / 1000)} KB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e9).toFixed(2)} GB`;
}

export function directionLabel(from, to) {
  return `${languageName(from)} → ${languageName(to)}`;
}

function without(map, key) {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

function directionsOf(list) {
  if (!Array.isArray(list)) return null;
  return list.filter(
    (d) => d && typeof d.sourceLanguage === 'string' && typeof d.targetLanguage === 'string',
  );
}

/**
 * A `translate:models:listed` answer. `available` stays as it was when the answer carries none:
 * main reads the catalogue only when asked, and its answers after a download or delete do not.
 * A listed answer settles every delete, because a delete is answered by a listed alone.
 */
export function applyListed(state, msg) {
  const installed = directionsOf(msg?.installed) ?? [];
  const available = directionsOf(msg?.available) ?? state.available;
  const busy = Object.fromEntries(Object.entries(state.busy).filter(([, v]) => v !== 'deleting'));
  return {
    ...state,
    loaded: true,
    installed,
    available,
    error: typeof msg?.error === 'string' && msg.error ? msg.error : null,
    busy,
  };
}

/** The user asked to download a direction: the view publishes an estimate first. */
export function requestDownload(state, from, to) {
  const key = directionKey(from, to);
  if (state.busy[key]) return { state, publish: null };
  return {
    state: { ...state, busy: { ...state.busy, [key]: 'estimating' }, failures: without(state.failures, key) },
    publish: { topic: MODELS_TOPICS.estimate, message: { from, to } },
  };
}

function estimateFailureText(msg) {
  if (msg.reason === 'unsupported') return 'No model for this direction in the catalogue.';
  if (msg.reason === 'same-language') return 'Source and target are the same language.';
  return msg.error ? `Could not size the download: ${msg.error}` : 'Could not size the download.';
}

/**
 * A `translate:models:estimated` answer. Nothing left to fetch downloads at once (the files are
 * on disk, so nothing goes over the network); otherwise the view asks first, naming the bytes.
 * An answer for a direction the view did not ask about is ignored.
 */
export function applyEstimated(state, msg) {
  if (!msg || typeof msg.from !== 'string' || typeof msg.to !== 'string') return { state, publish: null };
  const key = directionKey(msg.from, msg.to);
  if (state.busy[key] !== 'estimating') return { state, publish: null };
  if (!msg.ok) {
    return {
      state: { ...state, busy: without(state.busy, key), failures: { ...state.failures, [key]: estimateFailureText(msg) } },
      publish: null,
    };
  }
  const downloadBytes = Number(msg.downloadBytes) || 0;
  if (downloadBytes <= 0) {
    return {
      state: { ...state, busy: { ...state.busy, [key]: 'downloading' } },
      publish: { topic: MODELS_TOPICS.download, message: { from: msg.from, to: msg.to } },
    };
  }
  return {
    state: {
      ...state,
      prompt: { from: msg.from, to: msg.to, downloadBytes, diskBytes: Number(msg.diskBytes) || 0, engineBytes: Number(msg.engineBytes) || 0 },
    },
    publish: null,
  };
}

/** The user answered the prompt. Only a yes publishes the download. */
export function answerPrompt(state, accepted) {
  const prompt = state.prompt;
  if (!prompt) return { state, publish: null };
  const key = directionKey(prompt.from, prompt.to);
  if (!accepted) {
    return { state: { ...state, prompt: null, busy: without(state.busy, key) }, publish: null };
  }
  return {
    state: { ...state, prompt: null, busy: { ...state.busy, [key]: 'downloading' } },
    publish: { topic: MODELS_TOPICS.download, message: { from: prompt.from, to: prompt.to } },
  };
}

/** The text of the download prompt. */
export function promptText(prompt) {
  const label = directionLabel(prompt.from, prompt.to);
  const disk = prompt.diskBytes > prompt.downloadBytes ? ` It takes ${formatBytes(prompt.diskBytes)} on disk.` : '';
  const engineBytes = Number(prompt.engineBytes) || 0;
  const what = engineBytes > 0 ? `the ${label} translation model and the translation engine` : `the ${label} translation model`;
  const engine = engineBytes > 0 ? ` (${formatBytes(engineBytes)} of it is the engine, fetched once)` : '';
  return `Download ${what} from Mozilla? This fetches ${formatBytes(prompt.downloadBytes)}${engine}.${disk} Translation then runs on this device.`;
}

/** A `translate:models:progress` answer. */
export function applyProgress(state, msg) {
  if (!msg || typeof msg.from !== 'string' || typeof msg.to !== 'string') return state;
  const key = directionKey(msg.from, msg.to);
  switch (msg.phase) {
    case 'downloading':
      return { ...state, busy: { ...state.busy, [key]: 'downloading' }, failures: without(state.failures, key) };
    case 'done':
      return { ...state, busy: without(state.busy, key) };
    case 'failed':
      return {
        ...state,
        busy: without(state.busy, key),
        failures: { ...state.failures, [key]: `Download failed${msg.error ? `: ${msg.error}` : '.'}` },
      };
    default:
      return state;
  }
}

/** The user asked to delete an installed direction. */
export function requestDelete(state, from, to) {
  const key = directionKey(from, to);
  if (state.busy[key]) return { state, publish: null };
  return {
    state: { ...state, busy: { ...state.busy, [key]: 'deleting' }, failures: without(state.failures, key) },
    publish: { topic: MODELS_TOPICS.delete, message: { from, to } },
  };
}

const BUSY_TEXT = { estimating: 'Checking size…', downloading: 'Downloading…', deleting: 'Deleting…' };

function row(state, d, extra) {
  const key = directionKey(d.sourceLanguage, d.targetLanguage);
  const busy = state.busy[key] || null;
  return {
    key,
    from: d.sourceLanguage,
    to: d.targetLanguage,
    label: directionLabel(d.sourceLanguage, d.targetLanguage),
    busy,
    busyText: busy ? BUSY_TEXT[busy] : null,
    failure: state.failures[key] || null,
    ...extra,
  };
}

function byLabel(a, b) {
  return a.label.localeCompare(b.label);
}

/**
 * What the view draws: `installed` rows (with `size`), `available` rows (catalogue directions
 * not on disk; null until the catalogue answered), the total size on disk and a status line.
 */
export function modelsView(state) {
  const installedKeys = new Set(state.installed.map((d) => directionKey(d.sourceLanguage, d.targetLanguage)));
  const installed = state.installed.map((d) => row(state, d, { size: formatBytes(d.bytes) })).sort(byLabel);
  const available = state.available
    ? state.available
        .filter((d) => !installedKeys.has(directionKey(d.sourceLanguage, d.targetLanguage)))
        .map((d) => row(state, d, {}))
        .sort(byLabel)
    : null;
  const totalBytes = state.installed.reduce((sum, d) => sum + (Number(d.bytes) || 0), 0);
  let status = null;
  if (!state.loaded) status = 'Loading…';
  else if (state.error) status = `Could not read the model list: ${state.error}`;
  else if (available === null) status = 'Reading the list of downloadable models…';
  return { installed, available, total: formatBytes(totalBytes), status };
}
