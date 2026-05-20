/**
 * Raw Form Template — record creation form.
 *
 * Wraps lexicon-ui.js form generation with the raw UI chrome
 * (mode toggle, submit button, status display, picker selected display).
 * Extracted from home.js as-is.
 *
 * Events emitted:
 *   - 'submit' { nsid, record } — user submitted the form
 *   - 'back' — user clicked back (create-record panel)
 */

import { escapeHtml } from './utils.js';
import {
  resolveLexicon,
  getRecordSchema,
  generateForm,
  collectFormData,
  createRawJsonEditor,
  parseRawJson,
  nsidToFriendlyName,
  isBlueskyPost,
} from '../../lexicon-ui.js';

export class FormTemplate {
  constructor() {
    this._listeners = {};
  }

  on(event, handler) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(handler);
    return this;
  }

  _emit(event, data) {
    const handlers = this._listeners[event] || [];
    for (const h of handlers) h(data);
  }

  // =========================================================================
  // Create Record panel (detail view from My Lexicons / Explore)
  // =========================================================================

  /**
   * Set up the create-record detail panel event listeners.
   * Called once at init.
   * @param {Object} refs — DOM element refs
   * @param {Object} stateRef — mutable state reference
   */
  setupCreateRecord(refs, stateRef) {
    const {
      createRecordBackBtn, modeFormBtn, modeJsonBtn,
      createFormContainer, createJsonContainer, createSubmitBtn,
    } = refs;

    createRecordBackBtn.addEventListener('click', () => this._emit('back'));

    modeFormBtn.addEventListener('click', () => {
      stateRef.createMode = 'form';
      modeFormBtn.classList.add('active');
      modeJsonBtn.classList.remove('active');
      createFormContainer.style.display = '';
      createJsonContainer.style.display = 'none';
    });

    modeJsonBtn.addEventListener('click', () => {
      stateRef.createMode = 'json';
      modeJsonBtn.classList.add('active');
      modeFormBtn.classList.remove('active');
      createFormContainer.style.display = 'none';
      createJsonContainer.style.display = '';
      // Lazy-init the JSON editor
      if (createJsonContainer.children.length === 0 && stateRef.createNsid) {
        const editor = createRawJsonEditor(stateRef.createNsid);
        createJsonContainer.appendChild(editor);
      }
    });

    createSubmitBtn.addEventListener('click', () => {
      this._emit('submit-create-record');
    });
  }

  /**
   * Open the create record panel for a given NSID.
   * Resets UI state and loads the schema.
   * @param {Object} refs — DOM refs
   * @param {Object} stateRef — mutable state ref
   * @param {string} nsid
   */
  async openCreateRecord(refs, stateRef, nsid) {
    const {
      createRecordNsidEl, createFormContainer, createJsonContainer,
      createSchemaLoading, createSchemaError, createSubmitArea,
      createSubmitStatus, modeFormBtn, modeJsonBtn,
    } = refs;

    stateRef.createNsid = nsid;
    stateRef.createLexicon = null;
    stateRef.createSchema = null;
    stateRef.createMode = 'form';
    stateRef.createSubmitting = false;

    // Reset UI
    const friendly = nsidToFriendlyName(nsid);
    createRecordNsidEl.innerHTML = `
      <span class="create-record-friendly">${escapeHtml(friendly)}</span>
      <span class="create-record-nsid-sub">${escapeHtml(nsid)}</span>
    `;
    createFormContainer.innerHTML = '';
    createJsonContainer.innerHTML = '';
    createSchemaLoading.style.display = '';
    createSchemaError.style.display = 'none';
    createSubmitArea.style.display = 'none';
    createSubmitStatus.style.display = 'none';
    modeFormBtn.classList.add('active');
    modeJsonBtn.classList.remove('active');
    createFormContainer.style.display = '';
    createJsonContainer.style.display = 'none';

    // Fetch the lexicon schema
    try {
      const lexicon = await resolveLexicon(nsid);
      createSchemaLoading.style.display = 'none';

      if (!lexicon) {
        createSchemaError.textContent = 'Could not resolve lexicon schema. Use Raw JSON mode to create a record.';
        createSchemaError.style.display = '';
        modeJsonBtn.click();
        createSubmitArea.style.display = '';
        return;
      }

      stateRef.createLexicon = lexicon;
      const schema = getRecordSchema(lexicon);

      if (!schema) {
        createSchemaError.textContent = 'This lexicon does not define a record type. It may be a query or procedure.';
        createSchemaError.style.display = '';
        modeJsonBtn.click();
        createSubmitArea.style.display = '';
        return;
      }

      stateRef.createSchema = schema;

      // Generate the form
      const form = await generateForm(nsid, schema, lexicon, {
        autoFillCreatedAt: true,
      });
      createFormContainer.appendChild(form);

      // Show submit area
      createSubmitArea.style.display = '';

    } catch (err) {
      createSchemaLoading.style.display = 'none';
      createSchemaError.textContent = `Failed to load schema: ${err.message}`;
      createSchemaError.style.display = '';
      // Allow JSON fallback
      createSubmitArea.style.display = '';
    }
  }

  /**
   * Set the upload blob function. Called by home.js with the session-bound uploader.
   * @param {function} fn - async (file) => { blob: ... }
   */
  setUploadBlobFn(fn) {
    this._uploadBlobFn = fn;
  }

  /**
   * Collect form data for create-record panel.
   * @param {Object} refs
   * @param {Object} stateRef
   * @returns {Promise<Object>} the record data
   */
  async collectCreateRecordData(refs, stateRef) {
    if (stateRef.createMode === 'json') {
      return parseRawJson(refs.createJsonContainer, stateRef.createNsid);
    }
    const form = refs.createFormContainer.querySelector('.lexicon-form');
    if (!form) {
      throw new Error('No form found. Switch to Raw JSON mode.');
    }
    return await collectFormData(form, stateRef.createSchema, stateRef.createLexicon, stateRef.createNsid, {
      uploadBlobFn: this._uploadBlobFn,
    });
  }

  /**
   * Validate required fields for form mode.
   * Bluesky post validation is handled in collectBlueskyPostData.
   * @param {Object} stateRef
   * @param {Object} record
   * @throws {Error} if required fields missing
   */
  validateRequired(stateRef, record) {
    // Bluesky post does its own validation during collection
    if (isBlueskyPost(stateRef.createNsid)) return;

    if (stateRef.createSchema && stateRef.createMode === 'form') {
      const required = stateRef.createSchema.required || [];
      const missing = required.filter(f => {
        const val = record[f];
        return val === undefined || val === null || val === '';
      });
      if (missing.length > 0) {
        throw new Error(`Required fields missing: ${missing.join(', ')}`);
      }
    }
  }

  // =========================================================================
  // Create Panel (dedicated nav panel)
  // =========================================================================

  /**
   * Set up the create panel (dedicated nav) event listeners.
   * @param {Object} refs
   * @param {Object} stateRef
   */
  setupCreatePanel(refs, stateRef) {
    const { cpModeFormBtn, cpModeJsonBtn, cpFormContainer, cpJsonContainer, cpSubmitBtn } = refs;

    cpModeFormBtn.addEventListener('click', () => {
      stateRef.cpMode = 'form';
      cpModeFormBtn.classList.add('active');
      cpModeJsonBtn.classList.remove('active');
      cpFormContainer.style.display = '';
      cpJsonContainer.style.display = 'none';
    });

    cpModeJsonBtn.addEventListener('click', () => {
      stateRef.cpMode = 'json';
      cpModeJsonBtn.classList.add('active');
      cpModeFormBtn.classList.remove('active');
      cpFormContainer.style.display = 'none';
      cpJsonContainer.style.display = '';
      if (cpJsonContainer.children.length === 0 && stateRef.cpNsid) {
        const editor = createRawJsonEditor(stateRef.cpNsid);
        cpJsonContainer.appendChild(editor);
      }
    });

    cpSubmitBtn.addEventListener('click', () => {
      this._emit('submit-create-panel');
    });
  }

  /**
   * Render the selected lexicon in the picker area and load its form.
   * @param {Object} refs
   * @param {Object} stateRef
   * @param {string} nsid
   */
  async selectPickerLexicon(refs, stateRef, nsid) {
    const {
      pickerInput, pickerResults, pickerSelected,
      cpFormContainer, cpJsonContainer, cpSchemaLoading, cpSchemaError, cpEmpty,
      cpModeToggle, cpModeFormBtn, cpModeJsonBtn, cpFooter, cpSubmitStatus,
    } = refs;

    stateRef.cpNsid = nsid;
    stateRef.cpLexicon = null;
    stateRef.cpSchema = null;
    stateRef.cpMode = 'form';
    stateRef.cpSubmitting = false;

    pickerInput.style.display = 'none';
    pickerSelected.style.display = 'flex';
    const pickerFriendly = nsidToFriendlyName(nsid);
    pickerSelected.innerHTML = `
      <div class="picker-selected-info">
        <span class="picker-selected-friendly">${escapeHtml(pickerFriendly)}</span>
        <span class="picker-selected-nsid">${escapeHtml(nsid)}</span>
      </div>
      <button class="picker-selected-clear" title="Change lexicon">&times;</button>
    `;
    pickerSelected.querySelector('.picker-selected-clear').addEventListener('click', () => {
      this._emit('picker-clear');
    });

    // Reset form area
    cpFormContainer.innerHTML = '';
    cpJsonContainer.innerHTML = '';
    cpSchemaLoading.style.display = '';
    cpSchemaError.style.display = 'none';
    cpEmpty.style.display = 'none';
    cpModeToggle.style.display = 'none';
    cpFooter.style.display = 'none';
    cpSubmitStatus.style.display = 'none';
    cpModeFormBtn.classList.add('active');
    cpModeJsonBtn.classList.remove('active');
    cpFormContainer.style.display = '';
    cpJsonContainer.style.display = 'none';

    // Fetch schema and generate form
    try {
      const lexicon = await resolveLexicon(nsid);
      cpSchemaLoading.style.display = 'none';

      if (!lexicon) {
        cpSchemaError.textContent = 'Could not resolve lexicon schema. Use Raw JSON mode.';
        cpSchemaError.style.display = '';
        cpModeToggle.style.display = '';
        cpModeJsonBtn.click();
        cpFooter.style.display = '';
        return;
      }

      stateRef.cpLexicon = lexicon;
      const schema = getRecordSchema(lexicon);

      if (!schema) {
        cpSchemaError.textContent = 'This lexicon does not define a record type. It may be a query or procedure.';
        cpSchemaError.style.display = '';
        cpModeToggle.style.display = '';
        cpModeJsonBtn.click();
        cpFooter.style.display = '';
        return;
      }

      stateRef.cpSchema = schema;

      const form = await generateForm(nsid, schema, lexicon, {
        autoFillCreatedAt: true,
      });
      cpFormContainer.appendChild(form);

      cpModeToggle.style.display = '';
      cpFooter.style.display = '';
    } catch (err) {
      cpSchemaLoading.style.display = 'none';
      cpSchemaError.textContent = `Failed to load schema: ${err.message}`;
      cpSchemaError.style.display = '';
      cpModeToggle.style.display = '';
      cpFooter.style.display = '';
    }
  }

  /**
   * Clear the picker selection.
   * @param {Object} refs
   * @param {Object} stateRef
   */
  clearPickerSelection(refs, stateRef) {
    const {
      pickerInput, pickerSelected,
      cpFormContainer, cpJsonContainer, cpSchemaLoading, cpSchemaError, cpEmpty,
      cpModeToggle, cpFooter, cpSubmitStatus,
    } = refs;

    stateRef.cpNsid = null;
    stateRef.cpLexicon = null;
    stateRef.cpSchema = null;

    pickerInput.style.display = '';
    pickerInput.value = '';
    pickerSelected.style.display = 'none';

    cpFormContainer.innerHTML = '';
    cpJsonContainer.innerHTML = '';
    cpSchemaLoading.style.display = 'none';
    cpSchemaError.style.display = 'none';
    cpEmpty.style.display = '';
    cpModeToggle.style.display = 'none';
    cpFooter.style.display = 'none';
    cpSubmitStatus.style.display = 'none';

    stateRef.pickerFilter = '';
    pickerInput.focus();
  }

  /**
   * Collect form data for create panel.
   * @param {Object} refs
   * @param {Object} stateRef
   * @returns {Promise<Object>}
   */
  async collectCreatePanelData(refs, stateRef) {
    if (stateRef.cpMode === 'json') {
      return parseRawJson(refs.cpJsonContainer, stateRef.cpNsid);
    }
    const form = refs.cpFormContainer.querySelector('.lexicon-form');
    if (!form) throw new Error('No form found. Switch to Raw JSON mode.');
    return await collectFormData(form, stateRef.cpSchema, stateRef.cpLexicon, stateRef.cpNsid, {
      uploadBlobFn: this._uploadBlobFn,
    });
  }

  /**
   * Validate required fields for create panel form mode.
   * Bluesky post validation is handled in collectBlueskyPostData.
   * @param {Object} stateRef
   * @param {Object} record
   * @throws {Error}
   */
  validateCreatePanelRequired(stateRef, record) {
    // Bluesky post does its own validation during collection
    if (isBlueskyPost(stateRef.cpNsid)) return;

    if (stateRef.cpSchema && stateRef.cpMode === 'form') {
      const required = stateRef.cpSchema.required || [];
      const missing = required.filter(f => {
        const val = record[f];
        return val === undefined || val === null || val === '';
      });
      if (missing.length > 0) {
        throw new Error(`Required fields missing: ${missing.join(', ')}`);
      }
    }
  }
}
