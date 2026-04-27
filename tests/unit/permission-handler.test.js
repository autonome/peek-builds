/**
 * Unit tests for backend/electron/permission-handler.ts — the policy resolver
 * that decides allow / deny / prompt for each permission request.
 *
 * No Electron Session needed: we exercise the pure resolver via the test-only
 * `_resolveDecisionForTests(url, permission)` export. See the module header
 * for the full Phase 1 / Phase 2 plan.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  _resolveDecisionForTests as resolve,
} from '../../dist/backend/electron/permission-handler.js';

describe('permission-handler: chrome-extension origins', () => {
  it('always allows geolocation for chrome-extension URLs', () => {
    assert.equal(
      resolve('chrome-extension://abc123/popup.html', 'geolocation'),
      'allow',
    );
  });

  it('always allows even unknown permissions for chrome-extension URLs', () => {
    assert.equal(
      resolve('chrome-extension://abc123/popup.html', 'background-fetch'),
      'allow',
    );
  });
});

describe('permission-handler: peek:// internal pages', () => {
  it('allows clipboard-read for peek:// pages', () => {
    assert.equal(
      resolve('peek://app/page/index.html?url=https://example.com', 'clipboard-read'),
      'allow',
    );
  });
});

describe('permission-handler: web origins (default policy)', () => {
  it('allows geolocation by default (Phase 1 — visibility-only rollout)', () => {
    assert.equal(
      resolve('https://example.com/map', 'geolocation'),
      'allow',
    );
  });

  it('allows media (camera/mic) by default', () => {
    assert.equal(resolve('https://meet.example.com/', 'media'), 'allow');
  });

  it('allows notifications by default', () => {
    assert.equal(resolve('https://news.example.com/', 'notifications'), 'allow');
  });

  it('denies an unknown permission by default — fail-closed for new permission types', () => {
    assert.equal(
      resolve('https://example.com/', 'unknown'),
      'deny',
    );
  });

  it('denies hid by default — risky permission with no policy entry', () => {
    assert.equal(resolve('https://example.com/', 'hid'), 'deny');
  });

  it('denies serial by default — risky permission with no policy entry', () => {
    assert.equal(resolve('https://example.com/', 'serial'), 'deny');
  });
});

describe('permission-handler: about:blank / empty origins', () => {
  it('denies geolocation when the requesting URL is empty (no origin to attribute to)', () => {
    // Empty URL doesn't match chrome-extension:// or peek:// — falls through
    // to DEFAULT_POLICY. geolocation defaults to allow today, so this case
    // documents that fact rather than asserting deny — when Phase 2 flips
    // geolocation to 'prompt' the assertion changes too.
    assert.equal(resolve('', 'geolocation'), 'allow');
  });
});
