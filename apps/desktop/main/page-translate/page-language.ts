/**
 * The page's declared language and the `page:translatable` wake event, kept free of Electron so
 * it runs under plain Node. `translate-main.ts pageTranslationLoaded` runs the script in a
 * freshly loaded page and publishes the event; the lazy `features/translate` tile wakes on it
 * and offers a translation.
 *
 * `page:translatable {windowId, url, lang}` is published only when the page declares a language
 * whose primary subtag differs from the target language, so a page already in the user's
 * language never wakes the tile.
 */

export const PAGE_TRANSLATABLE_TOPIC = 'page:translatable';

/**
 * Script run in the page to read its declared language: `<html lang>`, else the
 * `Content-Language` meta. Returns a string, empty when the page declares nothing. The same
 * script as `features/translate/translate-logic.js DECLARED_LANGUAGE_SCRIPT`.
 */
export const DECLARED_LANGUAGE_SCRIPT = `(() => {
  const lang = document.documentElement && document.documentElement.getAttribute('lang');
  if (lang && lang.trim()) return lang.trim();
  const meta = document.querySelector('meta[http-equiv="content-language" i]');
  return meta && meta.content ? meta.content.split(',')[0].trim() : '';
})()`;

const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** BCP 47 codes that name no language: undetermined, no linguistic content, multiple. */
const NOT_A_LANGUAGE = new Set(['und', 'zxx', 'mul', 'mis']);

/**
 * The primary language subtag of a BCP 47 tag, lower-cased (`de-AT` → `de`), or null when the
 * value is not shaped like a language tag or names no language. Matches
 * `features/translate/translate-logic.js primaryLanguage`.
 */
export function primaryLanguage(tag: unknown): string | null {
  if (typeof tag !== 'string') return null;
  const trimmed = tag.trim().replace(/_/g, '-');
  if (!LANGUAGE_TAG.test(trimmed)) return null;
  const primary = trimmed.split('-')[0].toLowerCase();
  return NOT_A_LANGUAGE.has(primary) ? null : primary;
}

/**
 * The language a page offers to translate from, or null when there is nothing to offer: the
 * page declares no usable language, the target is unknown, or both are the same language.
 */
export function translatableLanguage(declared: unknown, target: unknown): string | null {
  const from = primaryLanguage(declared);
  const to = primaryLanguage(target);
  if (!from || !to || from === to) return null;
  return from;
}

export interface PageTranslatablePayload {
  windowId: number;
  url: string;
  lang: string;
}
