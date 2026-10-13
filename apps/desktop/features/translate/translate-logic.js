/**
 * Pure helpers for the translate tile: building a `translate:page` request from what the
 * command and the page supply, and turning a `translate:state` payload into the text of the
 * page widget. No `window.app` here, so `tests/unit/translate-tile.test.js` runs it under Node.
 */

/** Same shape main accepts in `translate-topics.ts languageOf`. */
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/**
 * The primary language subtag of a BCP 47 tag, lower-cased (`de-AT` → `de`), or null when the
 * value is not shaped like a language tag. Script and region subtags are dropped because the
 * model catalogue names most languages by the primary subtag alone; the variants it does
 * distinguish (`zh-Hans`) are handled with page-language detection in a later step.
 */
export function primaryLanguage(tag) {
  if (typeof tag !== 'string') return null;
  const trimmed = tag.trim().replace(/_/g, '-');
  if (!LANGUAGE_TAG.test(trimmed)) return null;
  return trimmed.split('-')[0].toLowerCase();
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
};

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * What the page widget shows for a `translate:state` payload: `{title, text}`, or null when the
 * widget should close (back to the original with nothing to report, or the window is gone).
 */
export function statusView(state) {
  if (!state || typeof state !== 'object') return null;
  const from = languageName(state.from);
  const to = languageName(state.to);
  const title = 'Translation';
  if (state.error) {
    return { title, text: ERROR_TEXT[state.error] || `Translation stopped: ${state.error}` };
  }
  switch (state.phase) {
    case 'collecting':
    case 'translating': {
      const done = state.applied > 0 ? ` (${state.applied} passages so far)` : '';
      return { title, text: `Translating from ${from} to ${to}…${done}` };
    }
    case 'translated':
      return { title, text: `Translated from ${from} to ${to}. Run "show original" to restore the page.` };
    case 'restoring':
      return { title, text: 'Restoring the original text…' };
    default:
      return null;
  }
}

/** Widget body markup for a `statusView` result. */
export function statusHtml(view) {
  return `<div style="font-size:12px;line-height:1.4;color:var(--theme-text,#e0e0e0);">${escapeHtml(view.text)}</div>`;
}
