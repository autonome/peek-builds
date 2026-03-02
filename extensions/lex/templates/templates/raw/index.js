/**
 * Raw template pack — the default "raw" debugging view.
 *
 * Shows all underlying schema bits: field types, constraints, refs, unions.
 * This is the original monolithic UI from home.js extracted into template modules.
 */

export { AppTemplate } from './app-template.js';
export { ListTemplate } from './list-template.js';
export { LexiconTemplate } from './lexicon-template.js';
export { FormTemplate } from './form-template.js';

export const metadata = {
  name: 'raw',
  description: 'Raw schema debugging view — shows all field types, constraints, refs, unions',
  version: '1.0.0',
};
