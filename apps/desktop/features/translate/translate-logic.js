/**
 * Pure helpers for the translate tile: building a `translate:page` request from what the
 * command and the page supply, and turning a `translate:state` payload into the text of the
 * page widget. No `window.app` here, so `tests/unit/translate-tile.test.js` runs it under Node.
 */

/** Same shape main accepts in `translate-topics.ts languageOf`. */
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** BCP 47 codes that name no language: undetermined, no linguistic content, multiple. */
const NOT_A_LANGUAGE = new Set(['und', 'zxx', 'mul', 'mis']);

/**
 * The primary language subtag of a BCP 47 tag, lower-cased (`de-AT` → `de`), or null when the
 * value is not shaped like a language tag or names no language. Script and region subtags are
 * dropped because the model catalogue names most languages by the primary subtag alone; the
 * variants it does distinguish (`zh-Hans`) are handled with page-language detection in a later
 * step. Matches `main/page-translate/page-language.ts primaryLanguage`.
 */
export function primaryLanguage(tag) {
  if (typeof tag !== 'string') return null;
  const trimmed = tag.trim().replace(/_/g, '-');
  if (!LANGUAGE_TAG.test(trimmed)) return null;
  const primary = trimmed.split('-')[0].toLowerCase();
  return NOT_A_LANGUAGE.has(primary) ? null : primary;
}

/**
 * Script run in the page to read its declared language: `<html lang>`, else the
 * `Content-Language` meta. Returns a string, empty when the page declares nothing.
 */
export const DECLARED_LANGUAGE_SCRIPT = `(() => {
  const lang = document.documentElement && document.documentElement.getAttribute('lang');
  if (lang && lang.trim()) return lang.trim();
  const meta = document.querySelector('meta[http-equiv="content-language" i]');
  return meta && meta.content ? meta.content.split(',')[0].trim() : '';
})()`;

/**
 * Decides the `translate:page` message for a `translate page [language]` command.
 *
 * @param {object} input
 * @param {number|null} input.windowId - the window the user is looking at
 * @param {string|null} input.declared - the page's declared language, as read from the page
 * @param {string} [input.requested] - the command's argument, if any
 * @param {string|null} input.fallbackTarget - the system language
 * @returns {{ok: true, message: {windowId: number, from: string, to: string}}
 *          | {ok: false, reason: 'no-window'|'bad-target'|'no-target'|'no-language'|'same-language', from?: string, to?: string}}
 */
export function buildTranslateRequest({ windowId, declared, requested, fallbackTarget }) {
  if (!Number.isInteger(windowId) || windowId <= 0) return { ok: false, reason: 'no-window' };
  const asked = typeof requested === 'string' ? requested.trim() : '';
  let to;
  if (asked) {
    to = primaryLanguage(asked);
    if (!to) return { ok: false, reason: 'bad-target' };
  } else {
    to = primaryLanguage(fallbackTarget);
    if (!to) return { ok: false, reason: 'no-target' };
  }
  const from = primaryLanguage(declared);
  if (!from) return { ok: false, reason: 'no-language', to };
  if (from === to) return { ok: false, reason: 'same-language', from, to };
  return { ok: true, message: { windowId, from, to } };
}

/** English name of a language code, falling back to the code itself. */
export function languageName(code) {
  if (!code) return '';
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
}

/** The command's reply when `buildTranslateRequest` refuses. */
export function refusalText(result) {
  switch (result.reason) {
    case 'no-window': return 'No web page is in front to translate.';
    case 'bad-target': return 'Name the language to translate into as a code, such as de, fr or ja.';
    case 'no-target': return 'Could not tell the system language; name one, such as "translate page de".';
    case 'no-language': return 'This page does not declare its language, so it cannot be translated yet.';
    case 'same-language': return `This page is already in ${languageName(result.to)}.`;
    default: return 'The page could not be translated.';
  }
}

const ERROR_TEXT = {
  'no-page': 'There is no web page in this window to translate.',
  'models-needed': 'The translation model for these languages is not downloaded yet. Get it with "manage translation models".',
  'unsupported-pair': 'No translation model covers these languages.',
  'no-engine': 'The translation engine is not available.',
};

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The widget action that puts the page's own text back (`widget:action` `action`). */
export const SHOW_ORIGINAL_ACTION = 'show-original';

const SHOW_ORIGINAL_BUTTON = { action: SHOW_ORIGINAL_ACTION, label: 'Show original' };

/**
 * The widget action that starts a translation from the offer. Its `value` carries both
 * languages, `"<from> <to>"`, so the click alone names the request.
 */
export const TRANSLATE_ACTION = 'translate';

/**
 * What the page widget shows when a page declares a language other than the target (a
 * `page:translatable` payload): `{title, text, actions}` with a "Translate from X" button, or
 * null when there is nothing to offer.
 *
 * @param {{lang: string, target: string|null}} input - the page's language and the target
 */
export function offerView({ lang, target }) {
  const from = primaryLanguage(lang);
  const to = primaryLanguage(target);
  if (!from || !to || from === to) return null;
  return {
    title: 'Translation',
    text: `This page is in ${languageName(from)}.`,
    actions: [{ action: TRANSLATE_ACTION, label: `Translate from ${languageName(from)}`, value: `${from} ${to}` }],
  };
}

/**
 * What the page widget shows for a `translate:state` payload: `{title, text, actions}`, or null
 * when the widget should close (back to the original with nothing to report, or the window is
 * gone). `actions` are the buttons, `{action, label}`, each sent back on `widget:action`.
 */
export function statusView(state) {
  if (!state || typeof state !== 'object') return null;
  const from = languageName(state.from);
  const to = languageName(state.to);
  const title = 'Translation';
  if (state.error) {
    return { title, text: ERROR_TEXT[state.error] || `Translation stopped: ${state.error}`, actions: [] };
  }
  switch (state.phase) {
    case 'collecting':
    case 'translating': {
      const done = state.applied > 0 ? ` (${state.applied} passages so far)` : '';
      return { title, text: `Translating from ${from} to ${to}…${done}`, actions: [SHOW_ORIGINAL_BUTTON] };
    }
    case 'translated':
      return { title, text: `Translated from ${from} to ${to}.`, actions: [SHOW_ORIGINAL_BUTTON] };
    case 'restoring':
      return { title, text: 'Restoring the original text…', actions: [] };
    default:
      return null;
  }
}

/**
 * Widget body markup for a `statusView` result. Buttons are `<peek-button>`s carrying
 * `data-widget-action`, which the page widget host (`renderer/page/page-widgets.js`) turns into
 * a `widget:action` publish when clicked.
 */
export function statusHtml(view) {
  const text = `<div style="font-size:12px;line-height:1.4;color:var(--theme-text,#e0e0e0);">${escapeHtml(view.text)}</div>`;
  const actions = Array.isArray(view.actions) ? view.actions : [];
  if (actions.length === 0) return text;
  const buttons = actions
    .map((a) => {
      const value = typeof a.value === 'string' ? ` data-widget-value="${escapeHtml(a.value)}"` : '';
      return `<peek-button size="sm" variant="secondary" data-widget-action="${escapeHtml(a.action)}"${value}>${escapeHtml(a.label)}</peek-button>`;
    })
    .join('');
  return `${text}<div style="display:flex;gap:6px;margin-top:8px;">${buttons}</div>`;
}

/**
 * The `translate:*` publish a click in this tile's widget asks for, or null when the
 * `widget:action` is for another widget, names an unknown action, or carries no window.
 *
 * @param {object} msg - a `widget:action` payload `{extensionId, widgetId, action, value, windowId}`
 * @param {{extensionId: string, widgetId: string}} own - this tile's widget
 * @returns {{topic: string, message: object}|null}
 */
export function widgetActionRequest(msg, own) {
  if (!msg || msg.extensionId !== own.extensionId || msg.widgetId !== own.widgetId) return null;
  if (!Number.isInteger(msg.windowId) || msg.windowId <= 0) return null;
  if (msg.action === SHOW_ORIGINAL_ACTION) {
    return { topic: 'translate:show-original', message: { windowId: msg.windowId } };
  }
  if (msg.action === TRANSLATE_ACTION && typeof msg.value === 'string') {
    const [rawFrom, rawTo, ...rest] = msg.value.trim().split(/\s+/);
    const from = primaryLanguage(rawFrom);
    const to = primaryLanguage(rawTo);
    if (rest.length > 0 || !from || !to || from === to) return null;
    return { topic: 'translate:page', message: { windowId: msg.windowId, from, to } };
  }
  return null;
}
