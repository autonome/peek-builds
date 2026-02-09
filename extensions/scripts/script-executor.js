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
   * Execute script with timeout, capturing console output
   * @param {string} code - JavaScript code to execute
   * @param {Document} document - Document object
   * @param {Window} window - Window object
   * @param {number} timeout - Timeout in milliseconds
   * @returns {Promise<object>} Result with time, output, and result
   */
  async runScriptInContext(code, document, window, timeout) {
    const startTime = performance.now();
    const logs = [];

    // Capture console output
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;

    console.log = (...args) => {
      logs.push({ level: 'log', message: this.formatArgs(args) });
      originalLog(...args);
    };
    console.error = (...args) => {
      logs.push({ level: 'error', message: this.formatArgs(args) });
      originalError(...args);
    };
    console.warn = (...args) => {
      logs.push({ level: 'warn', message: this.formatArgs(args) });
      originalWarn(...args);
    };

    try {
      // Wrap in async function to support await
      const wrappedCode = `
        (async () => {
          ${code}
        })()
      `;

      const fn = new Function('document', 'window', `return ${wrappedCode}`);
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
      console.error = originalError;
      console.warn = originalWarn;
    }
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
