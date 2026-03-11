/**
 * Preview Sidebar - renders markdown content as HTML.
 */

/**
 * Escape HTML special characters.
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Resolve a potentially relative image src to an absolute path.
 * Returns null if the src should be blocked (unsafe protocol).
 * @param {string} src - The image src attribute value
 * @param {string} [basePath] - Base directory for resolving relative paths
 * @returns {string|null} - Resolved src or null if blocked
 */
function resolveImgSrc(src, basePath) {
  // Allow https:// and data:image/ always
  if (/^(https:\/\/|data:image\/)/i.test(src)) return src;

  // Allow file:// protocol for local files
  if (/^file:\/\//i.test(src)) return src;

  // Block dangerous protocols explicitly
  if (/^javascript:/i.test(src.replace(/\s/g, ''))) return null;

  // Block http:// (non-secure)
  if (/^http:\/\//i.test(src)) return null;

  // Block any other explicit protocol (e.g., ftp://, blob:, vbscript:, etc.)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/i.test(src)) return null;

  // Relative path — resolve against basePath if available
  if (basePath) {
    // Normalize: remove trailing slash from basePath
    const base = basePath.replace(/\/+$/, '');
    let resolved;
    if (src.startsWith('/')) {
      // Absolute path on filesystem
      resolved = src;
    } else {
      resolved = base + '/' + src;
    }
    // Normalize path segments (resolve . and ..)
    const parts = resolved.split('/');
    const normalized = [];
    for (const part of parts) {
      if (part === '.' || part === '') continue;
      if (part === '..') {
        normalized.pop();
      } else {
        normalized.push(part);
      }
    }
    // Reconstruct as absolute path (starts with /)
    const normalizedPath = '/' + normalized.join('/');
    // Use peek://local-file/ instead of file:// so images load from the
    // peek:// origin without cross-origin restrictions (webSecurity: true).
    return 'peek://local-file' + normalizedPath;
  }

  // No basePath — can't resolve relative paths, block them
  return null;
}

/**
 * Restore safe HTML img tags that were escaped by escapeHtml().
 * Allows src with https://, data:image/, and file:// protocols.
 * Resolves relative paths against basePath when provided.
 * Permits alt, width, height, title, loading, and style attributes.
 * @param {string} html - HTML-escaped string
 * @param {string} [basePath] - Base directory for resolving relative image paths
 * @returns {string}
 */
function restoreImgTags(html, basePath) {
  // Match escaped <img ... > or <img ... />
  return html.replace(
    /&lt;img\s+((?:(?!&gt;).)+?)\/?\s*&gt;/gi,
    (match, attrs) => {
      // Unescape the attributes portion so we can parse them
      const unescaped = attrs
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
      const allowed = ['src', 'alt', 'width', 'height', 'title', 'loading', 'style'];
      const result = [];
      // Match attribute="value", attribute='value', or attribute=value
      const attrRegex = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
      let m;
      while ((m = attrRegex.exec(unescaped)) !== null) {
        const name = m[1].toLowerCase();
        const value = m[2] ?? m[3] ?? m[4];
        if (!allowed.includes(name)) continue;
        if (name === 'src') {
          const resolved = resolveImgSrc(value, basePath);
          if (!resolved) continue;
          const safeValue = resolved.replace(/"/g, '&quot;');
          result.push(`${name}="${safeValue}"`);
          continue;
        }
        // Sanitize value — escape quotes to prevent attribute injection
        const safeValue = value.replace(/"/g, '&quot;');
        result.push(`${name}="${safeValue}"`);
      }
      // Must have a src to render
      if (!result.find(a => a.startsWith('src='))) return match;
      // Add max-width for responsive images
      if (!result.find(a => a.startsWith('style='))) {
        result.push('style="max-width:100%"');
      }
      return `<img ${result.join(' ')}>`;
    }
  );
}

/**
 * Resolve a markdown image src, applying the same protocol/path rules as HTML img tags.
 * @param {string} src - The image src from markdown ![alt](src)
 * @param {string} [basePath] - Base directory for resolving relative paths
 * @returns {string} - Resolved src (original if allowed, resolved if relative, empty if blocked)
 */
function resolveMarkdownImgSrc(src, basePath) {
  const resolved = resolveImgSrc(src, basePath);
  return resolved || '';
}

/**
 * Simple markdown renderer.
 * Supports: headers, bold, italic, code, links, lists, blockquotes, hr, HTML img tags.
 * @param {string} text - Markdown text
 * @param {object} [options] - Render options
 * @param {string} [options.basePath] - Base directory for resolving relative image paths
 * @returns {string} - HTML string
 */
export function renderMarkdown(text, options) {
  const basePath = options?.basePath;
  let html = escapeHtml(text);

  // Restore safe HTML img tags (before other transformations)
  html = restoreImgTags(html, basePath);

  // Code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code class="language-${lang}">${code.trim()}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Headers
  html = html.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
  html = html.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold and italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/___(.+?)___/g, '<strong><em>$1</em></strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');

  // Images — resolve src against basePath
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
    const resolved = resolveMarkdownImgSrc(src, basePath);
    if (!resolved) return `![${alt}](${src})`; // leave as text if blocked
    return `<img src="${resolved}" alt="${alt}" style="max-width:100%">`;
  });

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

  // Horizontal rule
  html = html.replace(/^(---|\*\*\*|___)$/gm, '<hr>');

  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Unordered lists
  html = html.replace(/^[-*+] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

  // Ordered lists
  html = html.replace(/^\d+[.)] (.+)$/gm, '<li>$1</li>');

  // Paragraphs (lines that aren't already wrapped)
  const lines = html.split('\n');
  const result = [];
  let inParagraph = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isBlock = /^<(h[1-6]|pre|ul|ol|li|blockquote|hr|img)/.test(line);
    const isEmpty = line.trim() === '';

    if (isBlock) {
      if (inParagraph) {
        result.push('</p>');
        inParagraph = false;
      }
      result.push(line);
    } else if (isEmpty) {
      if (inParagraph) {
        result.push('</p>');
        inParagraph = false;
      }
    } else {
      if (!inParagraph) {
        result.push('<p>');
        inParagraph = true;
      }
      result.push(line);
    }
  }

  if (inParagraph) {
    result.push('</p>');
  }

  return result.join('\n');
}

export class PreviewSidebar {
  constructor(options) {
    this.container = options.container;
    this.onToggle = options.onToggle; // callback: () => void — layout handles state
    this.collapsed = false;
    this.basePath = null; // Base directory for resolving relative image paths

    // Create sidebar element
    this.element = document.createElement('div');
    this.element.className = 'preview-sidebar';

    // Header with title and collapse button
    this.header = document.createElement('div');
    this.header.className = 'sidebar-header';

    const title = document.createElement('span');
    title.className = 'sidebar-title';
    title.textContent = 'Preview';
    this.header.appendChild(title);

    // Collapsed pane icon (visible only when collapsed)
    this.collapsedIcon = document.createElement('span');
    this.collapsedIcon.className = 'pane-collapsed-icon';
    this.collapsedIcon.textContent = '\u25CE'; // eye-like icon
    this.collapsedIcon.title = 'Show Preview';
    this.collapsedIcon.addEventListener('click', () => this.toggle());
    this.header.appendChild(this.collapsedIcon);

    this.toggleBtn = document.createElement('button');
    this.toggleBtn.className = 'sidebar-toggle';
    this.toggleBtn.innerHTML = '\u25B6'; // collapse icon
    this.toggleBtn.title = 'Hide Preview';
    this.toggleBtn.tabIndex = -1;
    this.toggleBtn.addEventListener('mousedown', (e) => e.preventDefault());
    this.toggleBtn.addEventListener('click', () => this.toggle());
    this.header.appendChild(this.toggleBtn);

    this.element.appendChild(this.header);

    // Content area for rendered preview
    this.content = document.createElement('div');
    this.content.className = 'preview-content';
    this.element.appendChild(this.content);

    this.container.appendChild(this.element);
  }

  /**
   * Set the base path for resolving relative image paths.
   * Should be the directory containing the file being edited.
   * @param {string|null} basePath
   */
  setBasePath(basePath) {
    this.basePath = basePath;
  }

  /**
   * Update the preview with new markdown content.
   * @param {string} markdown
   */
  update(markdown) {
    const options = this.basePath ? { basePath: this.basePath } : undefined;
    this.content.innerHTML = renderMarkdown(markdown, options);
  }

  /**
   * Set collapsed visual state. Called by layout — sidebar does NOT own this state.
   */
  setCollapsed(collapsed) {
    this.collapsed = collapsed;
    this.element.classList.toggle('collapsed', collapsed);
    // Toggle button and collapsed icon visibility handled by CSS .collapsed class
  }

  /**
   * Toggle sidebar collapsed state (for internal toggle button click).
   */
  toggle() {
    if (this.onToggle) {
      this.onToggle();
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
   * Get the content element (for scroll sync).
   */
  getContentElement() {
    return this.content;
  }

  /**
   * Destroy the sidebar.
   */
  destroy() {
    this.element.remove();
  }
}
