# Content Scripts and Userscripts System Design

Comprehensive design for a Greasemonkey/Tampermonkey-compatible content scripts system for Peek, inspired by [quoid/userscripts](https://github.com/quoid/userscripts) Safari extension.

**Last Updated:** 2026-02-09
**Status:** Design/Planning Phase
**Agent:** a9b4e5d

---

## 1. Executive Summary

This document outlines a **content scripts/userscripts system** for Peek that enables users to write, manage, and execute JavaScript against web pages. The system combines:

1. **Metadata-driven execution** (Greasemonkey/Tampermonkey pattern)
2. **Integrated development environment** (editor extension integration)
3. **Datastore persistence** (consistent with Peek architecture)
4. **Dual execution modes** (Peek pages + web pages)
5. **Rich UI** (scripts list, code editor, live preview)

### Key Features

- **Script Management**: Create, edit, enable/disable, import/export scripts
- **Execution Engine**: Run scripts on matching URLs with timeout protection
- **GM_* API Compatibility**: Basic Greasemonkey API layer (GM_getValue, GM_setValue, etc.)
- **Three-Panel UI**: Scripts list (left), editor (center), preview/test (right)
- **Background Automation**: Scheduled execution with cron-like scheduling
- **Import/Export**: Support for .user.js format (Greasemonkey/Tampermonkey)

---

## 2. Reference Implementation: quoid/userscripts

### 2.1 Analysis of quoid/userscripts

**Key Observations**:
- Clean three-panel layout: script list, editor, settings
- Metadata-driven script matching (`@match`, `@exclude-match`)
- Support for standard Greasemonkey headers
- Simple enable/disable toggles per script
- Import/export as `.user.js` files
- Execution contexts: document-start, document-end, document-idle
- Basic GM_* API compatibility

**What We'll Adopt**:
- Three-panel UI pattern (adapted to Peek's editor extension)
- Metadata-driven matching system
- Import/export .user.js format
- Execution timing controls (run-at)

**What We'll Improve**:
- Live preview panel showing execution results
- Integration with Peek's datastore for persistence
- Scheduled background execution
- Execution history and analytics
- Test mode with URL input

---

## 3. Architecture Overview

### 3.1 Core Components

```
┌─────────────────────────────────────────────────────────────┐
│                    Scripts Extension                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │  Scripts     │  │   Script     │  │   Background    │  │
│  │  Manager UI  │  │   Executor   │  │   Scheduler     │  │
│  │              │  │              │  │                 │  │
│  │ - List       │  │ - Pattern    │  │ - Cron-like     │  │
│  │ - CRUD ops   │  │ - Injection  │  │ - Auto-exec     │  │
│  │ - Import/    │  │ - Timeout    │  │ - History       │  │
│  │   Export     │  │ - GM_* API   │  │                 │  │
│  └──────────────┘  └──────────────┘  └─────────────────┘  │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                     Datastore Tables                        │
├─────────────────────────────────────────────────────────────┤
│  - scripts: Script metadata (name, code, match patterns)    │
│  - scripts_data: Execution history and results              │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Data Flow

1. **Script Creation**: User creates script via UI → saved to `scripts` table
2. **Page Load**: Peek opens URL → executor checks match patterns → runs matching scripts
3. **Manual Execution**: User clicks "Test on This Page" → executor runs against test URL
4. **Scheduled Execution**: Background scheduler checks intervals → runs matching scripts
5. **Result Storage**: Execution completes → result logged to `scripts_data` table

---

## 4. User Interface Design

### 4.1 Three-Panel Layout

```
┌────────────────────────────────────────────────────────────────────────┐
│ Scripts Manager                              [Minimize] [_] [x]        │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│ ┌─────────────┐ ┌──────────────────────────┐ ┌─────────────────────┐ │
│ │  Scripts    │ │   Editor                 │ │  Preview / Tests    │ │
│ │             │ │                          │ │                     │ │
│ │ [+] New     │ │ Name: ___________        │ │ Test URL:           │ │
│ │             │ │ Match: ___________       │ │ https://example.com │ │
│ │ ✓ Script 1  │ │ Run-at: [document-end] ▼│ │                     │ │
│ │   24ms      │ │                          │ │ [Test on This Page] │ │
│ │   2h ago    │ │ ┌──────────────────────┐ │ │                     │ │
│ │             │ │ │ 1  // ==UserScript== │ │ │ ┌─────────────────┐ │ │
│ │ ✗ Script 2  │ │ │ 2  // @name Test    │ │ │ │ Status: Success │ │ │
│ │ ERROR       │ │ │ 3  //              │ │ │ │ Time: 42ms      │ │ │
│ │   Never     │ │ │ 4                  │ │ │ │                 │ │ │
│ │             │ │ │ 5  let h = doc...  │ │ │ │ Result:         │ │ │
│ │ ◊ Script 3  │ │ │ 6    return h      │ │ │ │ {               │ │ │
│ │   disabled  │ │ │                     │ │ │ │   "data": [..], │ │ │
│ │   42ms      │ │ │                     │ │ │ │   "count": 15   │ │ │
│ │             │ │ └──────────────────────┘ │ │ │ }               │ │ │
│ │ ⓘ Script 4  │ │ [Save] [Revert] [Delete] │ │ │                 │ │ │
│ │   no change │ │                          │ │ │ [Copy Result]   │ │ │
│ │   15min ago │ │                          │ │ │ [Copy JSON]     │ │ │
│ │             │ │                          │ │ │                 │ │ │
│ │ ⚙ Settings  │ │                          │ │ └─────────────────┘ │ │
│ │ 📝 History  │ │                          │ │                     │ │
│ │ ⓘ About     │ │                          │ │ Execution History:  │ │
│ │             │ │                          │ │ ┌─────────────────┐ │ │
│ │ [RUN ALL]   │ │                          │ │ │ Latest 5 Runs:  │ │ │
│ │             │ │                          │ │ │ ✓ 2m ago        │ │ │
│ │             │ │                          │ │ │ ✓ 1h ago        │ │ │
│ │             │ │                          │ │ │ ✓ 1d ago        │ │ │
│ │             │ │                          │ │ │ ✗ 3d ago        │ │ │
│ │             │ │                          │ │ │ ✓ 1w ago        │ │ │
│ │             │ │                          │ │ └─────────────────┘ │ │
│ └─────────────┘ └──────────────────────────┘ └─────────────────────┘ │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Script List Features

Each script shows:
- **Checkbox** (enable/disable)
- **Icon** (type: web-scraper, data-transform, automation, utility)
- **Name** + truncated description
- **Status indicator**:
  - Green checkmark: Last execution successful
  - Red X: Last execution failed
  - Orange warning: Last execution but data unchanged
  - Gray: Never executed
- **Execution time badge** (e.g., "24ms")
- **Last run timestamp** (e.g., "2 hours ago")

Right-click context menu:
- Edit
- Delete
- Duplicate
- Export as JSON
- View history
- Debug (dev console for this script)

### 4.3 Script Creation Workflow

1. **Click [+ New]** → Opens new script editor
2. **Set metadata**:
   - Name: "My Data Scraper"
   - Match patterns: `https://news.example.com/*`
   - Run-at: document-end
3. **Write code**:
   ```javascript
   // Extract all headlines
   const headlines = Array.from(
     document.querySelectorAll('h2.headline')
   ).map(el => el.textContent);

   console.log('Found headlines:', headlines);

   // Return data to Peek
   { headlines, count: headlines.length }
   ```
4. **Test on Page**: Enter test URL, hit "Test on This Page"
5. **Save** → Stored in datastore, ready for auto-execution

### 4.4 Preview Panel States

**When no test has been run:**
```
Test URL:
[https://___________________]

[Test on This Page]

Instructions:
1. Enter a URL to test
2. Click "Test on This Page"
3. Results will appear here
```

**During execution:**
```
Testing: https://example.com
⏳ Running... (2s)
```

**After success:**
```
✓ Success
Execution time: 342ms

Result:
{
  "headlines": [
    "Story 1",
    "Story 2"
  ],
  "count": 15
}

[Copy Result] [Copy JSON]

↓ Changed from last run
Previous: count: 12
```

**After error:**
```
✗ Error at line 5

TypeError: Cannot read property 'querySelectorAll' of undefined

Stack:
  at Object.<anonymous> (eval:5:13)
  at runScript (executor.js:45:12)

[Show Full Error]
```

---

## 5. Script Execution Engine

### 5.1 Execution Modes

**Two Execution Modes**:

1. **Peek Pages** (peek://ext/*, peek://app/*):
   - Direct execution in renderer process
   - Full DOM access, no sandboxing needed
   - Used for testing/preview

2. **Web Pages** (https://*, http://*):
   - Injected as `<script>` tag into page
   - Runs in page context (not isolated)
   - Can be upgraded to isolated context with `function(){}` wrapper
   - Communicates back via postMessage to Peek IPC

### 5.2 Script Executor Class

```javascript
// extensions/scripts/script-executor.js

export class ScriptExecutor {
  /**
   * Execute a script against a page URL or DOM
   */
  async executeScript(script, executionContext) {
    const {
      url,              // Full URL of target page
      pageDOM,          // document object (if peek:// page)
      pageWindow,       // window object (if peek:// page)
      timeout = 5000    // Max execution time
    } = executionContext;

    // Validate script matches URL
    if (!this.matchesUrl(script, url)) {
      return {
        status: 'skipped',
        reason: 'URL does not match script patterns'
      };
    }

    try {
      const result = await this.runScriptInContext(
        script.code,
        pageDOM || document,
        pageWindow || window,
        timeout
      );

      return {
        status: 'success',
        result,
        executionTime: result.time,
        output: result.output
      };
    } catch (error) {
      return {
        status: 'error',
        error: error.message,
        stack: error.stack
      };
    }
  }

  /**
   * Check if script's match patterns apply to URL
   */
  matchesUrl(script, url) {
    return script.matchPatterns.some(pattern =>
      this.matchPattern(pattern, url)
    ) && !script.excludePatterns.some(pattern =>
      this.matchPattern(pattern, url)
    );
  }

  /**
   * Match a single pattern against URL
   * Supports: https://example.com/*, *://example.com/*, etc.
   */
  matchPattern(pattern, url) {
    // Convert glob pattern to regex
    const regex = new RegExp(
      '^' + pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // Escape special chars
        .replace(/\*/g, '.*')                    // * -> .*
        .replace(/\?/g, '.')                     // ? -> .
      + '$'
    );
    return regex.test(url);
  }

  /**
   * Execute script with timeout, capturing console output
   */
  async runScriptInContext(code, document, window, timeout) {
    const startTime = performance.now();
    const logs = [];

    // Capture console output
    const originalLog = console.log;
    console.log = (...args) => {
      logs.push(args.map(a =>
        typeof a === 'object' ? JSON.stringify(a) : String(a)
      ).join(' '));
      originalLog(...args);
    };

    try {
      // Wrap in async function to support await
      const wrappedCode = `
        (async () => {
          ${code}
        })()
      `;

      const fn = new Function('document', 'window', wrappedCode);
      const result = await Promise.race([
        fn(document, window),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Script timeout')), timeout)
        )
      ]);

      return {
        time: Math.round(performance.now() - startTime),
        output: logs,
        result
      };
    } finally {
      console.log = originalLog;
    }
  }
}
```

### 5.3 GM_* API Compatibility Layer

Provide a minimal GM_* compatibility layer:

```javascript
// extensions/scripts/gm-api.js

export function createGMAPI(scriptId, namespace) {
  const store = openStore(`gm_${scriptId}`, {});

  return {
    // Storage APIs (match Greasemonkey)
    GM_setValue: async (key, value) => {
      store.set(key, value);
    },

    GM_getValue: async (key, defaultValue) => {
      return store.get(key) ?? defaultValue;
    },

    GM_deleteValue: async (key) => {
      store.delete(key);
    },

    // Logging
    GM_log: (...args) => {
      console.log('[' + scriptId + ']', ...args);
    },

    // Notifications (via Peek API)
    GM_notification: async (text, title, options) => {
      // Could integrate with Peek notifications if available
      console.log(title, text);
    },

    // Network (via IPC to avoid CORS)
    GM_xmlhttpRequest: async (options) => {
      const result = await fetch(options.url, {
        method: options.method || 'GET',
        headers: options.headers,
        body: options.data
      });
      options.onload?.({
        responseText: await result.text(),
        status: result.status
      });
    }
  };
}
```

Inject into script context:

```javascript
const fn = new Function('document', 'window', 'GM_getValue', 'GM_setValue', ...
  wrappedCode
);
const result = await fn(document, window, gmApi.GM_getValue, gmApi.GM_setValue, ...);
```

---

## 6. Background Script Automation

### 6.1 Auto-Execution Triggers

Scripts can be triggered by:

1. **On Page Load**
   - When Peek opens a web page URL
   - Check match patterns
   - Execute matching scripts in background

2. **On Scheduled Interval**
   ```json
   {
     "schedule": "hourly" | "daily" | "weekly" | "custom",
     "customSchedule": "0 9 * * *"  // cron format (optional)
   }
   ```
   - Maintained by background extension
   - Stores last execution in scripts_data table

3. **Via Command Palette**
   - User invokes "scripts:run" with URL parameter
   - Can pick specific script or run all matching

4. **Manual Trigger** (user clicks [RUN] button)

### 6.2 Background Execution Model

```javascript
// extensions/scripts/background.js (in existing background script context)

const backgroundExecutor = {
  async runScheduledScripts() {
    const store = openStore('scripts', {});
    const scripts = store.get('scripts') || [];

    for (const script of scripts) {
      if (!script.enabled || !script.schedule) continue;

      const lastRun = script.lastScheduledRun || 0;
      const interval = this.getScheduleInterval(script.schedule);

      if (Date.now() - lastRun >= interval) {
        // Run on a sample of recent pages matching pattern
        const recentPages = await this.getRecentPagesMatching(script);

        for (const page of recentPages) {
          await scriptEngine.executeScript(script, {
            url: page.uri,
            pageWindow: null,  // No window context (headless)
            pageDOM: null      // Would need to fetch page content
          });
        }

        script.lastScheduledRun = Date.now();
        store.set('scripts', scripts);
      }
    }
  },

  getScheduleInterval(schedule) {
    const intervals = {
      'hourly': 60 * 60 * 1000,
      'daily': 24 * 60 * 60 * 1000,
      'weekly': 7 * 24 * 60 * 60 * 1000
    };
    return intervals[schedule] || 0;
  },

  async getRecentPagesMatching(script) {
    // Query datastore for recent addresses matching pattern
    const result = await api.datastore.queryAddresses({
      sortBy: 'lastVisit',
      limit: 5
    });

    return result.data.filter(addr =>
      scriptEngine.matchesUrl(script, addr.uri)
    );
  }
};

// Run scheduled checks periodically
setInterval(() => {
  backgroundExecutor.runScheduledScripts();
}, 60 * 1000); // Every minute, check if any scripts need running
```

---

## 7. Data Schema & Storage

### 7.1 Script Metadata Storage

Each script is stored with:

```javascript
{
  id: 'script_1707500000000_abc123',
  name: 'HN Headline Scraper',
  description: 'Extract all headlines from Hacker News',
  code: '... JavaScript source ...',

  // Execution configuration
  matchPatterns: [
    'https://news.ycombinator.com/*',
    'https://hn.algolia.com/*'
  ],
  excludePatterns: [],
  runAt: 'document-end',

  // Triggers
  enabled: true,
  schedule: null,  // or 'hourly', 'daily', etc.
  autoExecute: true,  // Run when matching page loads

  // Metadata
  version: '1.0.0',
  author: 'User Name',
  namespace: 'https://peek.local/user/scripts/hn-scraper',

  // Statistics
  createdAt: 1707500000000,
  updatedAt: 1707500000000,
  lastExecutedAt: 1707500000000,
  executionCount: 45,
  lastError: null,

  // Storage
  metadata: '{"grants": ["GM_getValue"], "connects": ["api.example.com"]}'
}
```

### 7.2 Execution History

Each execution logged to `scripts_data`:

```javascript
{
  id: 'script_data_1707500000000_def456',
  scriptId: 'script_1707500000000_abc123',
  addressId: 'addr_xyz789',  // URL where executed

  status: 'success',  // 'success', 'error', 'timeout'
  error: null,
  executedAt: 1707500000000,
  executionTime: 342,  // milliseconds

  result: '{"headlines": ["...", "..."], "count": 15}',
  extractedData: '{"headlines": [array], "count": 15}',
  output: '["Found 15 headlines"]',  // console.log output

  changed: true,  // Did result differ from last execution?
  previousResult: '{"headlines": ["..."], "count": 12}'
}
```

### 7.3 Querying & Analytics

Example queries on scripts_data:

```javascript
// Script statistics
async function getScriptStats(scriptId) {
  const data = await api.datastore.getTable('scripts_data');
  const scriptExecutions = Object.values(data).filter(
    row => row.scriptId === scriptId
  );

  return {
    totalExecutions: scriptExecutions.length,
    successCount: scriptExecutions.filter(r => r.status === 'success').length,
    errorCount: scriptExecutions.filter(r => r.status === 'error').length,
    averageTime: scriptExecutions.reduce((sum, r) => sum + r.executionTime, 0) /
                 scriptExecutions.length,
    lastRun: scriptExecutions[scriptExecutions.length - 1]?.executedAt
  };
}
```

---

## 8. Integration with Editor Extension

The scripts system works closely with the editor extension:

### 8.1 Opening Scripts in Editor

```javascript
// From scripts manager (right-click on script)
api.publish('editor:open', {
  itemId: script.id,  // Identifies this as a script
  content: script.code,
  file: `script_${script.id}.js`,
  metadata: {
    type: 'userscript',
    name: script.name,
    matchPatterns: script.matchPatterns,
    runAt: script.runAt
  }
}, api.scopes.GLOBAL);
```

### 8.2 Saving from Editor

When editor saves a script:

```javascript
// In editor extension
api.subscribe('scripts:save', async (msg) => {
  const { scriptId, code, metadata } = msg;

  // Update script in datastore
  const script = await api.datastore.getRow('scripts', scriptId);
  script.code = code;
  Object.assign(script, metadata);
  script.updatedAt = Date.now();

  await api.datastore.setRow('scripts', scriptId, script);

  // Notify scripts extension
  api.publish('script:updated', { scriptId }, api.scopes.GLOBAL);
}, api.scopes.GLOBAL);
```

### 8.3 Side-by-Side Editing + Preview

When editing a script:

1. **Left**: Script list sidebar (minimized or hidden)
2. **Center**: CodeMirror editor (from editor extension)
3. **Right**: Live preview panel showing:
   - Test URL input
   - [Test on This Page] button
   - Execution results in real-time

---

## 9. Import/Export & Sharing

### 9.1 Export Formats

**Single Script (JSON)**:
```json
{
  "type": "peek-userscript",
  "version": "1.0.0",
  "script": {
    "name": "My Script",
    "code": "...",
    "matchPatterns": ["https://example.com/*"],
    "runAt": "document-end"
  }
}
```

**Multiple Scripts (ZIP)**:
```
scripts-export.zip
├── script-1.js
├── script-2.js
├── metadata.json
└── README.md
```

**Greasemonkey/Tampermonkey Format**:
Direct `.user.js` file with UserScript header:
```javascript
// ==UserScript==
// @name        Example
// @match       https://example.com/*
// ==/UserScript==
... code ...
```

### 9.2 Import Process

1. Drag `.user.js` file onto scripts manager
2. Parse UserScript header
3. Extract metadata (name, match, run-at, etc.)
4. Show import preview dialog
5. Confirm → Create script in datastore

```javascript
async function importUserScript(fileContent) {
  const { header, code } = parseUserScriptHeader(fileContent);

  const script = {
    id: generateId('script'),
    name: header['@name'] || 'Imported Script',
    description: header['@description'] || '',
    code,
    matchPatterns: header['@match'] || ['*://*/*'],
    excludePatterns: header['@exclude'] || [],
    runAt: header['@run-at'] || 'document-end',
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  await api.datastore.setRow('scripts', script.id, script);
  return script;
}
```

---

## 10. Example Scripts

### Example 1: HN Headline Scraper

```javascript
// ==UserScript==
// @name        HN Headline Scraper
// @description Extract all stories from Hacker News homepage
// @match       https://news.ycombinator.com/*
// @run-at      document-end
// ==/UserScript==

const stories = [];
const rows = document.querySelectorAll('.athing');

rows.forEach((row, index) => {
  const titleEl = row.querySelector('.titleline > a');
  const scoreEl = row.nextElementSibling?.querySelector('.score');

  if (titleEl) {
    stories.push({
      rank: index + 1,
      title: titleEl.textContent,
      url: titleEl.href,
      score: scoreEl ? parseInt(scoreEl.textContent) : null
    });
  }
});

console.log(`Found ${stories.length} stories`);
return { stories, timestamp: new Date().toISOString() };
```

### Example 2: Price Change Detector

```javascript
// ==UserScript==
// @name        Price Tracker
// @description Monitor product price changes
// @match       https://example-shop.com/product/*
// @run-at      document-end
// ==/UserScript==

const priceEl = document.querySelector('[data-price]');
const price = parseFloat(priceEl?.dataset.price || '0');

const GM_getValue = window.GM_getValue || (() => null);
const previousPrice = await GM_getValue('lastPrice');

const changed = previousPrice && Math.abs(previousPrice - price) > 0.01;

if (changed) {
  const direction = price < previousPrice ? 'decreased' : 'increased';
  console.log(`Price ${direction}: $${previousPrice} → $${price}`);
}

// Store current price for next run
if (window.GM_setValue) {
  await GM_setValue('lastPrice', price);
}

return { price, changed, direction: price < previousPrice ? 'down' : 'up' };
```

### Example 3: Form Auto-Fill

```javascript
// ==UserScript==
// @name        Auto-Fill Helper
// @description Auto-fill common form fields
// @match       https://forms.example.com/*
// @run-at      document-start
// ==/UserScript==

// Run before form renders (with document-start)
window.addEventListener('load', () => {
  const fields = {
    email: document.querySelector('input[name="email"]'),
    phone: document.querySelector('input[name="phone"]'),
    name: document.querySelector('input[name="name"]')
  };

  if (fields.email) fields.email.value = 'user@example.com';
  if (fields.phone) fields.phone.value = '555-1234';
  if (fields.name) fields.name.value = 'John Doe';

  console.log('Form fields auto-filled');
  return { filled: Object.keys(fields).filter(k => fields[k]).length };
});
```

---

## 11. Security Considerations

### 11.1 Threat Model

1. **Untrusted User Scripts**
   - User imports script from internet
   - Could exfiltrate data, modify pages, etc.

   **Mitigation**:
   - Show source code before import
   - Display requested permissions (@grant, @connect)
   - User explicitly approves execution
   - Log all executions for audit

2. **Malicious Pattern Matching**
   - Script with `<all_urls>` runs on every page
   - Could be memory/CPU intensive

   **Mitigation**:
   - Timeout protection (5 second default)
   - Rate limiting (max X executions per minute)
   - Memory limits (kill if exceeds threshold)
   - Disable scripts after repeated errors

3. **Data Exfiltration**
   - Script extracts sensitive info, sends to attacker server

   **Mitigation**:
   - Log all network requests made by scripts
   - Show network log in debug panel
   - Future: Network request approval dialog (like permissions)

### 11.2 Recommended Security Features

1. **Script Signing** (future):
   - Author signs script with private key
   - Peek verifies signature on import
   - Builds trust network of script authors

2. **Permissions Model** (future):
   - `@grant GM_*` APIs explicitly listed
   - `@connect` domains declared
   - User prompted on first use

3. **Isolation Options** (future):
   - iframe sandbox mode for sensitive sites
   - Service worker isolation alternative

---

## 12. Implementation Roadmap

### Phase 1: Core System (2-3 weeks)

- [ ] Create `scripts` extension
- [ ] Implement script datastore schema
- [ ] Build script executor (content script injection)
- [ ] Create basic scripts manager UI (list + simple editor)
- [ ] Test execution on both peek:// and http:// URLs

### Phase 2: Full Editor Integration (1-2 weeks)

- [ ] Integrate with editor extension
- [ ] CodeMirror setup with syntax highlighting
- [ ] Metadata form (name, match patterns, run-at)
- [ ] Test/preview panel
- [ ] Execution result display

### Phase 3: Advanced Features (2-3 weeks)

- [ ] Import/export (Tampermonkey/Greasemonkey format)
- [ ] Scheduled execution (cron-like)
- [ ] Script history & analytics
- [ ] GM_* API compatibility layer
- [ ] Debugging console for scripts

### Phase 4: Polish & Refinement (1 week)

- [ ] Keyboard shortcuts
- [ ] Context menus (right-click on scripts)
- [ ] Error handling & recovery
- [ ] Documentation & examples
- [ ] Performance optimization

---

## 13. Key Architectural Decisions

### Decision 1: Where to Execute Scripts?

**Chosen: Two-mode approach**
- **Peek pages** (peek://): Direct execution in renderer
- **Web pages** (https://): Injected script + IPC bridge

**Alternative Considered**: Always fetch page content via HTTP and execute headless (CORS issues, slower)

### Decision 2: Sandboxing Level?

**Chosen: Minimal sandboxing initially**
- Scripts can access full page DOM
- Can make XMLHttpRequest/fetch
- No iframe isolation (complexity vs. safety tradeoff)

**Future**: Add iframe sandbox mode for untrusted scripts with permission model

### Decision 3: Storage Location?

**Chosen: TinyBase datastore (like addresses/visits)**
- Consistent with Peek architecture
- Queries via datastore API
- Can be synced to server in future

**Alternative Considered**: Separate file-based storage (worse sync prospects)

### Decision 4: Script Testing?

**Chosen: Live preview against real URLs**
- User enters test URL
- Script executes against that URL's content
- Results show immediately in right panel

**Alternative**: Static preview mode (less useful, doesn't catch real-world issues)

---

## 14. Testing Strategy

### Unit Tests

```javascript
// tests/scripts/executor.spec.js

describe('ScriptExecutor', () => {
  test('matchPattern: exact domain', () => {
    const executor = new ScriptExecutor();
    expect(executor.matchPattern('https://example.com/*', 'https://example.com/page'))
      .toBe(true);
    expect(executor.matchPattern('https://example.com/*', 'https://other.com/page'))
      .toBe(false);
  });

  test('matchPattern: wildcard subdomain', () => {
    const executor = new ScriptExecutor();
    expect(executor.matchPattern('https://*.example.com/*', 'https://sub.example.com/'))
      .toBe(true);
    expect(executor.matchPattern('https://*.example.com/*', 'https://example.com/'))
      .toBe(false);  // Subdomains only
  });

  test('executeScript: timeout protection', async () => {
    const executor = new ScriptExecutor();
    const result = await executor.executeScript(
      { code: 'while(true) {}' },
      { url: 'https://example.com', timeout: 100 }
    );
    expect(result.status).toBe('error');
    expect(result.error).toContain('timeout');
  });
});
```

### Integration Tests

```javascript
// tests/scripts/integration.spec.js

describe('Scripts Extension', () => {
  test('Create, save, and execute script', async () => {
    const api = window.app;

    // Create script
    const script = {
      id: 'test_script',
      name: 'Test',
      code: 'return 42;',
      matchPatterns: ['https://example.com/*'],
      runAt: 'document-end'
    };

    await api.datastore.setRow('scripts', script.id, script);

    // Execute
    const result = await scriptEngine.executeScript(script, {
      url: 'https://example.com/',
      pageDOM: document
    });

    expect(result.status).toBe('success');
    expect(result.result).toBe(42);
  });
});
```

---

## 15. Success Metrics

- Script creation workflow < 2 minutes
- Execution latency < 500ms for typical scripts
- Ability to import any Greasemonkey/Tampermonkey script
- Support for 10,000+ lines of code per script
- Error handling with clear stack traces

---

## 16. Why It's Valuable for Peek

1. **Extends Peek's "workbench" vision** - Scripts are automation + data mining tools
2. **Bridges to web automation** - Users can extract data from any website
3. **Compatible with web standards** - Supports Greasemonkey/Tampermonkey format
4. **Fits extension architecture** - Extends existing extension system cleanly
5. **Enables future features**:
   - Scheduled data collection
   - Custom domain-specific tools
   - Workflow automation
   - Data transformation pipelines

---

## Conclusion

This comprehensive design provides a **powerful, accessible content scripting system** that fits naturally into Peek's modular architecture while maintaining compatibility with the established web scripting ecosystem. The three-panel UI approach inspired by quoid/userscripts, combined with Peek's datastore persistence and editor integration, creates a unique development environment for web automation and data extraction.

The phased implementation prioritizes core functionality first, with advanced features (scheduling, GM_* APIs, security) following once the foundation is solid.

---

## Meta

- **Author**: Exploration Agent (a9b4e5d)
- **Date**: 2026-02-09
- **Status**: Design/Planning Phase
- **Related**: Extension system, editor extension, datastore architecture, web automation
