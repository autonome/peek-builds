/**
 * Outline Sidebar - displays markdown header hierarchy.
 * Clicking a header jumps to that location in the editor.
 * Collapsing/expanding a section syncs with document folds.
 */

import { foldEffect, unfoldEffect, foldedRanges, foldable } from '@codemirror/language';

/**
 * Parse markdown text and extract headers with their positions.
 * @param {string} text - Markdown text
 * @returns {Array<{level: number, text: string, line: number, offset: number}>}
 */
export function parseHeaders(text) {
  const headers = [];
  const lines = text.split('\n');
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^(#{1,6})\s+(.+)$/);

    if (match) {
      headers.push({
        level: match[1].length,
        text: match[2].trim(),
        line: i + 1,
        offset: offset,
      });
    }

    offset += line.length + 1; // +1 for newline
  }

  return headers;
}

/**
 * Determine which headers are parents (have children at a deeper level).
 * @param {Array} headers - Parsed headers
 * @returns {Set<number>} - Set of header indices that are parents
 */
function findParentHeaders(headers) {
  const parents = new Set();
  for (let i = 0; i < headers.length; i++) {
    for (let j = i + 1; j < headers.length; j++) {
      if (headers[j].level <= headers[i].level) break;
      // j is a child of i
      parents.add(i);
      break;
    }
  }
  return parents;
}

/**
 * Get the range of child header indices for a parent header.
 * @param {Array} headers - Parsed headers
 * @param {number} parentIdx - Index of the parent header
 * @returns {Array<number>} - Indices of all descendant headers
 */
function getChildIndices(headers, parentIdx) {
  const parentLevel = headers[parentIdx].level;
  const children = [];
  for (let i = parentIdx + 1; i < headers.length; i++) {
    if (headers[i].level <= parentLevel) break;
    children.push(i);
  }
  return children;
}

export class OutlineSidebar {
  constructor(options) {
    this.container = options.container;
    this.onHeaderClick = options.onHeaderClick;
    this.onFoldToggle = options.onFoldToggle; // callback: (header, shouldFold) => void
    this.collapsed = false;
    this.headers = [];
    this.parentSet = new Set();
    this.collapsedSections = new Set(); // Set of header indices that are collapsed in outline
    this.itemElements = []; // DOM elements for each header, indexed by header index

    // Create sidebar element
    this.element = document.createElement('div');
    this.element.className = 'outline-sidebar';

    // Header with title and collapse button
    this.header = document.createElement('div');
    this.header.className = 'sidebar-header';

    const title = document.createElement('span');
    title.className = 'sidebar-title';
    title.textContent = 'Outline';
    this.header.appendChild(title);

    this.toggleBtn = document.createElement('button');
    this.toggleBtn.className = 'sidebar-toggle';
    this.toggleBtn.innerHTML = '\u25C0'; // ◀
    this.toggleBtn.tabIndex = -1;
    this.toggleBtn.addEventListener('mousedown', (e) => e.preventDefault());
    this.toggleBtn.addEventListener('click', () => this.toggle());
    this.header.appendChild(this.toggleBtn);

    this.element.appendChild(this.header);

    // Content area for header list
    this.content = document.createElement('div');
    this.content.className = 'sidebar-content';
    this.element.appendChild(this.content);

    this.container.appendChild(this.element);
  }

  /**
   * Update the outline with new headers.
   * @param {string} text - Markdown text
   */
  update(text) {
    this.headers = parseHeaders(text);
    this.parentSet = findParentHeaders(this.headers);

    // Prune collapsed sections that no longer exist
    const validCollapsed = new Set();
    for (const idx of this.collapsedSections) {
      if (idx < this.headers.length && this.parentSet.has(idx)) {
        validCollapsed.add(idx);
      }
    }
    this.collapsedSections = validCollapsed;

    this.render();
  }

  /**
   * Render the outline items.
   */
  render() {
    this.content.innerHTML = '';
    this.itemElements = [];

    if (this.headers.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'outline-empty';
      empty.textContent = 'No headers found';
      this.content.appendChild(empty);
      return;
    }

    // Level indicator colors using theme variables
    const levelColors = [
      'var(--base0A)', 'var(--base0B)', 'var(--base09)',
      'var(--base0D)', 'var(--base0E)', 'var(--base0C)'
    ];

    // Determine which items are hidden due to a collapsed ancestor
    const hiddenSet = this._computeHiddenSet();

    for (let i = 0; i < this.headers.length; i++) {
      const header = this.headers[i];
      const isParent = this.parentSet.has(i);
      const isSectionCollapsed = this.collapsedSections.has(i);
      const isHidden = hiddenSet.has(i);

      const item = document.createElement('div');
      item.className = 'outline-item';
      if (isHidden) {
        item.style.display = 'none';
      }
      item.style.paddingLeft = `${(header.level - 1) * 12}px`;

      // Collapse toggle for parent items
      if (isParent) {
        const toggle = document.createElement('span');
        toggle.className = 'outline-fold-toggle';
        toggle.innerHTML = isSectionCollapsed ? '\u25B6' : '\u25BC'; // ▶ or ▼
        toggle.title = isSectionCollapsed ? 'Expand section' : 'Collapse section';
        toggle.addEventListener('mousedown', (e) => e.preventDefault());
        toggle.addEventListener('click', (e) => {
          e.stopPropagation();
          this._toggleSection(i);
        });
        item.appendChild(toggle);
      } else {
        // Spacer to keep alignment
        const spacer = document.createElement('span');
        spacer.className = 'outline-fold-spacer';
        item.appendChild(spacer);
      }

      // Level indicator dot
      const indicator = document.createElement('span');
      indicator.className = 'outline-indicator';
      indicator.style.background = levelColors[(header.level - 1) % levelColors.length];
      item.appendChild(indicator);

      const text = document.createElement('span');
      text.className = 'outline-item-text';
      text.textContent = header.text;
      item.appendChild(text);

      item.addEventListener('mousedown', (e) => e.preventDefault());
      item.addEventListener('click', () => {
        if (this.onHeaderClick) {
          this.onHeaderClick(header);
        }
      });

      this.content.appendChild(item);
      this.itemElements[i] = item;
    }
  }

  /**
   * Compute which header indices are hidden because an ancestor is collapsed.
   */
  _computeHiddenSet() {
    const hidden = new Set();
    for (const collapsedIdx of this.collapsedSections) {
      const children = getChildIndices(this.headers, collapsedIdx);
      for (const childIdx of children) {
        hidden.add(childIdx);
      }
    }
    return hidden;
  }

  /**
   * Toggle collapse state of a section in the outline.
   * @param {number} headerIdx - Index of the header in this.headers
   */
  _toggleSection(headerIdx) {
    const shouldCollapse = !this.collapsedSections.has(headerIdx);

    if (shouldCollapse) {
      this.collapsedSections.add(headerIdx);
    } else {
      this.collapsedSections.delete(headerIdx);
    }

    // Update the DOM
    this.render();

    // Notify the editor to fold/unfold
    if (this.onFoldToggle) {
      this.onFoldToggle(this.headers[headerIdx], shouldCollapse);
    }
  }

  /**
   * Sync outline collapse state from the editor's fold state.
   * Called when folds change in the document.
   * @param {EditorView} view - CodeMirror EditorView
   */
  syncFromEditor(view) {
    if (!view || this.headers.length === 0) return;

    const state = view.state;
    const folded = foldedRanges(state);
    let changed = false;

    for (let i = 0; i < this.headers.length; i++) {
      if (!this.parentSet.has(i)) continue;

      const header = this.headers[i];
      // Find the line in the current document
      if (header.offset >= state.doc.length) continue;

      const line = state.doc.lineAt(header.offset);
      // Check if there's a fold starting at the end of this header line
      const foldRange = foldable(state, line.from, line.to);
      if (!foldRange) continue;

      let isFolded = false;
      folded.between(foldRange.from, foldRange.to, (from, to) => {
        if (from === foldRange.from) {
          isFolded = true;
        }
      });

      const wasCollapsed = this.collapsedSections.has(i);
      if (isFolded && !wasCollapsed) {
        this.collapsedSections.add(i);
        changed = true;
      } else if (!isFolded && wasCollapsed) {
        this.collapsedSections.delete(i);
        changed = true;
      }
    }

    if (changed) {
      this.render();
    }
  }

  /**
   * Toggle sidebar collapsed state.
   */
  toggle() {
    this.collapsed = !this.collapsed;
    this.element.classList.toggle('collapsed', this.collapsed);

    if (this.collapsed) {
      this.toggleBtn.innerHTML = '\u2261'; // ≡
      this.toggleBtn.title = 'Show Outline';
    } else {
      this.toggleBtn.innerHTML = '\u25C0'; // ◀
      this.toggleBtn.title = 'Hide Outline';
    }
  }

  /**
   * Check if sidebar is collapsed.
   */
  isCollapsed() {
    return this.collapsed;
  }

  /**
   * Get the sidebar element.
   */
  getElement() {
    return this.element;
  }

  /**
   * Destroy the sidebar.
   */
  destroy() {
    this.element.remove();
  }
}
