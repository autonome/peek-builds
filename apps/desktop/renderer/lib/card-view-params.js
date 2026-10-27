/**
 * Window-open params for a card-view page (a feature's grid of cards).
 *
 * Pure, no DOM, so a feature's background script and unit tests can use it.
 * Every card view opens the same kind of window: a workspace role, created
 * transparent (transparency can only be set at creation, and the see-through
 * switch needs it), keyed by its URL so a second open reuses the window.
 */

export const CARD_VIEW_DEFAULT_SIZE = { width: 800, height: 600 };

/**
 * @param {object} opts
 * @param {string} opts.url the card view page URL (also the default key)
 * @param {string} opts.title window title
 * @param {string} [opts.key] window key; defaults to url
 * @param {number} [opts.width]
 * @param {number} [opts.height]
 * @param {object} [opts.extra] further params, which win over the defaults
 * @returns {object} params for `api.window.open(url, params)`
 */
export const cardViewWindowParams = ({ url, title, key, width, height, extra } = {}) => ({
  key: key || url,
  width: width || CARD_VIEW_DEFAULT_SIZE.width,
  height: height || CARD_VIEW_DEFAULT_SIZE.height,
  role: 'workspace',
  transparent: true,
  title,
  ...(extra || {})
});
