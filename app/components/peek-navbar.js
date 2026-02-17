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

export class PeekNavbar extends PeekElement {
  static properties = {
    url: { type: String },
    canGoBack: { type: Boolean, attribute: 'can-go-back' },
    canGoForward: { type: Boolean, attribute: 'can-go-forward' },
    visible: { type: Boolean, reflect: true },
    /** When true, component registers its own document-level keyboard shortcuts
     * (Cmd+L, Cmd+R, Cmd+[, Cmd+]). Set to false if the host manages these. */
    shortcuts: { type: Boolean },
  };

  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
        height: var(--peek-navbar-height, 36px);
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
    `
  ];

  constructor() {
    super();
    this.url = '';
    this.canGoBack = false;
    this.canGoForward = false;
    this.visible = false;
    this.shortcuts = true;
    this._handleKeydown = this._handleKeydown.bind(this);
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
   * Normalize a URL input, adding https:// if needed
   */
  _normalizeUrl(input) {
    const trimmed = input.trim();
    if (!trimmed) return null;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (trimmed.includes('.') && !trimmed.includes(' ')) return 'https://' + trimmed;
    return 'https://' + trimmed;
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
   * Handle keydown in the URL input field
   */
  _onUrlKeydown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const input = this.inputElement;
      const url = this._normalizeUrl(input.value);
      if (url) {
        this.emit('navigate', { url });
        input.value = url;
        input.blur();
      }
    }
    if (e.key === 'Escape') {
      const input = this.inputElement;
      input.value = this.url || '';
      input.blur();
      this.emit('dismiss');
      e.stopPropagation();
    }
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
        <input
          type="text"
          class="url-text"
          .value=${this.url || ''}
          spellcheck="false"
          autocomplete="off"
          @keydown=${this._onUrlKeydown}
          @focus=${this._onUrlFocus}
          @mousedown=${this._onUrlMousedown}
        >
      </div>
    `;
  }
}

customElements.define('peek-navbar', PeekNavbar);
