/**
 * Commands module - exports all available commands
 * Note: groups commands are now provided by the groups extension
 * Note: sync command is now provided by the sync extension
 * Note: open/modal commands are now provided by the page extension
 * Note: tag, tags, untag, tagset commands are now provided by the tags extension
 */
import debugCommand from './debug.js';
import noteModule from './note.js';
import editModule from './edit.js';
import urlModule from './url.js';
import historyModule from './history.js';
import pageModule from './page.js';

// Chaining commands - for command composition pipelines
import sampleDataCommand from './sample-data.js';
// csv and save commands moved to files extension

// Source commands (commented out as they need browser extension APIs)
// These modules contain command sources that dynamically generate commands
import bookmarkletsSource from './bookmarklets.js';
import googleDocsSource from './googledocs.js';
import sendToWindowSource from './sendtowindow.js';
import switchToWindowSource from './switchtowindow.js';
import containerTabSource from './containertab.js';

// Individual commands (commented out as they need browser extension APIs)
import bookmarkCommand from './bookmark.js';
import emailCommand from './email.js';

// Active commands - only these will be loaded
// Note: groups commands are dynamically registered by the groups extension
// Note: sync command is dynamically registered by the sync extension
// Note: open/modal commands are dynamically registered by the page extension
// Note: tag, tags, untag, tagset commands are dynamically registered by the tags extension
const activeCommands = [
  debugCommand,
  ...noteModule.commands,
  ...editModule.commands,
  ...urlModule.commands,
  ...historyModule.commands,
  ...pageModule.commands,

  // Chaining commands
  sampleDataCommand
  // csv and save commands moved to files extension
];

console.log('[cmd:commands/index] activeCommands:', activeCommands.map(c => c.name));

// Inactive commands - these require browser extension APIs and are not loaded
const inactiveCommands = [
  // Individual commands
  bookmarkCommand,
  emailCommand,

  // Source commands that dynamically generate commands
  bookmarkletsSource,
  googleDocsSource,
  sendToWindowSource,
  switchToWindowSource,
  containerTabSource
];

// Array of all available commands
const commands = [...activeCommands];

// Source commands - these are modules that generate multiple commands dynamically
const sources = [
  historyModule
];

/**
 * Initializes command sources that dynamically generate commands
 * @param {Function} addCommand - Function to register a command (triggers UI update)
 * @param {Object} batchApi - Batch-friendly API for bulk operations
 * @param {Function} batchApi.addCommandSilent - Add command without triggering update
 * @param {Function} batchApi.removeCommand - Remove a command by name
 * @param {Function} batchApi.flushUpdates - Trigger a single UI update after batch
 */
export const initializeSources = async (addCommand, batchApi = {}) => {
  for (const source of sources) {
    if (typeof source.initializeSources === 'function') {
      await source.initializeSources(addCommand, batchApi);
    }
  }
};

/**
 * Gets a command by name
 * @param {string} name - The command name to look for
 * @returns {Object|null} The command object or null if not found
 */
export const getCommand = (name) => {
  return commands.find(cmd => cmd.name === name) || null;
};

/**
 * Gets all active commands
 * @returns {Array} Array of command objects
 */
export const getAllCommands = () => {
  return commands;
};

/**
 * Converts commands array to object map for legacy compatibility
 * @returns {Object} Map of command name to command object
 */
export const getCommandsMap = () => {
  const commandMap = {};
  commands.forEach(cmd => {
    commandMap[cmd.name] = cmd;
  });
  return commandMap;
};

export default {
  commands,
  sources,
  getCommand,
  getAllCommands,
  getCommandsMap,
  initializeSources
};
