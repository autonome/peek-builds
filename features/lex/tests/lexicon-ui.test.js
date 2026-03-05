/**
 * Lexicon UI — Pure Function Unit Tests
 *
 * Tests for pure functions in lexicon-ui.js that don't require DOM or Electron APIs.
 * Run with: node --test extensions/lex/tests/lexicon-ui.test.js
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { nsidToFriendlyName, getRecordSchema, isRecordType } from '../lexicon-ui.js';

// ============================================================================
// nsidToFriendlyName
// ============================================================================

describe('nsidToFriendlyName', () => {
  describe('well-known NSIDs return hardcoded friendly names', () => {
    const knownMappings = {
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

    for (const [nsid, expected] of Object.entries(knownMappings)) {
      test(`${nsid} -> "${expected}"`, () => {
        assert.equal(nsidToFriendlyName(nsid), expected);
      });
    }
  });

  describe('unknown NSIDs get camelCase parsing fallback', () => {
    test('simple last segment is capitalized', () => {
      assert.equal(nsidToFriendlyName('com.example.thing'), 'Thing');
    });

    test('camelCase last segment is split into words', () => {
      assert.equal(nsidToFriendlyName('com.example.myCustomRecord'), 'My Custom Record');
    });

    test('already capitalized last segment stays capitalized', () => {
      assert.equal(nsidToFriendlyName('com.example.Record'), 'Record');
    });

    test('single-word lowercase last segment is capitalized', () => {
      assert.equal(nsidToFriendlyName('org.foo.bar.item'), 'Item');
    });

    test('multi-part camelCase is fully split', () => {
      assert.equal(nsidToFriendlyName('xyz.test.someVeryLongName'), 'Some Very Long Name');
    });

    test('two-segment NSID works', () => {
      assert.equal(nsidToFriendlyName('com.thing'), 'Thing');
    });

    test('single-segment NSID works (edge case)', () => {
      assert.equal(nsidToFriendlyName('post'), 'Post');
    });
  });
});

// ============================================================================
// getRecordSchema
// ============================================================================

describe('getRecordSchema', () => {
  test('returns record schema for record type lexicon', () => {
    const lexicon = {
      defs: {
        main: {
          type: 'record',
          record: {
            type: 'object',
            properties: {
              text: { type: 'string' },
            },
          },
        },
      },
    };
    const schema = getRecordSchema(lexicon);
    assert.deepEqual(schema, {
      type: 'object',
      properties: { text: { type: 'string' } },
    });
  });

  test('returns input schema for procedure type lexicon', () => {
    const lexicon = {
      defs: {
        main: {
          type: 'procedure',
          input: {
            encoding: 'application/json',
            schema: {
              type: 'object',
              properties: {
                repo: { type: 'string' },
              },
            },
          },
        },
      },
    };
    const schema = getRecordSchema(lexicon);
    assert.deepEqual(schema, {
      type: 'object',
      properties: { repo: { type: 'string' } },
    });
  });

  test('returns null for query type lexicon (no record/input)', () => {
    const lexicon = {
      defs: {
        main: {
          type: 'query',
          parameters: {
            type: 'params',
            properties: {
              actor: { type: 'string' },
            },
          },
        },
      },
    };
    assert.equal(getRecordSchema(lexicon), null);
  });

  test('returns null for null input', () => {
    assert.equal(getRecordSchema(null), null);
  });

  test('returns null for undefined input', () => {
    assert.equal(getRecordSchema(undefined), null);
  });

  test('returns null for empty defs', () => {
    assert.equal(getRecordSchema({ defs: {} }), null);
  });

  test('returns null for missing main def', () => {
    assert.equal(getRecordSchema({ defs: { other: { type: 'record' } } }), null);
  });

  test('returns null for record type with no record field', () => {
    const lexicon = {
      defs: {
        main: {
          type: 'record',
          // no record field
        },
      },
    };
    assert.equal(getRecordSchema(lexicon), null);
  });

  test('returns null for procedure with no input', () => {
    const lexicon = {
      defs: {
        main: {
          type: 'procedure',
          // no input
        },
      },
    };
    assert.equal(getRecordSchema(lexicon), null);
  });

  test('returns null for procedure with input but no schema', () => {
    const lexicon = {
      defs: {
        main: {
          type: 'procedure',
          input: {
            encoding: 'application/json',
            // no schema
          },
        },
      },
    };
    assert.equal(getRecordSchema(lexicon), null);
  });

  test('handles a real-world app.bsky.feed.post-like lexicon', () => {
    const lexicon = {
      lexicon: 1,
      id: 'app.bsky.feed.post',
      defs: {
        main: {
          type: 'record',
          description: 'Record containing a Bluesky post.',
          key: 'tid',
          record: {
            type: 'object',
            required: ['text', 'createdAt'],
            properties: {
              text: { type: 'string', maxLength: 300, maxGraphemes: 300 },
              createdAt: { type: 'string', format: 'datetime' },
              langs: { type: 'array', items: { type: 'string', format: 'language' } },
            },
          },
        },
      },
    };
    const schema = getRecordSchema(lexicon);
    assert.ok(schema);
    assert.equal(schema.type, 'object');
    assert.ok(schema.properties.text);
    assert.ok(schema.properties.createdAt);
    assert.deepEqual(schema.required, ['text', 'createdAt']);
  });
});

// ============================================================================
// isRecordType
// ============================================================================

describe('isRecordType', () => {
  test('returns true for record type lexicon', () => {
    const lexicon = { defs: { main: { type: 'record', record: {} } } };
    assert.equal(isRecordType(lexicon), true);
  });

  test('returns false for query type lexicon', () => {
    const lexicon = { defs: { main: { type: 'query' } } };
    assert.equal(isRecordType(lexicon), false);
  });

  test('returns false for procedure type lexicon', () => {
    const lexicon = { defs: { main: { type: 'procedure' } } };
    assert.equal(isRecordType(lexicon), false);
  });

  test('returns false for null', () => {
    assert.equal(isRecordType(null), false);
  });

  test('returns false for undefined', () => {
    assert.equal(isRecordType(undefined), false);
  });

  test('returns false for empty object', () => {
    assert.equal(isRecordType({}), false);
  });

  test('returns false for lexicon with empty defs', () => {
    assert.equal(isRecordType({ defs: {} }), false);
  });
});
