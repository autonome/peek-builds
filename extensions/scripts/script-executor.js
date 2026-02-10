/**
 * Script Executor - Core execution engine for userscripts
 *
 * Handles:
 * - Pattern matching (glob patterns)
 * - Timeout protection
 * - Console capture
 * - Dual execution modes (peek:// and http://)
 */

export class ScriptExecutor {
  constructor() {
    this.defaultTimeout = 5000; // 5 seconds
  }

  /**
   * Execute a script against a page URL or DOM
   * @param {object} script - Script object with code, matchPatterns, etc.
   * @param {object} executionContext - Context object with url, pageDOM, pageWindow, timeout
   * @returns {Promise<object>} Execution result
   */
  async executeScript(script, executionContext) {
    const {
      url,
      pageDOM = document,
      pageWindow = window,
      timeout = this.defaultTimeout
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
        pageDOM,
        pageWindow,
        timeout
      );

      return {
        status: 'success',
        result: result.result,
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
   * @param {object} script - Script with matchPatterns and excludePatterns
   * @param {string} url - URL to test
   * @returns {boolean}
   */
  matchesUrl(script, url) {
    const matches = script.matchPatterns.some(pattern =>
      this.matchPattern(pattern, url)
    );

    const excluded = script.excludePatterns && script.excludePatterns.length > 0
      ? script.excludePatterns.some(pattern => this.matchPattern(pattern, url))
      : false;

    return matches && !excluded;
  }

  /**
   * Match a single pattern against URL
   * Supports glob patterns: https://example.com/*, *://example.com/*, etc.
   * @param {string} pattern - Glob pattern
   * @param {string} url - URL to test
   * @returns {boolean}
   */
  matchPattern(pattern, url) {
    // Special case: match all
    if (pattern === '*' || pattern === '<all_urls>') {
      return true;
    }

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
   * Execute script with timeout, capturing console output.
   * Uses a Web Worker via blob URL to avoid CSP unsafe-eval restrictions
   * and to provide true timeout protection (worker.terminate() kills infinite loops).
   * @param {string} code - JavaScript code to execute
   * @param {Document} doc - Document object (not available inside Worker)
   * @param {Window} win - Window object (not available inside Worker)
   * @param {number} timeout - Timeout in milliseconds
   * @returns {Promise<object>} Result with time, output, and result
   */
  async runScriptInContext(code, doc, win, timeout) {
    const startTime = performance.now();

    // Build Worker code that:
    // 1. Provides minimal document/window stubs so scripts don't throw on DOM access
    // 2. Executes the user code in an async wrapper
    // 3. Posts the result (or error) back to the main thread
    const workerCode = `
      // Minimal DOM stubs - querySelector returns null, etc.
      const document = {
        querySelector: () => null,
        querySelectorAll: () => [],
        getElementById: () => null,
        getElementsByClassName: () => [],
        getElementsByTagName: () => [],
        createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
        head: { appendChild: () => {} },
        body: { appendChild: () => {} }
      };
      const window = self;

      const __logs = [];
      const __origLog = console.log;
      const __origError = console.error;
      const __origWarn = console.warn;
      console.log = (...args) => {
        __logs.push({ level: 'log', message: args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ') });
        __origLog(...args);
      };
      console.error = (...args) => {
        __logs.push({ level: 'error', message: args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ') });
        __origError(...args);
      };
      console.warn = (...args) => {
        __logs.push({ level: 'warn', message: args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ') });
        __origWarn(...args);
      };

      (async () => {
        try {
          const result = await (async () => {
            ${code}
          })();
          postMessage({ type: 'result', result, logs: __logs });
        } catch (e) {
          postMessage({ type: 'error', error: e.message, stack: e.stack, logs: __logs });
        }
      })();
    `;

    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    const worker = new Worker(blobUrl);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.terminate();
        URL.revokeObjectURL(blobUrl);
        reject(new Error('Script timeout'));
      }, timeout);

      worker.onmessage = (e) => {
        clearTimeout(timer);
        worker.terminate();
        URL.revokeObjectURL(blobUrl);

        const { type, result, error, stack, logs } = e.data;
        if (type === 'error') {
          // Re-throw as an Error so the caller gets status: 'error'
          const err = new Error(error);
          err.stack = stack;
          reject(err);
        } else {
          resolve({
            time: Math.round(performance.now() - startTime),
            output: logs || [],
            result
          });
        }
      };

      worker.onerror = (e) => {
        clearTimeout(timer);
        worker.terminate();
        URL.revokeObjectURL(blobUrl);
        reject(new Error(e.message || 'Worker error'));
      };
    });
  }

  /**
   * Format console arguments for storage
   * @param {Array} args - Console arguments
   * @returns {string}
   */
  formatArgs(args) {
    return args.map(a =>
      typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)
    ).join(' ');
  }
}

// Export singleton instance
export const scriptExecutor = new ScriptExecutor();
