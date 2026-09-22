/**
 * Peek Navbar Component
 *
 * A floating navigation bar with URL input, back/forward/reload buttons,
 * and keyboard shortcuts (Cmd+L to focus, Escape to blur, Enter to navigate).
 *
 * @element peek-navbar
 *
 * @prop {string} url - Current URL to display
 * @prop {boolean} canGoBack - Whether back navigation is available
 * @prop {boolean} canGoForward - Whether forward navigation is available
 *
 * @fires navigate - When user enters a URL and presses Enter. Detail: { url }
 * @fires go-back - When back button is clicked or Cmd+[ pressed
 * @fires go-forward - When forward button is clicked or Cmd+] pressed
 * @fires reload - When reload button is clicked or Cmd+R pressed
 * @fires show - When navbar becomes visible
 * @fires hide - When navbar is dismissed
 *
 * @cssprop --peek-navbar-bg - Navbar background color
 * @cssprop --peek-navbar-height - Navbar height (default: 36px)
 *
 * @example
 * <peek-navbar
 *   url="https://example.com"
 *   .canGoBack=${true}
 *   @navigate=${(e) => webview.loadURL(e.detail.url)}
 *   @go-back=${() => webview.goBack()}
 *   @go-forward=${() => webview.goForward()}
 *   @reload=${() => webview.reload()}
 * ></peek-navbar>
 */

import { html, css } from 'lit';
import { PeekElement, sharedStyles } from './base.js';
// Pure granularity helpers, shared with the cmd panel's inline URL ghost.
// Relative import (not peek://cmd/): this file loads from renderer/components/ in
// BOTH contexts — at runtime as peek://app/components/peek-navbar.js (host `app` →
// renderer/, so `../cmd/` → renderer/cmd/) and over http in the component test
// (/apps/desktop/renderer/components/ → ../cmd/ → renderer/cmd/). A custom-scheme
// importmap prefix (peek://cmd/) is NOT remapped by Chromium, so a relative
// specifier is the portable one. Leaf module — no DOM/electron deps.
import { urlMatchable, urlCompletionAtGranularity, URL_GRANULARITY_ORDER, withDefaultScheme } from '../cmd/url-completion.js';

// Debounce before firing a frecency query for the typed text. The generation
// counter (not this delay) is the staleness-correctness mechanism.
const URL_GHOST_DEBOUNCE_MS = 150;
// How many history suggestions to show in the dropdown.
const URL_SUGGEST_LIMIT = 6;

export class PeekNavbar extends PeekElement {
  static properties = {
    url: { type: String },
    canGoBack: { type: Boolean, attribute: 'can-go-back' },
    canGoForward: { type: Boolean, attribute: 'can-go-forward' },
    visible: { type: Boolean, reflect: true },
    /** When true, a loading spinner is shown in the URL input */
    loading: { type: Boolean },
    /** When true, component registers its own document-level keyboard shortcuts
     * (Cmd+L, Cmd+R, Cmd+[, Cmd+]). Set to false if the host manages these. */
    shortcuts: { type: Boolean },
    /** Page title to display (favicon + title chip left of the URL). Empty =
     * hidden. Additive: the canvas page.js never sets these, so the chip stays
     * hidden and the bar renders exactly as before on that path. */
    pageTitle: { type: String, attribute: 'page-title' },
    /** Favicon URL for the title chip. Empty = no favicon image shown. */
    favicon: { type: String },
    /** History suggestions for the open dropdown (internal reactive state). */
    _suggestions: { state: true },
    /** Highlighted dropdown row; -1 = none (inline ghost is the implicit target). */
    _selectedIndex: { state: true },
  };

  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
        /* No fixed height: the bar row (.navbar) owns its 36px, and the host
         * grows downward to wrap the open suggestion dropdown. That keeps the
         * host's bounding box covering the dropdown, so the overlay's
         * pointer-over-chrome hit-test (getBoundingClientRect) stays opaque there
         * and the rows remain clickable. Collapsed, the host is exactly 36px. */
      }

      .navbar {
        height: var(--peek-navbar-height, 36px);
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 0 12px;
        background: var(--peek-navbar-bg, var(--theme-bg-secondary, rgba(30, 30, 30, 0.92)));
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        color: var(--theme-text, #e0e0e0);
        font-family: var(--theme-font-sans, system-ui, -apple-system, BlinkMacSystemFont, sans-serif);
        font-size: 15px;
        border: var(--theme-surface-border, 1px solid rgba(255, 255, 255, 0.2));
        box-shadow: var(--theme-surface-ring, 0 0 0 1px rgba(0, 0, 0, 0.5));
        border-radius: 10px;
        user-select: none;
        -webkit-user-select: none;
      }

      .nav-btn {
        background: none;
        border: none;
        color: var(--theme-text-secondary, #bbb);
        font-size: 20px;
        width: 36px;
        height: 36px;
        border-radius: 8px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        flex-shrink: 0;
        transition: background 0.1s, color 0.1s;
      }

      .nav-btn:hover:not(:disabled) {
        background: var(--theme-bg-tertiary, rgba(255, 255, 255, 0.12));
        color: var(--theme-text, #fff);
      }

      .nav-btn:active:not(:disabled) {
        background: var(--theme-bg-tertiary, rgba(255, 255, 255, 0.2));
      }

      .nav-btn:disabled {
        color: var(--theme-text-muted, #555);
        cursor: default;
      }

      .url-text {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--theme-text-secondary, #aaa);
        font-size: 14px;
        font-family: inherit;
        padding: 6px 10px;
        border-radius: 6px;
        background: var(--theme-bg-tertiary, rgba(128, 128, 128, 0.1));
        border: none;
        outline: none;
        cursor: text;
        min-width: 0;
      }

      .url-text:hover {
        background: var(--theme-bg, rgba(128, 128, 128, 0.18));
      }

      .url-text:focus {
        background: var(--theme-bg, rgba(128, 128, 128, 0.22));
        color: var(--theme-text, #e0e0e0);
      }

      .url-container {
        flex: 1;
        position: relative;
        display: flex;
        align-items: center;
        min-width: 0;
      }

      .url-container .url-text {
        flex: 1;
        padding-right: 28px;
      }

      .loading-spinner {
        position: absolute;
        right: 8px;
        width: 14px;
        height: 14px;
        border: 1.5px solid var(--theme-text-muted, #666);
        border-top-color: var(--theme-accent, #007aff);
        border-radius: 50%;
        animation: navbar-spin 0.7s linear infinite;
        flex-shrink: 0;
        pointer-events: none;
      }

      @keyframes navbar-spin {
        to { transform: rotate(360deg); }
      }

      /* Title chip — favicon + page title, shown left of the URL. Hidden
       * entirely when neither favicon nor title is set (the canvas path never
       * sets them, so the bar is byte-identical there). */
      .title-chip {
        display: flex;
        align-items: center;
        gap: 6px;
        max-width: 220px;
        flex-shrink: 0;
        color: var(--theme-text, #e0e0e0);
        font-size: 14px;
      }

      .title-favicon {
        width: 16px;
        height: 16px;
        flex-shrink: 0;
        border-radius: 3px;
        object-fit: contain;
      }

      .title-text {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* URL-history suggestion dropdown. Rendered IN FLOW as a sibling below the
       * bar (not absolutely positioned) so the host grows to contain it — see the
       * :host note. Mirrors the cmd panel's url-result-item row structure. */
      .url-suggestions {
        margin-top: 4px;
        padding: 6px;
        background: var(--peek-navbar-bg, var(--theme-bg-secondary, rgba(30, 30, 30, 0.96)));
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        color: var(--theme-text, #e0e0e0);
        border: var(--theme-surface-border, 1px solid rgba(255, 255, 255, 0.2));
        box-shadow: var(--theme-surface-ring, 0 6px 20px rgba(0, 0, 0, 0.45));
        border-radius: 10px;
        max-height: 320px;
        overflow-y: auto;
        font-size: 13px;
      }

      .url-suggestion {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 8px;
        border-radius: 6px;
        cursor: pointer;
      }

      .url-suggestion:hover {
        background: var(--theme-bg-tertiary, rgba(255, 255, 255, 0.08));
      }

      .url-suggestion.selected {
        background: var(--theme-bg, rgba(255, 255, 255, 0.14));
      }

      .url-favicon,
      .url-favicon-placeholder {
        width: 16px;
        height: 16px;
        flex-shrink: 0;
        border-radius: 3px;
        object-fit: contain;
      }

      .url-title {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .url-subtitle {
        flex-shrink: 0;
        max-width: 45%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--theme-text-secondary, #aaa);
        font-size: 12px;
      }
    `
  ];

  constructor() {
    super();
    this.url = '';
    this.canGoBack = false;
    this.canGoForward = false;
    this.visible = false;
    this.loading = false;
    this.shortcuts = true;
    this.pageTitle = '';
    this.favicon = '';
    this._handleKeydown = this._handleKeydown.bind(this);

    // ── URL-history autocomplete state ──────────────────────────────────────
    // Dropdown (reactive):
    this._suggestions = [];
    this._selectedIndex = -1;
    // Inline ghost (imperative — driven directly on the native <input> via
    // setSelectionRange, so Backspace / type-over reject the completion for free):
    this._ghost = null;            // { url, matchable } | null
    this._ghostGranularity = 'host';
    this._ghostGeneration = 0;     // staleness guard for async query results
    this._ghostTimer = null;
    this._typedAnchor = '';        // the user's REAL typed text (selection anchor)
    /** Optional injectable async query fn `(search) => Promise<items[]>`. When
     * unset, the component queries `window.app.datastore` directly. Used by the
     * component test to feed deterministic history without a live datastore. */
    this.urlSuggestionProvider = null;
  }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener('keydown', this._handleKeydown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('keydown', this._handleKeydown);
  }

  get inputElement() {
    return this.shadowRoot?.querySelector('.url-text');
  }

  /**
   * Normalize a URL input, adding a default scheme if needed — http:// for a
   * loopback host, https:// for everything else.
   */
  _normalizeUrl(input) {
    const trimmed = input.trim();
    if (!trimmed) return null;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return withDefaultScheme(trimmed);
  }

  /**
   * Handle global keyboard shortcuts (only when shortcuts property is true)
   */
  _handleKeydown(e) {
    if (!this.shortcuts) return;

    // Cmd+L to focus URL input
    if (e.key === 'l' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      this.focusUrl();
      return;
    }

    // Cmd+R to reload
    if (e.key === 'r' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      this.emit('reload');
      return;
    }

    // Cmd+[ or Cmd+Left to go back
    if ((e.key === '[' || e.key === 'ArrowLeft') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (this.canGoBack) this.emit('go-back');
      return;
    }

    // Cmd+] or Cmd+Right to go forward
    if ((e.key === ']' || e.key === 'ArrowRight') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (this.canGoForward) this.emit('go-forward');
      return;
    }
  }

  /**
   * Handle keydown in the URL input field.
   *
   * Tab        → accept/expand the inline ghost (advance granularity)
   * ArrowDown  → move dropdown selection down (enters the list from the ghost)
   * ArrowUp    → move dropdown selection up (back out to the inline ghost)
   * Enter      → navigate to the highlighted suggestion, else the input value
   * Escape     → close the dropdown first; exit the navbar only once closed
   */
  _onUrlKeydown(e) {
    const input = this.inputElement;

    if (e.key === 'Tab' && !e.shiftKey) {
      if (this._currentGhostCompletion(this._typedAnchor)) {
        e.preventDefault();
        this._acceptGhost();
        return;
      }
    }

    if (e.key === 'ArrowDown' && this._suggestions.length) {
      e.preventDefault();
      this._moveSelection(1);
      return;
    }

    if (e.key === 'ArrowUp' && this._suggestions.length) {
      e.preventDefault();
      this._moveSelection(-1);
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      let url;
      if (this._selectedIndex >= 0 && this._suggestions[this._selectedIndex]) {
        // A dropdown row is highlighted — navigate to it verbatim.
        url = this._suggestions[this._selectedIndex].content;
      } else {
        // No explicit row: navigate to whatever is in the input. If the inline
        // ghost is showing, input.value already holds the accepted completion.
        url = this._normalizeUrl(input.value);
      }
      if (url) {
        this.emit('navigate', { url });
        input.value = url;
        this._closeDropdown();
        input.blur();
      }
      return;
    }

    if (e.key === 'Escape') {
      // First Escape closes an open dropdown/ghost without leaving the bar.
      if (this._suggestions.length || this._ghost) {
        e.stopPropagation();
        this._closeDropdown();
        input.value = this._typedAnchor || this.url || '';
        return;
      }
      // Nothing open — restore the current URL and exit the bar.
      input.value = this.url || '';
      input.blur();
      this.emit('dismiss');
      e.stopPropagation();
      return;
    }
  }

  /**
   * Input event: the current input.value IS the user's real typed text — the
   * ghost suffix, being natively selected, was consumed by the keystroke that
   * triggered this event. Record it as the anchor and (re-)query.
   */
  _onUrlInput() {
    const input = this.inputElement;
    if (!input) return;
    this._typedAnchor = input.value;
    this._triggerSuggestions(this._typedAnchor);
  }

  _onUrlBlur() {
    // Genuine focus loss. Row clicks preventDefault their mousedown so focus
    // never departs for those; this only fires when focus truly leaves.
    this._closeDropdown();
  }

  /**
   * Debounced frecency query. The generation counter — bumped on every trigger
   * and every clear — is the correctness mechanism: an async result is applied
   * only if no newer trigger/clear happened while it was in flight.
   */
  _triggerSuggestions(text) {
    if (this._ghostTimer) {
      clearTimeout(this._ghostTimer);
      this._ghostTimer = null;
    }

    const trimmed = (text || '').trim();
    if (trimmed.length < 2) {
      this._closeDropdown();
      return;
    }

    const generation = ++this._ghostGeneration;
    this._ghostTimer = setTimeout(async () => {
      const items = await this._queryUrls(trimmed);
      if (generation !== this._ghostGeneration) return; // stale — newer input arrived
      const input = this.inputElement;
      if (!input || this.shadowRoot?.activeElement !== input) return; // no longer editing

      this._suggestions = items;
      this._selectedIndex = -1;
      const best = items[0];
      this._ghost = best ? { url: best.content, matchable: urlMatchable(best.content) } : null;
      if (this._ghost) {
        this._ghostGranularity = this._initialGranularity(this._typedAnchor);
        this._applyGhostSelection(this._typedAnchor);
      }
    }, URL_GHOST_DEBOUNCE_MS);
  }

  /**
   * Query frecency-ranked URL items whose title/domain/content contains `search`.
   * URLs only — internal peek:// items are filtered out. Falls back to a no-op
   * when neither an injected provider nor window.app.datastore is available.
   */
  async _queryUrls(search) {
    if (typeof this.urlSuggestionProvider === 'function') {
      try { return await this.urlSuggestionProvider(search); } catch { return []; }
    }
    const api = window.app;
    if (!api?.datastore?.queryItems) return [];
    try {
      const result = await api.datastore.queryItems({
        type: 'url', sortBy: 'frecency', limit: URL_SUGGEST_LIMIT + 10, search,
      });
      if (!result?.success) return [];
      return (result.data || [])
        .filter((item) => !item.content?.startsWith('peek://'))
        .slice(0, URL_SUGGEST_LIMIT);
    } catch {
      return [];
    }
  }

  /**
   * The current-granularity completion when it forward-extends `anchor` (the
   * user's real typed text), else null. Single source of truth for "is an inline
   * completion shown, and what is it?" — the substring (non-prefix) case shows
   * nothing inline (the dropdown carries it).
   */
  _currentGhostCompletion(anchor) {
    if (!this._ghost) return null;
    const c = urlCompletionAtGranularity(this._ghost.url, this._ghostGranularity);
    const t = (anchor || '').trim();
    if (c.toLowerCase().startsWith(t.toLowerCase()) && c.length > t.length) return c;
    return null;
  }

  /** First granularity whose completion forward-extends `anchor`; 'full' if none. */
  _initialGranularity(anchor) {
    if (!this._ghost) return 'host';
    const t = (anchor || '').trim();
    for (const g of URL_GRANULARITY_ORDER) {
      const c = urlCompletionAtGranularity(this._ghost.url, g);
      if (c.toLowerCase().startsWith(t.toLowerCase()) && c.length > t.length) return g;
    }
    return 'full';
  }

  /** Next stop-point whose completion is strictly longer; stays put at the last. */
  _nextGranularityBeyond(current, currentCompletion) {
    if (!this._ghost) return current;
    const idx = URL_GRANULARITY_ORDER.indexOf(current);
    for (let i = idx + 1; i < URL_GRANULARITY_ORDER.length; i++) {
      const g = URL_GRANULARITY_ORDER[i];
      const c = urlCompletionAtGranularity(this._ghost.url, g);
      if (c.length > currentCompletion.length) return g;
    }
    return current;
  }

  /**
   * Fill the native input with the current-granularity completion and NATIVELY
   * SELECT the suffix beyond `anchor`. Backspace / type-over then delete the
   * selected suffix for free. No-op when the completion isn't a forward
   * prefix-completion (the substring case shows nothing inline).
   */
  _applyGhostSelection(anchor) {
    const input = this.inputElement;
    if (!input) return;
    const completion = this._currentGhostCompletion(anchor);
    if (!completion) return;
    const t = (anchor || '').trim();
    input.value = completion;
    input.setSelectionRange(t.length, completion.length, 'backward');
  }

  /**
   * Accept/expand the ghost: advance to the next granularity stop-point
   * (host → path1 → path → full) and re-fill + re-select the longer completion.
   * The typed anchor is left untouched, so Backspace still rejects to it.
   */
  _acceptGhost() {
    if (!this._ghost) return;
    const currentCompletion = urlCompletionAtGranularity(this._ghost.url, this._ghostGranularity);
    this._ghostGranularity = this._nextGranularityBeyond(this._ghostGranularity, currentCompletion);
    this._applyGhostSelection(this._typedAnchor);
  }

  /** Move the dropdown highlight; -1 re-arms the inline ghost, >=0 collapses it. */
  _moveSelection(delta) {
    const n = this._suggestions.length;
    if (!n) return;
    let idx = this._selectedIndex + delta;
    if (idx < -1) idx = -1;
    if (idx > n - 1) idx = n - 1;
    this._selectedIndex = idx;
    const input = this.inputElement;
    if (!input) return;
    if (idx >= 0) {
      // A row is now the target: collapse the inline ghost so the input shows the
      // bare typed text and the highlighted row is the unambiguous destination.
      input.value = this._typedAnchor || '';
    } else {
      // Back out to the inline ghost.
      this._applyGhostSelection(this._typedAnchor);
    }
  }

  /** Navigate to a suggestion row (click). */
  _selectSuggestion(index) {
    const item = this._suggestions[index];
    if (!item || !item.content) return;
    const url = item.content;
    this.emit('navigate', { url });
    const input = this.inputElement;
    if (input) input.value = url;
    this._closeDropdown();
    input?.blur();
  }

  /** Keep input focus when pressing a row so the click can land before blur. */
  _onSuggestionMousedown(e) {
    e.preventDefault();
  }

  /** Clear the inline ghost + cancel any pending/in-flight query. */
  _clearGhost() {
    this._ghost = null;
    this._ghostGranularity = 'host';
    this._ghostGeneration++;
    if (this._ghostTimer) {
      clearTimeout(this._ghostTimer);
      this._ghostTimer = null;
    }
  }

  /** Close the dropdown and clear the inline ghost. */
  _closeDropdown() {
    this._suggestions = [];
    this._selectedIndex = -1;
    this._clearGhost();
  }

  /** Resolve a display title for a URL item (mirrors the cmd panel). */
  _suggestionTitle(item) {
    let title = item.title || '';
    if (!title && item.metadata) {
      try {
        const meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata;
        title = meta.title || '';
      } catch { /* ignore malformed metadata */ }
    }
    return title || item.content || 'Untitled';
  }

  /**
   * Focus the URL input and select its text
   */
  focusUrl() {
    requestAnimationFrame(() => {
      const input = this.inputElement;
      if (input) {
        input.focus();
        input.select();
      }
    });
  }

  /**
   * Update the displayed URL
   */
  setUrl(url) {
    this.url = url;
    const input = this.inputElement;
    // Don't overwrite the input if the user is actively typing in it
    const isFocused = this.shadowRoot?.activeElement === input;
    if (input && !isFocused) {
      input.value = url;
    }
  }

  _onUrlFocus() {
    requestAnimationFrame(() => {
      this.inputElement?.select();
    });
  }

  _onUrlMousedown(e) {
    e.stopPropagation();
  }

  render() {
    return html`
      <div class="navbar">
        <button
          class="nav-btn"
          ?disabled=${!this.canGoBack}
          title="Back (Cmd+[)"
          @click=${(e) => { e.stopPropagation(); this.emit('go-back'); }}
        >&#8592;</button>
        <button
          class="nav-btn"
          ?disabled=${!this.canGoForward}
          title="Forward (Cmd+])"
          @click=${(e) => { e.stopPropagation(); this.emit('go-forward'); }}
        >&#8594;</button>
        <button
          class="nav-btn"
          title="Reload (Cmd+R)"
          @click=${(e) => { e.stopPropagation(); this.emit('reload'); }}
        >&#8635;</button>
        ${this.favicon || this.pageTitle ? html`
          <div class="title-chip" title=${this.pageTitle || ''}>
            ${this.favicon ? html`<img class="title-favicon" src=${this.favicon} alt="">` : ''}
            ${this.pageTitle ? html`<span class="title-text">${this.pageTitle}</span>` : ''}
          </div>
        ` : ''}
        <div class="url-container">
          <input
            type="text"
            class="url-text"
            .value=${this.url || ''}
            spellcheck="false"
            autocomplete="off"
            @keydown=${this._onUrlKeydown}
            @input=${this._onUrlInput}
            @focus=${this._onUrlFocus}
            @blur=${this._onUrlBlur}
            @mousedown=${this._onUrlMousedown}
          >
          ${this.loading ? html`<div class="loading-spinner"></div>` : ''}
        </div>
      </div>
      ${this._suggestions.length ? html`
        <div class="url-suggestions" data-no-drag>
          ${this._suggestions.map((item, i) => html`
            <div
              class="url-suggestion ${i === this._selectedIndex ? 'selected' : ''}"
              @mousedown=${this._onSuggestionMousedown}
              @click=${() => this._selectSuggestion(i)}
            >
              ${item.favicon
                ? html`<img
                    class="url-favicon"
                    src=${item.favicon}
                    alt=""
                    @error=${(e) => { e.target.style.display = 'none'; }}
                  >`
                : html`<span class="url-favicon-placeholder"></span>`}
              <span class="url-title">${this._suggestionTitle(item)}</span>
              <span class="url-subtitle">${item.domain || item.content || ''}</span>
            </div>
          `)}
        </div>
      ` : ''}
    `;
  }
}

customElements.define('peek-navbar', PeekNavbar);
