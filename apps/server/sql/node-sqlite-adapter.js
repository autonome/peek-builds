/**
 * node:sqlite Adapter Implementation
 *
 * Wraps Node's built-in `node:sqlite` (`DatabaseSync`) to conform to the
 * SqlAdapter interface. Provides statement caching for improved performance.
 *
 * Unlike better-sqlite3, `node:sqlite` has no built-in `transaction()` helper —
 * `transaction()` below wraps the callback in an explicit BEGIN/COMMIT, rolling
 * back on any thrown error. No call path in this codebase nests transactions
 * (verified: every `conn.transaction()` caller passes a callback that issues
 * plain `run`/`get`/`all` calls, never another `transaction()`), so a bare
 * BEGIN/COMMIT/ROLLBACK is sufficient — a nested transaction would need
 * savepoints instead, since SQLite does not support nested BEGIN.
 */

const { DatabaseSync } = require("node:sqlite");

/**
 * @typedef {import('./types').SqlAdapter} SqlAdapter
 * @typedef {import('./types').SqlAdapterFactory} SqlAdapterFactory
 * @typedef {import('./types').RunResult} RunResult
 */

/**
 * @implements {SqlAdapter}
 */
class NodeSqliteAdapter {
  /**
   * @param {import('node:sqlite').DatabaseSync} db
   */
  constructor(db) {
    /** @private */
    this.db = db;
    /** @private @type {Map<string, import('node:sqlite').StatementSync>} */
    this.stmtCache = new Map();
  }

  /**
   * @param {string} sql
   */
  exec(sql) {
    this.db.exec(sql);
  }

  /**
   * @param {string} sql
   * @param {unknown[]} [params=[]]
   * @returns {RunResult}
   */
  run(sql, params = []) {
    const stmt = this.getOrPrepare(sql);
    const result = stmt.run(...params);
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  }

  /**
   * @template T
   * @param {string} sql
   * @param {unknown[]} [params=[]]
   * @returns {T|null}
   */
  get(sql, params = []) {
    const stmt = this.getOrPrepare(sql);
    return stmt.get(...params) ?? null;
  }

  /**
   * @template T
   * @param {string} sql
   * @param {unknown[]} [params=[]]
   * @returns {T[]}
   */
  all(sql, params = []) {
    const stmt = this.getOrPrepare(sql);
    return stmt.all(...params);
  }

  /**
   * @template T
   * @param {function(): T} fn
   * @returns {T}
   */
  transaction(fn) {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore — nothing to roll back if BEGIN itself failed */
      }
      throw err;
    }
  }

  close() {
    this.stmtCache.clear();
    this.db.close();
  }

  /**
   * @private
   * @param {string} sql
   * @returns {import('node:sqlite').StatementSync}
   */
  getOrPrepare(sql) {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmtCache.set(sql, stmt);
    }
    return stmt;
  }
}

/**
 * @type {SqlAdapterFactory}
 */
const factory = {
  /**
   * @param {string} path
   * @param {{ readonly?: boolean }} [options]
   * @returns {SqlAdapter}
   */
  open(path, options) {
    const dbOptions = options?.readonly ? { readOnly: true } : {};
    const db = new DatabaseSync(path, dbOptions);
    return new NodeSqliteAdapter(db);
  },

  /**
   * @param {SqlAdapter} adapter
   */
  init(adapter) {
    adapter.exec("PRAGMA journal_mode = WAL");
  },
};

module.exports = { factory, NodeSqliteAdapter };
