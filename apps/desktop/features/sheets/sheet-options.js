/**
 * Per-sheet display options, read from a sheet's saved config.
 *
 * Pure leaf module (no DOM, no electron) so it can be unit tested directly.
 * A config that predates these fields has neither one, and reads as today's
 * behaviour: not maximized, opaque theme background.
 */

export const BACKGROUND_KINDS = ['opaque', 'transparent', 'image'];

/**
 * Resolve the display options of a sheet config, filling in defaults.
 * Never throws; unknown or malformed values fall back to the defaults.
 *
 * @param {object|null|undefined} config saved sheet config
 * @returns {{maximized: boolean, background: {kind: string, image?: string}}}
 */
export const resolveSheetOptions = (config) => {
  const maximized = config?.maximized === true;
  const bg = config?.background;
  const kind = BACKGROUND_KINDS.includes(bg?.kind) ? bg.kind : 'opaque';
  const background = { kind };
  if (kind === 'image') {
    if (typeof bg.image === 'string' && bg.image) {
      background.image = bg.image;
    } else {
      // An image background with no image chosen has nothing to show.
      background.kind = 'opaque';
    }
  }
  return { maximized, background };
};

/**
 * Window-open parameters that realise a sheet's options when it opens.
 * `maximized` is read by the page-host path and `maximize` by the plain
 * window path; both ask for the same thing. Transparency is a creation-time
 * window option.
 *
 * @param {object|null|undefined} config saved sheet config
 * @returns {{maximized?: true, maximize?: true, transparent?: true}}
 */
export const windowParamsForSheet = (config) => {
  const { maximized, background } = resolveSheetOptions(config);
  const params = {};
  if (maximized) {
    params.maximized = true;
    params.maximize = true;
  }
  if (background.kind === 'transparent') params.transparent = true;
  return params;
};
