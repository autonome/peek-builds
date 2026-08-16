/**
 * SQL Adapter Factory
 *
 * Selects the appropriate SQL adapter based on environment configuration.
 * Currently only supports node:sqlite; future adapters can be added here.
 */

const { factory: nodeSqliteFactory } = require("./node-sqlite-adapter");

// Environment variable to select SQL adapter (future use)
const SQL_ADAPTER = process.env.SQL_ADAPTER || "node-sqlite";

function getFactory() {
  switch (SQL_ADAPTER) {
    case "node-sqlite":
      return nodeSqliteFactory;
    // Future: case "do-sqlite": return doSqliteFactory;
    default:
      console.warn(`Unknown SQL_ADAPTER "${SQL_ADAPTER}", falling back to node-sqlite`);
      return nodeSqliteFactory;
  }
}

const sqlFactory = getFactory();

module.exports = { sqlFactory };
