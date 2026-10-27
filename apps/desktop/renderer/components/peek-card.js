/**
 * Peek Card Component
 *
 * A flexible card container with header, body, and footer slots.
 * Supports interactive (clickable) and static modes.
 *
 * @element peek-card
 *
 * @prop {boolean} interactive - Make card clickable/focusable
 * @prop {boolean} selected - Visual selected state
 * @prop {boolean} elevated - Add elevation shadow
 * @prop {boolean} bordered - Show border (default true)
 * @prop {boolean} glass - Apply glass-morphism effect (transparent blur)
 *
 * @slot - Default slot for card body content
 * @slot header - Card header content
 * @slot footer - Card footer content
 * @slot media - Media content (images, etc.) displayed edge-to-edge
 *
 * @csspart card - The card container
 * @csspart header - The header section
 * @csspart body - The body section
 * @csspart footer - The footer section
 * @csspart media - The media section
 *
 * @cssprop --peek-card-bg - Card background color
 * @cssprop --peek-card-border - Card border color
 * @cssprop --peek-card-radius - Card border radius
 * @cssprop --peek-card-padding - Card content padding
 * @cssprop --peek-card-gap - Gap between card sections
 *
 * @fires card-click - When interactive card is clicked
 *
 * @example
 * <peek-card>
 *   <span slot="header">Title</span>
 *   <p>Card content goes here</p>
 *   <span slot="footer">Footer text</span>
 * </peek-card>
 *
 * @example
 * <peek-card interactive elevated>
 *   <img slot="media" src="image.jpg" alt="Card image">
 *   <h3 slot="header">Clickable Card</h3>
 *   <p>Click anywhere on this card</p>
 * </peek-card>
 */

import { html, css, nothing } from 'lit';
import { PeekElement, sharedStyles } from './base.js';

export class PeekCard extends PeekElement {
  static properties = {
    interactive: { type: Boolean, reflect: true },
    selected: { type: Boolean, reflect: true },
    elevated: { type: Boolean, reflect: true },
    bordered: { type: Boolean, reflect: true },
    glass: { type: Boolean, reflect: true }
  };

  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }

      .card {
        display: flex;
        flex-direction: column;
        /* height:100% fills the host when a parent gives it a definite height
           (e.g. the virtual grid path sets height:<itemHeight>px on the host
           element). Against an auto/indefinite parent this resolves to auto,
           so it's a no-op for normal non-virtual consumers. */
        height: 100%;
        box-sizing: border-box;
        background: var(--peek-card-bg, var(--theme-bg-secondary, #fff));
        border-radius: var(--peek-card-radius, var(--peek-radius-lg));
        overflow: hidden;
        transition: box-shadow var(--peek-transition-normal),
                    border-color var(--peek-transition-normal),
                    transform var(--peek-transition-fast);
      }

      /* Bordered — only when attribute is present and not "false" */
      :host([bordered]:not([bordered="false"])) .card {
        border: var(--theme-surface-border, 1px solid var(--peek-card-border, var(--theme-border, #e0e0e0)));
        box-shadow: var(--theme-surface-ring, none);
      }

      /* Elevated */
      :host([elevated]) .card {
        box-shadow: var(--peek-shadow-md);
        border-color: transparent;
      }

      /* Selected */
      :host([selected]) .card {
        border-color: var(--theme-accent, #007aff);
        box-shadow: 0 0 0 1px var(--theme-accent, #007aff);
      }

      /* Interactive */
      :host([interactive]) .card {
        cursor: pointer;
      }

      :host([interactive]) .card:hover {
        border-color: var(--theme-accent, #007aff);
      }

      :host([interactive][elevated]) .card:hover {
        box-shadow: var(--peek-shadow-lg);
        transform: translateY(-1px);
      }

      :host([interactive]) .card:active {
        transform: scale(0.99);
      }

      :host([interactive]) .card:focus-visible {
        outline: none;
        box-shadow: var(--peek-focus-ring);
      }

      /* Glass-morphism */
      :host([glass]) .card {
        background: var(--peek-glass-bg);
        backdrop-filter: blur(var(--peek-glass-blur));
        -webkit-backdrop-filter: blur(var(--peek-glass-blur));
        border-color: var(--peek-glass-border);
        color: var(--peek-glass-text);
      }

      :host([glass]) .header {
        color: var(--peek-glass-text);
      }

      :host([glass]) .body {
        color: var(--peek-glass-text-secondary);
      }

      :host([glass]) .footer {
        color: var(--peek-glass-text-muted);
        border-top-color: var(--peek-glass-border);
      }

      :host([glass][interactive]) .card:hover {
        background: var(--peek-glass-bg-hover);
        border-color: var(--peek-glass-border-hover);
        transform: translateY(-2px);
        box-shadow: var(--peek-glass-shadow);
      }

      :host([glass][selected]) .card {
        background: var(--peek-glass-bg-active);
        border-color: var(--theme-accent, #007aff);
        box-shadow: 0 0 0 2px var(--theme-accent, #007aff);
      }

      :host([glass][selected]) .card:hover {
        background: rgba(255, 255, 255, 0.25);
      }

      :host([glass][interactive]) .card:active {
        transform: scale(0.99);
      }

      /* Sections */
      .header {
        padding: var(--peek-card-padding, var(--peek-space-lg));
        padding-bottom: 0;
        font-weight: var(--peek-font-semibold);
        font-size: var(--peek-font-lg);
        color: var(--theme-text, #333);
      }

      .header.slot-empty {
        display: none;
      }

      .body {
        padding: var(--peek-card-padding, var(--peek-space-lg));
        flex: 1;
        color: var(--theme-text-secondary, #666);
        font-size: var(--peek-font-md);
        line-height: var(--peek-leading-normal);
      }

      .body.slot-empty {
        display: none;
      }

      /* Adjust body padding when header exists */
      .header + .body {
        padding-top: var(--peek-card-gap, var(--peek-space-md));
      }

      .footer {
        padding: var(--peek-card-padding, var(--peek-space-lg));
        padding-top: 0;
        margin-top: auto;
        padding-top: var(--peek-card-gap, var(--peek-space-md));
        font-size: var(--peek-font-sm);
        color: var(--theme-text-muted, #999);
      }

      .footer.slot-empty {
        display: none;
      }

      .media {
        margin: 0;
        line-height: 0;
      }

      .media.slot-empty {
        display: none;
      }

      ::slotted([slot="media"]) {
        width: 100%;
        height: auto;
        display: block;
      }

      /* Media at top - no top radius padding needed */
      .media:first-child ::slotted([slot="media"]) {
        border-radius: var(--peek-card-radius, var(--peek-radius-lg))
                       var(--peek-card-radius, var(--peek-radius-lg))
                       0 0;
      }
    `
  ];

  constructor() {
    super();
    this.interactive = false;
    this.selected = false;
    this.elevated = false;
    this.bordered = true;
    this.glass = false;
  }

  render() {
    return html`
      <div
        part="card"
        class="card"
        role=${this.interactive ? 'button' : nothing}
        tabindex=${this.interactive ? '0' : nothing}
        @click=${this._handleClick}
        @keydown=${this._handleKeydown}
      >
        <div part="media" class="media">
          <slot name="media"></slot>
        </div>
        <div part="header" class="header">
          <slot name="header"></slot>
        </div>
        <div part="body" class="body">
          <slot></slot>
        </div>
        <div part="footer" class="footer">
          <slot name="footer"></slot>
        </div>
      </div>
    `;
  }

  firstUpdated() {
    // Hide sections whose slots have no assigned content
    for (const slot of this.shadowRoot.querySelectorAll('slot')) {
      this._updateSlotEmpty(slot);
      slot.addEventListener('slotchange', () => this._updateSlotEmpty(slot));
    }
  }

  _updateSlotEmpty(slot) {
    const wrapper = slot.parentElement;
    if (!wrapper) return;
    const hasContent = slot.assignedNodes({ flatten: true }).some(
      n => n.nodeType === Node.ELEMENT_NODE || (n.nodeType === Node.TEXT_NODE && n.textContent.trim())
    );
    wrapper.classList.toggle('slot-empty', !hasContent);
  }

  _handleClick(e) {
    if (this.interactive) {
      this.emit('card-click', { originalEvent: e });
    }
  }

  _handleKeydown(e) {
    if (this.interactive && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      this.emit('card-click', { originalEvent: e });
    }
  }

  /**
   * Focus the card (only works when interactive).
   * Waits for first render if shadow DOM isn't ready yet.
   */
  async focus() {
    if (!this.interactive) return;
    const inner = this.shadowRoot?.querySelector('.card');
    if (inner) {
      inner.focus();
    } else {
      await this.updateComplete;
      this.shadowRoot?.querySelector('.card')?.focus();
    }
  }

  /**
   * Programmatic click — delegates to the inner .card div so the
   * @click handler fires and emits card-click.
   */
  click() {
    const inner = this.shadowRoot?.querySelector('.card');
    if (inner) {
      inner.click();
    }
  }
}

customElements.define('peek-card', PeekCard);

export default PeekCard;
