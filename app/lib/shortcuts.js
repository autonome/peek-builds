/**
 * Shared Shortcut Parser & Matcher
 *
 * Platform-agnostic shortcut parsing, matching, and registry management.
 * Works in any web context (Electron renderer, Tauri webview, plain browser).
 *
 * NOTE: The Electron backend (backend/electron/shortcuts.ts) maintains its own
 * copy of this logic due to TS rootDir boundaries. Keep them in sync.
 *
 * @example
 *   import { parseShortcut, inputMatchesShortcut } from './shortcuts.js';
 *   const parsed = parseShortcut('Ctrl+Shift+K');
 *   const matches = inputMatchesShortcut(event, parsed);
 */

// Map key names to physical key codes (for keyboard event matching)
// Follows the USB HID / KeyboardEvent.code spec
export const keyToCode = {
  // Letters
  'a': 'KeyA', 'b': 'KeyB', 'c': 'KeyC', 'd': 'KeyD', 'e': 'KeyE',
  'f': 'KeyF', 'g': 'KeyG', 'h': 'KeyH', 'i': 'KeyI', 'j': 'KeyJ',
  'k': 'KeyK', 'l': 'KeyL', 'm': 'KeyM', 'n': 'KeyN', 'o': 'KeyO',
  'p': 'KeyP', 'q': 'KeyQ', 'r': 'KeyR', 's': 'KeyS', 't': 'KeyT',
  'u': 'KeyU', 'v': 'KeyV', 'w': 'KeyW', 'x': 'KeyX', 'y': 'KeyY',
  'z': 'KeyZ',
  // Numbers
  '0': 'Digit0', '1': 'Digit1', '2': 'Digit2', '3': 'Digit3', '4': 'Digit4',
  '5': 'Digit5', '6': 'Digit6', '7': 'Digit7', '8': 'Digit8', '9': 'Digit9',
  // Punctuation
  ',': 'Comma', '.': 'Period', '/': 'Slash', ';': 'Semicolon', "'": 'Quote',
  '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', '`': 'Backquote',
  '-': 'Minus', '=': 'Equal',
  // Special keys
  'enter': 'Enter', 'return': 'Enter',
  'tab': 'Tab',
  'space': 'Space', ' ': 'Space',
  'backspace': 'Backspace',
  'delete': 'Delete',
  'escape': 'Escape', 'esc': 'Escape',
  'up': 'ArrowUp', 'down': 'ArrowDown', 'left': 'ArrowLeft', 'right': 'ArrowRight',
  'arrowup': 'ArrowUp', 'arrowdown': 'ArrowDown', 'arrowleft': 'ArrowLeft', 'arrowright': 'ArrowRight',
  'home': 'Home', 'end': 'End',
  'pageup': 'PageUp', 'pagedown': 'PageDown',
  // Function keys
  'f1': 'F1', 'f2': 'F2', 'f3': 'F3', 'f4': 'F4', 'f5': 'F5', 'f6': 'F6',
  'f7': 'F7', 'f8': 'F8', 'f9': 'F9', 'f10': 'F10', 'f11': 'F11', 'f12': 'F12',
};

/**
 * Detect platform for CommandOrControl resolution.
 * Works in browser (navigator.platform) and Node/Electron (process.platform).
 */
function isMac() {
  if (typeof navigator !== 'undefined' && navigator.platform) {
    return navigator.platform.startsWith('Mac');
  }
  if (typeof process !== 'undefined' && process.platform) {
    return process.platform === 'darwin';
  }
  return false;
}

/**
 * Parse shortcut string into structured form.
 * e.g., 'Alt+Q' -> { alt: true, code: 'KeyQ' }
 * e.g., 'CommandOrControl+Shift+P' -> { meta: true, shift: true, code: 'KeyP' } (on Mac)
 *
 * @param {string} shortcut - Shortcut string like "Ctrl+Shift+K"
 * @returns {ParsedShortcut}
 */
export function parseShortcut(shortcut) {
  const parts = shortcut.toLowerCase().split('+');
  const result = {
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    code: ''
  };

  for (const part of parts) {
    const p = part.trim();
    if (p === 'ctrl' || p === 'control') {
      result.ctrl = true;
    } else if (p === 'alt' || p === 'option') {
      result.alt = true;
    } else if (p === 'shift') {
      result.shift = true;
    } else if (p === 'meta' || p === 'cmd' || p === 'command' || p === 'super') {
      result.meta = true;
    } else if (p === 'commandorcontrol' || p === 'cmdorctrl') {
      // On Mac, use meta (Cmd), on others use ctrl
      if (isMac()) {
        result.meta = true;
      } else {
        result.ctrl = true;
      }
    } else {
      // This is the key itself - convert to code
      result.code = keyToCode[p] || p;
    }
  }

  return result;
}

/**
 * Check if an input event matches a parsed shortcut.
 *
 * The input object should have: { alt, shift, meta, control, code }
 * This matches both Electron's before-input-event format and browser KeyboardEvent
 * (with control mapped from ctrlKey).
 *
 * @param {InputEvent} input - The keyboard input event
 * @param {ParsedShortcut} parsed - The parsed shortcut to match against
 * @returns {boolean}
 */
export function inputMatchesShortcut(input, parsed) {
  // Check modifiers
  if (input.alt !== parsed.alt) return false;
  if (input.shift !== parsed.shift) return false;
  if (input.meta !== parsed.meta) return false;
  if (input.control !== parsed.ctrl) return false;

  // Check physical key code (case-insensitive comparison)
  return input.code.toLowerCase() === parsed.code.toLowerCase();
}

/**
 * Create a shortcut registry for managing local shortcuts with mode-conditional support.
 *
 * @param {object} [options]
 * @param {function} [options.checkModeConditions] - Function (windowId, majorMode) => boolean
 *   for mode-conditional matching. If not provided, mode-conditional shortcuts never match.
 * @param {boolean} [options.debug] - Enable debug logging
 * @returns {ShortcutRegistry}
 */
export function createShortcutRegistry(options = {}) {
  const { checkModeConditions, debug } = options;

  // Local shortcuts: shortcut string -> array of entries
  const localShortcuts = new Map();

  /**
   * Register a local shortcut.
   * Supports mode-conditional shortcuts: same key can have different handlers for different modes.
   */
  function register(shortcut, source, callback, modeConditions) {
    debug && console.log('[shortcuts] register', shortcut, modeConditions ? `mode:${modeConditions.majorMode}` : '');

    const parsed = parseShortcut(shortcut);
    const entry = { source, parsed, callback, modeConditions };

    const entries = localShortcuts.get(shortcut) || [];

    if (modeConditions?.majorMode) {
      // Mode-conditional: add to array
      entries.push(entry);
    } else {
      // Non-conditional: find and replace any existing non-conditional entry
      const nonConditionalIndex = entries.findIndex(e => !e.modeConditions?.majorMode);
      if (nonConditionalIndex >= 0) {
        entries[nonConditionalIndex] = entry;
      } else {
        entries.push(entry);
      }
    }

    localShortcuts.set(shortcut, entries);
  }

  /**
   * Unregister a local shortcut.
   * If modeConditions provided, only removes matching entry; otherwise removes non-conditional entry.
   */
  function unregister(shortcut, source, modeConditions) {
    debug && console.log('[shortcuts] unregister', shortcut);

    const entries = localShortcuts.get(shortcut);
    if (!entries || entries.length === 0) {
      debug && console.log('[shortcuts] not registered:', shortcut);
      return;
    }

    const filtered = entries.filter(entry => {
      if (source && entry.source !== source) return true;
      if (modeConditions?.majorMode) {
        return entry.modeConditions?.majorMode !== modeConditions.majorMode;
      }
      return !!entry.modeConditions?.majorMode;
    });

    if (filtered.length > 0) {
      localShortcuts.set(shortcut, filtered);
    } else {
      localShortcuts.delete(shortcut);
    }
  }

  /**
   * Handle local shortcuts from a keyboard input event.
   * Returns true if shortcut was handled.
   * Mode-conditional shortcuts are checked first, falling back to non-conditional.
   *
   * @param {InputEvent} input
   * @param {number} [focusedWindowId]
   * @returns {boolean}
   */
  function handle(input, focusedWindowId) {
    // Only handle keyDown events
    if (input.type !== 'keyDown') return false;

    for (const [, entries] of localShortcuts) {
      for (const entry of entries) {
        if (inputMatchesShortcut(input, entry.parsed)) {
          if (entry.modeConditions?.majorMode) {
            if (focusedWindowId !== undefined && checkModeConditions) {
              const modeMatches = checkModeConditions(
                focusedWindowId,
                entry.modeConditions.majorMode
              );
              if (modeMatches) {
                entry.callback();
                return true;
              }
              continue;
            }
          } else {
            entry.callback();
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Unregister all shortcuts registered by a specific source address.
   */
  function unregisterAll(address) {
    for (const [shortcut, entries] of localShortcuts) {
      const filtered = entries.filter(entry => entry.source !== address);
      if (filtered.length > 0) {
        localShortcuts.set(shortcut, filtered);
      } else {
        localShortcuts.delete(shortcut);
      }
      if (entries.length !== filtered.length) {
        debug && console.log('[shortcuts] unregistered', shortcut, 'for', address);
      }
    }
  }

  /**
   * Clear all registered shortcuts.
   */
  function clear() {
    localShortcuts.clear();
  }

  return { register, unregister, handle, unregisterAll, clear };
}
