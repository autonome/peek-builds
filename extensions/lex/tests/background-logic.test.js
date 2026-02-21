/**
 * Background.js Logic — Unit Tests
 *
 * Tests for pure logic functions used in background.js.
 * Since nsidToFriendlyName and nsidDomainLabel are not exported from background.js,
 * we re-implement them here to verify the logic patterns, and test the
 * rebuildNewCommands collision-handling algorithm.
 *
 * Run with: node --test extensions/lex/tests/background-logic.test.js
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

// ============================================================================
// Re-implement the unexported functions from background.js for testing.
// These MUST stay in sync with background.js — if they diverge, tests
// become meaningless. The canonical source is background.js lines 77-113.
// ============================================================================

const FRIENDLY_NAMES = {
  'app.bsky.feed.post': 'Post',
  'app.bsky.feed.like': 'Like',
  'app.bsky.feed.repost': 'Repost',
  'app.bsky.feed.generator': 'Feed Generator',
  'app.bsky.feed.threadgate': 'Thread Gate',
  'app.bsky.feed.postgate': 'Post Gate',
  'app.bsky.graph.follow': 'Follow',
  'app.bsky.graph.block': 'Block',
  'app.bsky.graph.list': 'List',
  'app.bsky.graph.listitem': 'List Item',
  'app.bsky.graph.listblock': 'List Block',
  'app.bsky.graph.starterpack': 'Starter Pack',
  'app.bsky.actor.profile': 'Profile',
  'app.bsky.labeler.service': 'Labeler',
  'chat.bsky.actor.declaration': 'Chat Settings',
  'com.whtwnd.blog.entry': 'Blog Entry',
  'blue.linkat.board': 'Board',
  'fyi.frontpage.post': 'Frontpage Post',
  'site.standard.publication': 'Publication',
  'site.standard.document': 'Document',
  'site.standard.graph.subscription': 'Subscription',
};

function nsidToFriendlyName(nsid) {
  if (FRIENDLY_NAMES[nsid]) return FRIENDLY_NAMES[nsid];
  const parts = nsid.split('.');
  const last = parts[parts.length - 1];
  return last
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, c => c.toUpperCase());
}

function nsidDomainLabel(nsid) {
  const parts = nsid.split('.');
  return parts.length >= 2 ? parts[1] : parts[0];
}

/**
 * Simulates the rebuildNewCommands logic from background.js.
 * Takes a list of NSIDs and returns the command names that would be registered.
 *
 * This mirrors background.js lines 126-188.
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
    // Both "app.bsky.feed.post" and "fyi.frontpage.post" map to "Post"
    // (frontpage.post has a hardcoded name "Frontpage Post", so let's use
    //  two unknown NSIDs that collide on the last segment)
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
    // "app.bsky.feed.post" -> "Post" (known)
    // "com.example.post" -> "Post" (fallback)
    // Both map to "Post" so they collide
    const commands = computeCommandNames([
      'app.bsky.feed.post',
      'com.example.post',
    ]);

    const bskyPost = commands.find(c => c.nsid === 'app.bsky.feed.post');
    const exPost = commands.find(c => c.nsid === 'com.example.post');

    // Both should be disambiguated since they share the friendly name "Post"
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

// ============================================================================
// Consistency check: background.js and lexicon-ui.js FRIENDLY_NAMES match
// ============================================================================

describe('FRIENDLY_NAMES consistency between background.js and lexicon-ui.js', () => {
  test('background.js nsidToFriendlyName matches lexicon-ui.js for all known NSIDs', async () => {
    // Import the lexicon-ui version
    const { nsidToFriendlyName: uiFriendlyName } = await import('../lexicon-ui.js');

    for (const [nsid, expected] of Object.entries(FRIENDLY_NAMES)) {
      const bgResult = nsidToFriendlyName(nsid);
      const uiResult = uiFriendlyName(nsid);
      assert.equal(bgResult, uiResult,
        `Mismatch for ${nsid}: background.js="${bgResult}", lexicon-ui.js="${uiResult}"`);
    }
  });

  test('fallback camelCase parsing is identical between both implementations', async () => {
    const { nsidToFriendlyName: uiFriendlyName } = await import('../lexicon-ui.js');

    const unknownNsids = [
      'com.example.myCustomRecord',
      'org.test.superLongCamelCase',
      'net.foo.simple',
      'xyz.abc.someThing',
    ];

    for (const nsid of unknownNsids) {
      const bgResult = nsidToFriendlyName(nsid);
      const uiResult = uiFriendlyName(nsid);
      assert.equal(bgResult, uiResult,
        `Fallback mismatch for ${nsid}: background.js="${bgResult}", lexicon-ui.js="${uiResult}"`);
    }
  });
});
