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
  resolveDecision as resolve,
  resolveWithStored,
} from '../../dist/main/permission-policy.js';

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
  it('prompts for geolocation — risky permission, user must approve', () => {
    assert.equal(
      resolve('https://example.com/map', 'geolocation'),
      'prompt',
    );
  });

  it('prompts for media (camera/mic) — risky permission', () => {
    assert.equal(resolve('https://meet.example.com/', 'media'), 'prompt');
  });

  it('prompts for midi and midiSysex', () => {
    assert.equal(resolve('https://piano.example.com/', 'midi'), 'prompt');
    assert.equal(resolve('https://piano.example.com/', 'midiSysex'), 'prompt');
  });

  it('prompts for display-capture (screen sharing)', () => {
    assert.equal(resolve('https://meet.example.com/', 'display-capture'), 'prompt');
  });

  it('allows notifications by default — common pattern, low risk', () => {
    assert.equal(resolve('https://news.example.com/', 'notifications'), 'allow');
  });

  it('allows clipboard read/write by default', () => {
    assert.equal(resolve('https://example.com/', 'clipboard-read'), 'allow');
    assert.equal(resolve('https://example.com/', 'clipboard-sanitized-write'), 'allow');
  });

  it('allows fullscreen, pointerLock, openExternal — common low-risk APIs', () => {
    assert.equal(resolve('https://example.com/', 'fullscreen'), 'allow');
    assert.equal(resolve('https://example.com/', 'pointerLock'), 'allow');
    assert.equal(resolve('https://example.com/', 'openExternal'), 'allow');
  });

  it('denies an unknown permission by default — fail-closed for new permission types', () => {
    assert.equal(
      resolve('https://example.com/', 'unknown'),
      'deny',
    );
  });

  it('denies hid, serial, usb by default — risky device APIs with no policy entry', () => {
    assert.equal(resolve('https://example.com/', 'hid'), 'deny');
    assert.equal(resolve('https://example.com/', 'serial'), 'deny');
    assert.equal(resolve('https://example.com/', 'usb'), 'deny');
  });
});

describe('permission-handler: about:blank / empty origins', () => {
  it('prompts for geolocation when the requesting URL is empty — same policy as web origins', () => {
    // Empty URL doesn't match chrome-extension:// or peek:// — falls through
    // to DEFAULT_POLICY. With no origin to attribute to, the prompt UI will
    // render '(unknown origin)' — the user can still choose to deny.
    assert.equal(resolve('', 'geolocation'), 'prompt');
  });
});

describe('permission-handler: resolveWithStored — policy + stored-decision interaction', () => {
  // Hard policy decisions ('allow', 'deny') must NEVER be overridden by a
  // stored decision. Otherwise a stale stored allow could keep granting
  // permissions to a permission type we just fail-closed in code.
  const lookupAlwaysAllow = () => true;
  const lookupAlwaysDeny = () => false;
  const lookupNothing = () => null;

  it('chrome-extension: stored deny is ignored — policy allow wins', () => {
    assert.equal(
      resolveWithStored('chrome-extension://abc/popup.html', 'geolocation', lookupAlwaysDeny),
      'allow',
    );
  });

  it('peek://: stored deny is ignored — policy allow wins', () => {
    assert.equal(
      resolveWithStored('peek://app/page/index.html', 'clipboard-read', lookupAlwaysDeny),
      'allow',
    );
  });

  it('hard-deny permission (e.g. usb): stored allow is ignored — policy deny wins', () => {
    assert.equal(
      resolveWithStored('https://example.com', 'usb', lookupAlwaysAllow),
      'deny',
    );
  });

  it('prompt permission with stored allow: returns allow', () => {
    assert.equal(
      resolveWithStored('https://example.com', 'geolocation', lookupAlwaysAllow),
      'allow',
    );
  });

  it('prompt permission with stored deny: returns deny', () => {
    assert.equal(
      resolveWithStored('https://example.com', 'geolocation', lookupAlwaysDeny),
      'deny',
    );
  });

  it('prompt permission with no stored decision: returns prompt', () => {
    assert.equal(
      resolveWithStored('https://example.com', 'geolocation', lookupNothing),
      'prompt',
    );
  });

  it('prompt permission with empty origin: skips lookup, returns prompt', () => {
    // No origin to attribute a stored decision to — there'd be no useful
    // identity to key off, so we don't even consult the lookup.
    let lookupCalled = false;
    const tracker = () => { lookupCalled = true; return true; };
    const decision = resolveWithStored('', 'geolocation', tracker);
    assert.equal(decision, 'prompt');
    assert.equal(lookupCalled, false, 'should not look up stored decision for empty origin');
  });

  it('lookup is only called for prompt decisions (not allow/deny)', () => {
    let lookupCalls = 0;
    const tracker = () => { lookupCalls++; return null; };

    // Hard allow path — lookup should NOT fire.
    resolveWithStored('chrome-extension://abc/popup.html', 'geolocation', tracker);
    assert.equal(lookupCalls, 0);

    // Hard deny path — lookup should NOT fire.
    resolveWithStored('https://example.com', 'usb', tracker);
    assert.equal(lookupCalls, 0);

    // Prompt path — lookup SHOULD fire.
    resolveWithStored('https://example.com', 'geolocation', tracker);
    assert.equal(lookupCalls, 1);
  });

  it('lookup receives the parsed origin (not the full URL)', () => {
    let receivedOrigin = null;
    let receivedPermission = null;
    const capturer = (origin, permission) => {
      receivedOrigin = origin;
      receivedPermission = permission;
      return null;
    };
    resolveWithStored('https://example.com/some/deep/path?query=1', 'geolocation', capturer);
    assert.equal(receivedOrigin, 'https://example.com');
    assert.equal(receivedPermission, 'geolocation');
  });
});
