/**
 * Unit tests for the pure helpers that power the
 * "<extension-name> options" chrome-extension command registration.
 *
 * These helpers live in chrome-extensions-helpers.ts precisely so they
 * can be imported without pulling in Electron-specific modules
 * (session, BrowserWindow, protocol handlers, thumbnails, etc.).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  sanitizeExtensionName,
  buildOptionsCommandName,
} from './chrome-extensions-helpers.js';

describe('sanitizeExtensionName', () => {
  it('returns the trimmed name unchanged when already clean', () => {
    assert.equal(sanitizeExtensionName('Proton Pass', 'proton-pass'), 'Proton Pass');
  });

  it('trims leading and trailing whitespace', () => {
    assert.equal(sanitizeExtensionName('  My Ext  ', 'my-ext'), 'My Ext');
  });

  it('collapses runs of internal whitespace to a single space', () => {
    assert.equal(sanitizeExtensionName('My   Ext\t\tName', 'id'), 'My Ext Name');
  });

  it('falls back to the extension id when the name is empty', () => {
    assert.equal(sanitizeExtensionName('', 'my-extension-id'), 'my-extension-id');
  });

  it('falls back to the extension id when the name is only whitespace', () => {
    assert.equal(sanitizeExtensionName('   \n  ', 'ext-id'), 'ext-id');
  });

  it('handles missing name input defensively', () => {
    // Runtime callers could pass undefined; we coerce via (rawName || '')
    assert.equal(sanitizeExtensionName(undefined as unknown as string, 'fallback-id'), 'fallback-id');
  });
});

describe('buildOptionsCommandName', () => {
  it('appends " options" to a clean extension name', () => {
    assert.equal(buildOptionsCommandName('AdBlock', 'adblock'), 'AdBlock options');
  });

  it('uses the sanitized name (whitespace collapsed + trimmed)', () => {
    assert.equal(buildOptionsCommandName('  Proton   Pass  ', 'proton-pass'), 'Proton Pass options');
  });

  it('falls back to the id when the display name is blank', () => {
    assert.equal(buildOptionsCommandName('', 'bitwarden'), 'bitwarden options');
  });

  it('produces distinct command names for distinct extensions', () => {
    const a = buildOptionsCommandName('Ext One', 'a');
    const b = buildOptionsCommandName('Ext Two', 'b');
    assert.notEqual(a, b);
  });

  it('always terminates with " options" so cmd names are predictable', () => {
    assert.ok(buildOptionsCommandName('foo', 'f').endsWith(' options'));
    assert.ok(buildOptionsCommandName('', 'id').endsWith(' options'));
  });
});
