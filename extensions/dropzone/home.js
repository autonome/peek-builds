// Drop Zone - diagnostic inspector for dropped content

const dropzone = document.getElementById('dropzone');
const results = document.getElementById('results');
const clearBtn = document.getElementById('clear-btn');
let dropCounter = 0;

// Drag and drop event handlers
dropzone.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dropzone.classList.add('drag-over');
});

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('drag-over');
});

dropzone.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (!dropzone.contains(e.relatedTarget)) {
    dropzone.classList.remove('drag-over');
  }
});

dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  handleDrop(e.dataTransfer);
});

// Clear button
clearBtn.addEventListener('click', () => {
  results.innerHTML = '';
  dropCounter = 0;
  clearBtn.style.display = 'none';
  dropzone.classList.remove('has-results');
});

// Main drop handler
function handleDrop(dt) {
  dropCounter++;
  clearBtn.style.display = '';
  dropzone.classList.add('has-results');

  const card = document.createElement('div');
  card.className = 'inspection-card';

  const now = new Date();
  const timestamp = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    + '.' + String(now.getMilliseconds()).padStart(3, '0');

  card.innerHTML = `
    <div class="card-header">
      <span class="card-timestamp">${timestamp}</span>
      <span class="card-drop-id">Drop #${dropCounter}</span>
    </div>
    <div class="card-body"></div>
  `;

  const body = card.querySelector('.card-body');

  // 1. DataTransfer types
  addTypesSection(body, dt);

  // 2. DataTransfer items
  addItemsSection(body, dt);

  // 3. Files
  if (dt.files && dt.files.length > 0) {
    addFilesSection(body, dt);
  }

  // 4. Content for each type
  const typeData = {};
  for (const type of dt.types) {
    try {
      typeData[type] = dt.getData(type);
    } catch (err) {
      typeData[type] = `[Error reading: ${err.message}]`;
    }
  }

  // Text analysis
  if (typeData['text/plain']) {
    addTextSection(body, typeData['text/plain']);
  }

  // URL analysis
  if (typeData['text/uri-list']) {
    addUrlSection(body, typeData['text/uri-list']);
  } else if (typeData['text/plain'] && looksLikeUrl(typeData['text/plain'])) {
    addUrlSection(body, typeData['text/plain']);
  }

  // HTML analysis
  if (typeData['text/html']) {
    addHtmlSection(body, typeData['text/html']);
  }

  // JSON analysis
  if (typeData['text/plain']) {
    try {
      const parsed = JSON.parse(typeData['text/plain']);
      addJsonSection(body, parsed);
    } catch (_) {
      // Not JSON, that's fine
    }
  }

  // Image files
  if (dt.files) {
    for (const file of dt.files) {
      if (file.type.startsWith('image/')) {
        addImageSection(body, file);
      }
    }
  }

  // Raw data for all types
  addRawDataSection(body, typeData);

  // Insert newest on top
  results.prepend(card);
}

// Section builders

function addTypesSection(body, dt) {
  const types = Array.from(dt.types);
  const section = createSection('Types', types.length);
  const content = section.querySelector('.section-content');

  const pills = document.createElement('div');
  pills.className = 'type-pills';
  types.forEach(t => {
    const pill = document.createElement('span');
    pill.className = 'type-pill';
    pill.textContent = t;
    pills.appendChild(pill);
  });
  content.appendChild(pills);

  body.appendChild(section);
}

function addItemsSection(body, dt) {
  if (!dt.items || dt.items.length === 0) return;

  const section = createSection('DataTransfer Items', dt.items.length);
  const content = section.querySelector('.section-content');

  for (let i = 0; i < dt.items.length; i++) {
    const item = dt.items[i];
    const row = document.createElement('div');
    row.className = 'data-row';
    row.innerHTML = `
      <span class="data-label">[${i}]</span>
      <span class="data-value"><span class="data-value type">${esc(item.kind)}</span> / <span class="data-value type">${esc(item.type)}</span></span>
    `;
    content.appendChild(row);
  }

  body.appendChild(section);
}

function addFilesSection(body, dt) {
  const section = createSection('Files', dt.files.length);
  const content = section.querySelector('.section-content');

  for (const file of dt.files) {
    const row = document.createElement('div');
    row.style.marginBottom = '6px';

    const ext = file.name.includes('.') ? file.name.split('.').pop() : '(none)';

    row.innerHTML = `
      <div class="data-row">
        <span class="data-label">Name</span>
        <span class="data-value">${esc(file.name)}</span>
      </div>
      <div class="data-row">
        <span class="data-label">MIME</span>
        <span class="data-value type">${esc(file.type || '(empty)')}</span>
      </div>
      <div class="data-row">
        <span class="data-label">Extension</span>
        <span class="data-value">${esc(ext)}</span>
      </div>
      <div class="data-row">
        <span class="data-label">Size</span>
        <span class="data-value number">${formatBytes(file.size)}</span>
      </div>
      <div class="data-row">
        <span class="data-label">Modified</span>
        <span class="data-value">${new Date(file.lastModified).toLocaleString()}</span>
      </div>
    `;
    content.appendChild(row);
  }

  body.appendChild(section);
}

function addTextSection(body, text) {
  const section = createSection('Text Content', null);
  const content = section.querySelector('.section-content');

  const chars = text.length;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const lines = text.split('\n').length;

  const stats = document.createElement('div');
  stats.className = 'text-stats';
  stats.innerHTML = `
    <span class="text-stat"><span class="text-stat-value">${chars.toLocaleString()}</span> chars</span>
    <span class="text-stat"><span class="text-stat-value">${words.toLocaleString()}</span> words</span>
    <span class="text-stat"><span class="text-stat-value">${lines.toLocaleString()}</span> lines</span>
  `;
  content.appendChild(stats);

  const pre = document.createElement('pre');
  pre.className = 'raw-block';
  pre.textContent = text.length > 5000 ? text.slice(0, 5000) + '\n... (truncated)' : text;
  content.appendChild(pre);

  body.appendChild(section);
}

function addUrlSection(body, urlStr) {
  const urls = urlStr.trim().split('\n').filter(u => u && !u.startsWith('#'));
  const section = createSection('URL Analysis', urls.length > 1 ? urls.length : null);
  const content = section.querySelector('.section-content');

  for (const raw of urls) {
    try {
      const url = new URL(raw.trim());
      const comp = document.createElement('div');
      comp.className = 'url-components';

      const parts = [
        ['href', url.href],
        ['protocol', url.protocol],
        ['host', url.host],
        ['pathname', url.pathname],
      ];
      if (url.search) parts.push(['search', url.search]);
      if (url.hash) parts.push(['hash', url.hash]);
      if (url.username) parts.push(['username', url.username]);
      if (url.port) parts.push(['port', url.port]);

      // Parse search params
      if (url.searchParams && Array.from(url.searchParams).length > 0) {
        parts.push(['--- params ---', '']);
        for (const [k, v] of url.searchParams) {
          parts.push([k, v]);
        }
      }

      comp.innerHTML = parts.map(([label, value]) =>
        `<div class="url-component">
          <span class="url-component-label">${esc(label)}</span>
          <span class="url-component-value">${esc(value)}</span>
        </div>`
      ).join('');

      content.appendChild(comp);
    } catch (_) {
      const row = document.createElement('div');
      row.className = 'data-row';
      row.innerHTML = `<span class="data-value url">${esc(raw)}</span> <span class="data-value type">(not a valid URL)</span>`;
      content.appendChild(row);
    }
  }

  body.appendChild(section);
}

function addHtmlSection(body, html) {
  const section = createSection('HTML Content', null);
  const content = section.querySelector('.section-content');

  // Raw HTML
  const rawLabel = document.createElement('div');
  rawLabel.className = 'data-label';
  rawLabel.textContent = 'Raw HTML';
  rawLabel.style.marginBottom = '2px';
  content.appendChild(rawLabel);

  const pre = document.createElement('pre');
  pre.className = 'raw-block';
  pre.textContent = html.length > 5000 ? html.slice(0, 5000) + '\n... (truncated)' : html;
  content.appendChild(pre);

  // Rendered preview
  const previewLabel = document.createElement('div');
  previewLabel.className = 'data-label';
  previewLabel.textContent = 'Rendered Preview';
  previewLabel.style.marginTop = '8px';
  previewLabel.style.marginBottom = '2px';
  content.appendChild(previewLabel);

  const preview = document.createElement('div');
  preview.className = 'html-preview';
  // Sanitize: strip scripts
  const sanitized = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  preview.innerHTML = sanitized;
  content.appendChild(preview);

  body.appendChild(section);
}

function addJsonSection(body, parsed) {
  const section = createSection('JSON', null);
  const content = section.querySelector('.section-content');

  const pre = document.createElement('pre');
  pre.className = 'raw-block';
  pre.innerHTML = syntaxHighlightJson(JSON.stringify(parsed, null, 2));
  content.appendChild(pre);

  body.appendChild(section);
}

function addImageSection(body, file) {
  const section = createSection(`Image: ${file.name}`, null);
  const content = section.querySelector('.section-content');

  const container = document.createElement('div');
  container.className = 'image-preview';

  const img = document.createElement('img');
  const url = URL.createObjectURL(file);
  img.src = url;
  img.onload = () => {
    const dims = document.createElement('div');
    dims.className = 'data-row';
    dims.style.marginTop = '4px';
    dims.innerHTML = `
      <span class="data-label">Dimensions</span>
      <span class="data-value number">${img.naturalWidth} x ${img.naturalHeight} px</span>
    `;
    content.appendChild(dims);
  };
  container.appendChild(img);
  content.appendChild(container);

  body.appendChild(section);
}

function addRawDataSection(body, typeData) {
  const entries = Object.entries(typeData);
  if (entries.length === 0) return;

  const section = createSection('Raw Data (all types)', entries.length, true);
  const content = section.querySelector('.section-content');

  for (const [type, data] of entries) {
    const typeLabel = document.createElement('div');
    typeLabel.className = 'data-label';
    typeLabel.style.marginTop = '6px';
    typeLabel.style.marginBottom = '2px';
    typeLabel.innerHTML = `<span class="type-pill">${esc(type)}</span>`;
    content.appendChild(typeLabel);

    const pre = document.createElement('pre');
    pre.className = 'raw-block';
    pre.textContent = data.length > 3000 ? data.slice(0, 3000) + '\n... (truncated)' : data;
    content.appendChild(pre);
  }

  body.appendChild(section);
}

// Helpers

function createSection(title, badge, startCollapsed) {
  const section = document.createElement('div');
  section.className = 'section';

  const badgeHtml = badge != null ? `<span class="section-badge">${badge}</span>` : '';
  const collapsedClass = startCollapsed ? ' collapsed' : '';
  const hiddenClass = startCollapsed ? ' hidden' : '';

  section.innerHTML = `
    <div class="section-header">
      <span class="section-toggle${collapsedClass}">&#9660;</span>
      <span class="section-title">${esc(title)}</span>
      ${badgeHtml}
    </div>
    <div class="section-content${hiddenClass}"></div>
  `;

  const header = section.querySelector('.section-header');
  const toggle = section.querySelector('.section-toggle');
  const content = section.querySelector('.section-content');

  header.addEventListener('click', () => {
    toggle.classList.toggle('collapsed');
    content.classList.toggle('hidden');
  });

  return section;
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = String(str);
  return d.innerHTML;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return val.toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

function looksLikeUrl(str) {
  return /^https?:\/\//i.test(str.trim());
}

function syntaxHighlightJson(json) {
  return esc(json).replace(
    /("(?:\\.|[^"\\])*")\s*:/g,
    '<span class="json-key">$1</span>:'
  ).replace(
    /:\s*("(?:\\.|[^"\\])*")/g,
    ': <span class="json-string">$1</span>'
  ).replace(
    /:\s*(\d+\.?\d*)/g,
    ': <span class="json-number">$1</span>'
  ).replace(
    /:\s*(true|false)/g,
    ': <span class="json-bool">$1</span>'
  ).replace(
    /:\s*(null)/g,
    ': <span class="json-null">$1</span>'
  );
}
