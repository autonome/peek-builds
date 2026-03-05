/**
 * Lex Command Logic — Unit Tests
 *
 * Tests for the command-building logic in home.js.
 * nsidToFriendlyName comes from lexicon-ui.js (single source of truth).
 * nsidDomainLabel and rebuildNewCommands logic live in home.js.
 *
 * Run with: node --test extensions/lex/tests/background-logic.test.js
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { nsidToFriendlyName } from '../lexicon-ui.js';

// ============================================================================
// Re-implement nsidDomainLabel from home.js for testing.
// ============================================================================

function nsidDomainLabel(nsid) {
  const parts = nsid.split('.');
  return parts.length >= 2 ? parts[1] : parts[0];
}

/**
 * Simulates the rebuildNewCommands logic from home.js.
 * Takes a list of NSIDs and returns the command names that would be registered.
 */
function computeCommandNames(allNsids) {
  const nameToNsids = new Map();
  for (const nsid of allNsids) {
    const friendly = nsidToFriendlyName(nsid);
    if (!nameToNsids.has(friendly)) {
      nameToNsids.set(friendly, []);
    }
    nameToNsids.get(friendly).push(nsid);
  }

  const commands = [];
  for (const nsid of allNsids) {
    const friendly = nsidToFriendlyName(nsid);
    const siblings = nameToNsids.get(friendly);
    let displayName;
    if (siblings.length > 1) {
      displayName = `${friendly} (${nsidDomainLabel(nsid)})`;
    } else {
      displayName = friendly;
    }
    commands.push({
      cmdName: `new ${displayName} — ${nsid}`,
      displayName,
      nsid,
    });
  }
  return commands;
}

// ============================================================================
// nsidDomainLabel
// ============================================================================

describe('nsidDomainLabel', () => {
  test('returns second segment for standard NSIDs', () => {
    assert.equal(nsidDomainLabel('app.bsky.feed.post'), 'bsky');
  });

  test('returns second segment for three-part NSID', () => {
    assert.equal(nsidDomainLabel('com.example.thing'), 'example');
  });

  test('returns second segment for community NSID', () => {
    assert.equal(nsidDomainLabel('fyi.frontpage.post'), 'frontpage');
  });

  test('returns first segment for single-part NSID', () => {
    assert.equal(nsidDomainLabel('post'), 'post');
  });

  test('returns second segment for two-part NSID', () => {
    assert.equal(nsidDomainLabel('com.thing'), 'thing');
  });
});

// ============================================================================
// rebuildNewCommands collision handling
// ============================================================================

describe('rebuildNewCommands collision handling', () => {
  test('unique friendly names get simple display names', () => {
    const commands = computeCommandNames([
      'app.bsky.feed.post',
      'app.bsky.graph.follow',
    ]);

    assert.equal(commands.length, 2);

    const postCmd = commands.find(c => c.nsid === 'app.bsky.feed.post');
    assert.equal(postCmd.displayName, 'Post');
    assert.equal(postCmd.cmdName, 'new Post — app.bsky.feed.post');

    const followCmd = commands.find(c => c.nsid === 'app.bsky.graph.follow');
    assert.equal(followCmd.displayName, 'Follow');
    assert.equal(followCmd.cmdName, 'new Follow — app.bsky.graph.follow');
  });

  test('colliding friendly names get domain label disambiguation', () => {
    const commands = computeCommandNames([
      'com.alpha.feed.widget',
      'org.beta.data.widget',
    ]);

    assert.equal(commands.length, 2);

    const alphaCmd = commands.find(c => c.nsid === 'com.alpha.feed.widget');
    assert.equal(alphaCmd.displayName, 'Widget (alpha)');
    assert.equal(alphaCmd.cmdName, 'new Widget (alpha) — com.alpha.feed.widget');

    const betaCmd = commands.find(c => c.nsid === 'org.beta.data.widget');
    assert.equal(betaCmd.displayName, 'Widget (beta)');
    assert.equal(betaCmd.cmdName, 'new Widget (beta) — org.beta.data.widget');
  });

  test('no collision when one NSID has known name and other does not', () => {
    const commands = computeCommandNames([
      'app.bsky.feed.post',
      'com.example.post',
    ]);

    const bskyPost = commands.find(c => c.nsid === 'app.bsky.feed.post');
    const exPost = commands.find(c => c.nsid === 'com.example.post');

    assert.equal(bskyPost.displayName, 'Post (bsky)');
    assert.equal(exPost.displayName, 'Post (example)');
  });

  test('empty input produces no commands', () => {
    const commands = computeCommandNames([]);
    assert.equal(commands.length, 0);
  });

  test('single NSID produces one command without disambiguation', () => {
    const commands = computeCommandNames(['com.example.myWidget']);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].displayName, 'My Widget');
    assert.equal(commands[0].cmdName, 'new My Widget — com.example.myWidget');
  });

  test('deduplication preserves order from input', () => {
    const nsids = [
      'app.bsky.feed.post',
      'app.bsky.feed.like',
      'app.bsky.graph.follow',
    ];
    const commands = computeCommandNames(nsids);
    assert.equal(commands[0].nsid, 'app.bsky.feed.post');
    assert.equal(commands[1].nsid, 'app.bsky.feed.like');
    assert.equal(commands[2].nsid, 'app.bsky.graph.follow');
  });

  test('three-way collision disambiguates all entries', () => {
    const commands = computeCommandNames([
      'com.alpha.item',
      'org.beta.item',
      'net.gamma.item',
    ]);

    assert.equal(commands.length, 3);
    assert.equal(commands[0].displayName, 'Item (alpha)');
    assert.equal(commands[1].displayName, 'Item (beta)');
    assert.equal(commands[2].displayName, 'Item (gamma)');
  });
});
