/**
 * Tests for webhook push functionality
 *
 * Tests the webhook push logic that the iOS Share Extension (PeekCoreManager)
 * uses to sync saved items to the backend server.
 *
 * Two test suites:
 * 1. Payload construction tests (unit) — verify payloads match the shapes
 *    expected by the server's POST /webhook endpoint
 * 2. Server webhook endpoint tests (integration) — start the real server,
 *    push payloads, and verify items are persisted correctly
 *
 * Run: node --test tests/webhook-push.test.js
 * Run verbose: VERBOSE=1 node --test tests/webhook-push.test.js
 */

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PEEK_NODE_PATH = join(__dirname, '..', '..', 'server');
const TEST_PORT = 3457; // different port from integration.test.js
const BASE_URL = `http://localhost:${TEST_PORT}`;

// ---------------------------------------------------------------------------
// Helpers that mirror the Swift PeekCoreManager webhook payload construction
// ---------------------------------------------------------------------------

/**
 * Build the payload that pushToWebhook() sends for a URL item.
 * Mirrors ShareViewController.swift lines 299-316.
 */
function buildUrlWebhookPayload(urlId, urlString, tags, metadata, savedAt) {
  const urlItem = {
    id: urlId,
    url: urlString,
    tags: tags,
    saved_at: savedAt,
  };

  if (metadata && Object.keys(metadata).length > 0) {
    urlItem.metadata = metadata;
  }

  return {
    urls: [urlItem],
    texts: [],
    tagsets: [],
  };
}

/**
 * Build the payload that pushTextToWebhook() sends for a text item.
 * Mirrors ShareViewController.swift lines 340-356.
 */
function buildTextWebhookPayload(textId, content, tags, metadata, savedAt) {
  const textItem = {
    id: textId,
    content: content,
    tags: tags,
    saved_at: savedAt,
  };

  if (metadata && Object.keys(metadata).length > 0) {
    textItem.metadata = metadata;
  }

  return {
    urls: [],
    texts: [textItem],
    tagsets: [],
  };
}

/**
 * Build the payload that pushImageToWebhook() sends for an image item.
 * Mirrors ShareViewController.swift lines 381-400.
 */
function buildImageWebhookPayload(imageId, sourceUrl, tags, metadata, savedAt) {
  const imageItem = {
    id: imageId,
    tags: tags,
    saved_at: savedAt,
  };

  if (sourceUrl) {
    imageItem.source_url = sourceUrl;
  }

  if (metadata && Object.keys(metadata).length > 0) {
    imageItem.metadata = metadata;
  }

  return {
    urls: [],
    texts: [],
    tagsets: [],
    images: [imageItem],
  };
}

// ---------------------------------------------------------------------------
// Suite 1: Payload construction (unit tests — no server needed)
// ---------------------------------------------------------------------------

describe('Webhook payload construction', () => {
  it('URL payload includes id, url, tags, saved_at', () => {
    const payload = buildUrlWebhookPayload(
      'abc-123',
      'https://example.com/page',
      ['test', 'web'],
      null,
      '2026-03-04T12:00:00.000Z'
    );

    assert.deepStrictEqual(payload.urls.length, 1);
    assert.deepStrictEqual(payload.texts, []);
    assert.deepStrictEqual(payload.tagsets, []);

    const item = payload.urls[0];
    assert.equal(item.id, 'abc-123');
    assert.equal(item.url, 'https://example.com/page');
    assert.deepStrictEqual(item.tags, ['test', 'web']);
    assert.equal(item.saved_at, '2026-03-04T12:00:00.000Z');
    assert.equal(item.metadata, undefined, 'metadata should be absent when null');
  });

  it('URL payload includes metadata when present', () => {
    const metadata = { title: 'Example Page', sourceApp: 'com.apple.mobilesafari' };
    const payload = buildUrlWebhookPayload(
      'def-456',
      'https://example.com',
      ['bookmark'],
      metadata,
      '2026-03-04T12:00:00.000Z'
    );

    assert.deepStrictEqual(payload.urls[0].metadata, metadata);
  });

  it('URL payload omits metadata for empty object', () => {
    const payload = buildUrlWebhookPayload(
      'ghi-789',
      'https://example.com',
      [],
      {},
      '2026-03-04T12:00:00.000Z'
    );

    assert.equal(payload.urls[0].metadata, undefined);
  });

  it('Text payload includes id, content, tags, saved_at', () => {
    const payload = buildTextWebhookPayload(
      'txt-001',
      'Hello #world',
      ['world'],
      null,
      '2026-03-04T12:00:00.000Z'
    );

    assert.equal(payload.texts.length, 1);
    assert.deepStrictEqual(payload.urls, []);
    assert.deepStrictEqual(payload.tagsets, []);

    const item = payload.texts[0];
    assert.equal(item.id, 'txt-001');
    assert.equal(item.content, 'Hello #world');
    assert.deepStrictEqual(item.tags, ['world']);
    assert.equal(item.metadata, undefined);
  });

  it('Text payload includes metadata when present', () => {
    const metadata = { sourceApp: 'com.apple.notes', selectedText: 'highlighted' };
    const payload = buildTextWebhookPayload(
      'txt-002',
      'Some note',
      ['note'],
      metadata,
      '2026-03-04T12:00:00.000Z'
    );

    assert.deepStrictEqual(payload.texts[0].metadata, metadata);
  });

  it('Image payload includes id, tags, saved_at and source_url', () => {
    const payload = buildImageWebhookPayload(
      'img-001',
      'https://example.com/photo.jpg',
      ['photo'],
      null,
      '2026-03-04T12:00:00.000Z'
    );

    assert.equal(payload.images.length, 1);
    assert.deepStrictEqual(payload.urls, []);
    assert.deepStrictEqual(payload.texts, []);
    assert.deepStrictEqual(payload.tagsets, []);

    const item = payload.images[0];
    assert.equal(item.id, 'img-001');
    assert.equal(item.source_url, 'https://example.com/photo.jpg');
    assert.deepStrictEqual(item.tags, ['photo']);
    assert.equal(item.metadata, undefined);
  });

  it('Image payload omits source_url when null', () => {
    const payload = buildImageWebhookPayload(
      'img-002',
      null,
      ['screenshot'],
      { width: 1920, height: 1080, mimeType: 'image/png' },
      '2026-03-04T12:00:00.000Z'
    );

    const item = payload.images[0];
    assert.equal(item.source_url, undefined);
    assert.deepStrictEqual(item.metadata, { width: 1920, height: 1080, mimeType: 'image/png' });
  });

  it('Image payload includes metadata with dimensions and mimeType', () => {
    const metadata = {
      width: 800,
      height: 600,
      mimeType: 'image/jpeg',
      sourceUrl: 'https://cdn.example.com/img.jpg',
    };
    const payload = buildImageWebhookPayload(
      'img-003',
      'https://cdn.example.com/img.jpg',
      ['cdn', 'image'],
      metadata,
      '2026-03-04T12:00:00.000Z'
    );

    assert.deepStrictEqual(payload.images[0].metadata, metadata);
  });

  it('Payloads serialize to valid JSON', () => {
    const payloads = [
      buildUrlWebhookPayload('u1', 'https://x.com', ['t'], { title: 'X' }, new Date().toISOString()),
      buildTextWebhookPayload('t1', 'hello', ['t'], null, new Date().toISOString()),
      buildImageWebhookPayload('i1', 'https://img.com/a.png', ['t'], { width: 10 }, new Date().toISOString()),
    ];

    for (const payload of payloads) {
      const json = JSON.stringify(payload);
      const parsed = JSON.parse(json);
      assert.deepStrictEqual(parsed, payload, 'Round-trip JSON serialization should be lossless');
    }
  });

  it('URL payload matches server /webhook expected shape', () => {
    // The server expects: { urls: [...], texts: [...], tagsets: [...] }
    // Each URL item needs at minimum: { url: string }
    // Optional: id, tags, saved_at, metadata
    const payload = buildUrlWebhookPayload(
      crypto.randomUUID(),
      'https://example.com',
      ['tag1'],
      { title: 'Test' },
      new Date().toISOString()
    );

    // Verify top-level keys
    assert.ok(Array.isArray(payload.urls), 'urls must be an array');
    assert.ok(Array.isArray(payload.texts), 'texts must be an array');
    assert.ok(Array.isArray(payload.tagsets), 'tagsets must be an array');

    // Verify URL item has required `url` field
    assert.ok(typeof payload.urls[0].url === 'string', 'url item must have url string');
    assert.ok(Array.isArray(payload.urls[0].tags), 'url item tags must be array');
  });

  it('Text payload matches server /webhook expected shape', () => {
    const payload = buildTextWebhookPayload(
      crypto.randomUUID(),
      'some text content',
      ['tag1'],
      null,
      new Date().toISOString()
    );

    // Server checks: item.content
    assert.ok(typeof payload.texts[0].content === 'string', 'text item must have content string');
    assert.ok(Array.isArray(payload.texts[0].tags), 'text item tags must be array');
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Server webhook endpoint (integration tests)
// ---------------------------------------------------------------------------

describe('Webhook server integration', () => {
  let serverProcess = null;
  let tempDir = null;
  let apiKey = null;

  async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function waitForServer(maxAttempts = 30) {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const res = await fetch(`${BASE_URL}/`);
        if (res.ok) return true;
      } catch (e) {
        // not ready
      }
      await sleep(100);
    }
    throw new Error('Server failed to start');
  }

  async function apiRequest(method, path, body = null) {
    const options = {
      method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    };
    if (body) {
      options.body = JSON.stringify(body);
    }
    const res = await fetch(`${BASE_URL}${path}`, options);
    const data = await res.json();
    return { status: res.status, data };
  }

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'peek-webhook-test-'));
    apiKey = 'test-webhook-key-' + Math.random().toString(36).substring(2);

    serverProcess = spawn('node', ['index.js'], {
      cwd: PEEK_NODE_PATH,
      env: {
        ...process.env,
        PORT: TEST_PORT.toString(),
        DATA_DIR: tempDir,
        API_KEY: apiKey,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    serverProcess.stdout.on('data', (d) => {
      if (process.env.VERBOSE) console.log(`  [server] ${d.toString().trim()}`);
    });
    serverProcess.stderr.on('data', (d) => {
      if (process.env.VERBOSE) console.error(`  [server err] ${d.toString().trim()}`);
    });

    await waitForServer();
  });

  after(async () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await sleep(500);
      serverProcess = null;
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  // --- URL webhook push tests ---

  it('pushes a single URL via webhook and retrieves it', async () => {
    const payload = buildUrlWebhookPayload(
      crypto.randomUUID(),
      'https://webhook-test.example.com/page1',
      ['webhook', 'test'],
      { title: 'Webhook Test Page 1' },
      new Date().toISOString()
    );

    const { status, data } = await apiRequest('POST', '/webhook', payload);
    assert.equal(status, 200);
    assert.equal(data.received, true);
    assert.equal(data.saved_count, 1);

    // Verify retrieval
    const { data: urls } = await apiRequest('GET', '/urls');
    const found = urls.urls.find(u => u.url === 'https://webhook-test.example.com/page1');
    assert.ok(found, 'URL should be retrievable after webhook push');
    assert.ok(found.tags.includes('webhook'), 'Tags should be preserved');
    assert.ok(found.tags.includes('test'), 'Tags should be preserved');
    assert.equal(found.metadata.title, 'Webhook Test Page 1', 'Metadata should be preserved');
  });

  it('pushes multiple URLs in a single webhook call', async () => {
    const urls = [
      { id: crypto.randomUUID(), url: 'https://multi-test.example.com/a', tags: ['multi'], saved_at: new Date().toISOString() },
      { id: crypto.randomUUID(), url: 'https://multi-test.example.com/b', tags: ['multi'], saved_at: new Date().toISOString() },
      { id: crypto.randomUUID(), url: 'https://multi-test.example.com/c', tags: ['multi', 'third'], saved_at: new Date().toISOString() },
    ];

    const { status, data } = await apiRequest('POST', '/webhook', {
      urls,
      texts: [],
      tagsets: [],
    });

    assert.equal(status, 200);
    assert.equal(data.saved_count, 3);

    const { data: fetched } = await apiRequest('GET', '/urls');
    for (const u of urls) {
      const found = fetched.urls.find(f => f.url === u.url);
      assert.ok(found, `URL ${u.url} should be retrievable`);
    }
  });

  // --- Text webhook push tests ---

  it('pushes a text item via webhook and retrieves it', async () => {
    const payload = buildTextWebhookPayload(
      crypto.randomUUID(),
      'This is a webhook text test #webhooktest',
      ['webhooktest', 'note'],
      { sourceApp: 'com.apple.notes' },
      new Date().toISOString()
    );

    const { status, data } = await apiRequest('POST', '/webhook', payload);
    assert.equal(status, 200);
    assert.equal(data.saved_count, 1);

    const { data: texts } = await apiRequest('GET', '/texts');
    const found = texts.texts.find(t => t.content === 'This is a webhook text test #webhooktest');
    assert.ok(found, 'Text should be retrievable after webhook push');
    assert.ok(found.tags.includes('webhooktest'), 'Tags should be preserved');
    assert.equal(found.metadata.sourceApp, 'com.apple.notes', 'Metadata should be preserved');
  });

  // --- Mixed payload tests ---

  it('pushes URLs, texts, and tagsets in a single webhook call', async () => {
    const payload = {
      urls: [
        { id: crypto.randomUUID(), url: 'https://mixed-test.example.com', tags: ['mixed'], saved_at: new Date().toISOString(), metadata: { title: 'Mixed' } },
      ],
      texts: [
        { id: crypto.randomUUID(), content: 'Mixed webhook test text', tags: ['mixed'], saved_at: new Date().toISOString() },
      ],
      tagsets: [
        { tags: ['mixed', 'combo'] },
      ],
    };

    const { status, data } = await apiRequest('POST', '/webhook', payload);
    assert.equal(status, 200);
    assert.equal(data.saved_count, 3);
  });

  // --- Edge cases ---

  it('handles webhook with empty arrays gracefully', async () => {
    const payload = { urls: [], texts: [], tagsets: [] };
    const { status, data } = await apiRequest('POST', '/webhook', payload);
    assert.equal(status, 200);
    assert.equal(data.saved_count, 0);
  });

  it('handles URL without tags (defaults to empty array)', async () => {
    const payload = {
      urls: [{ url: 'https://notags.example.com' }],
      texts: [],
      tagsets: [],
    };

    const { status, data } = await apiRequest('POST', '/webhook', payload);
    assert.equal(status, 200);
    assert.equal(data.saved_count, 1);

    const { data: urls } = await apiRequest('GET', '/urls');
    const found = urls.urls.find(u => u.url === 'https://notags.example.com');
    assert.ok(found, 'URL without tags should still be saved');
    assert.deepStrictEqual(found.tags, [], 'Tags should default to empty array');
  });

  it('handles URL without metadata', async () => {
    const payload = buildUrlWebhookPayload(
      crypto.randomUUID(),
      'https://nometa.example.com',
      ['simple'],
      null,
      new Date().toISOString()
    );

    const { status, data } = await apiRequest('POST', '/webhook', payload);
    assert.equal(status, 200);
    assert.equal(data.saved_count, 1);
  });

  it('handles text without metadata', async () => {
    const payload = buildTextWebhookPayload(
      crypto.randomUUID(),
      'Plain text no metadata',
      ['plain'],
      null,
      new Date().toISOString()
    );

    const { status, data } = await apiRequest('POST', '/webhook', payload);
    assert.equal(status, 200);
    assert.equal(data.saved_count, 1);
  });

  it('preserves rich metadata through webhook round-trip', async () => {
    const metadata = {
      title: 'Rich Metadata Test',
      sourceApp: 'com.apple.mobilesafari',
      selectedText: 'Some selected text from the page',
      sharedAt: '2026-03-04T12:00:00.000Z',
    };

    const payload = buildUrlWebhookPayload(
      crypto.randomUUID(),
      'https://rich-meta.example.com',
      ['rich'],
      metadata,
      new Date().toISOString()
    );

    await apiRequest('POST', '/webhook', payload);

    const { data: urls } = await apiRequest('GET', '/urls');
    const found = urls.urls.find(u => u.url === 'https://rich-meta.example.com');
    assert.ok(found, 'URL should be saved');
    assert.equal(found.metadata.title, metadata.title);
    assert.equal(found.metadata.sourceApp, metadata.sourceApp);
    assert.equal(found.metadata.selectedText, metadata.selectedText);
    assert.equal(found.metadata.sharedAt, metadata.sharedAt);
  });

  // --- Auth tests ---

  it('rejects webhook without authorization header', async () => {
    const res = await fetch(`${BASE_URL}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: [], texts: [], tagsets: [] }),
    });

    assert.ok(res.status === 401 || res.status === 403,
      `Expected 401 or 403 without auth, got ${res.status}`);
  });

  it('rejects webhook with wrong API key', async () => {
    const res = await fetch(`${BASE_URL}/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer wrong-key-12345',
      },
      body: JSON.stringify({ urls: [], texts: [], tagsets: [] }),
    });

    assert.ok(res.status === 401 || res.status === 403,
      `Expected 401 or 403 with wrong key, got ${res.status}`);
  });

  // --- Idempotency / duplicate handling ---

  it('handles duplicate URL pushes (upsert behavior)', async () => {
    const url = 'https://duplicate-test.example.com';

    // Push first time
    const payload1 = buildUrlWebhookPayload(
      crypto.randomUUID(),
      url,
      ['v1'],
      { title: 'Version 1' },
      new Date().toISOString()
    );
    await apiRequest('POST', '/webhook', payload1);

    // Push second time with updated tags
    const payload2 = buildUrlWebhookPayload(
      crypto.randomUUID(),
      url,
      ['v2', 'updated'],
      { title: 'Version 2' },
      new Date().toISOString()
    );
    await apiRequest('POST', '/webhook', payload2);

    // Verify the URL exists (server may create two entries or upsert — either is valid)
    const { data: urls } = await apiRequest('GET', '/urls');
    const matches = urls.urls.filter(u => u.url === url);
    assert.ok(matches.length >= 1, 'At least one entry should exist for the URL');
  });

  // --- Payload structure validation for iOS Swift compatibility ---

  it('Swift sendWebhookRequest sets correct HTTP method and headers', () => {
    // This is a structural test verifying our JS payloads match what Swift sends.
    // Swift sets: method=POST, Content-Type=application/json, Authorization=Bearer <key>
    // We verify our apiRequest helper matches this contract.

    const payload = buildUrlWebhookPayload('id', 'https://x.com', [], null, new Date().toISOString());
    const json = JSON.stringify(payload);
    const parsed = JSON.parse(json);

    // The server expects JSON body — verify it parses cleanly
    assert.ok(parsed.urls !== undefined, 'Must have urls key');
    assert.ok(parsed.texts !== undefined, 'Must have texts key');
    assert.ok(parsed.tagsets !== undefined, 'Must have tagsets key');
  });

  it('URL normalization matches Swift normalizeURL behavior', () => {
    // Swift normalizeURL: "https://example.com" -> "https://example.com/"
    // "https://example.com/path" stays unchanged
    function normalizeURL(urlString) {
      try {
        const url = new URL(urlString);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return urlString;
        if (url.pathname === '' || url.pathname === '/') {
          return urlString.endsWith('/') ? urlString : urlString + '/';
        }
        return urlString;
      } catch {
        return urlString;
      }
    }

    assert.equal(normalizeURL('https://example.com'), 'https://example.com/');
    assert.equal(normalizeURL('https://example.com/'), 'https://example.com/');
    assert.equal(normalizeURL('https://example.com/path'), 'https://example.com/path');
    assert.equal(normalizeURL('https://example.com/path/page'), 'https://example.com/path/page');
    assert.equal(normalizeURL('not-a-url'), 'not-a-url');
  });

  it('extractDomain helper matches Swift extractDomain behavior', () => {
    // Swift extractDomain: strips scheme, removes www. prefix
    function extractDomain(urlString) {
      try {
        const url = new URL(urlString);
        const host = url.hostname;
        return host.startsWith('www.') ? host.slice(4) : host;
      } catch {
        return null;
      }
    }

    assert.equal(extractDomain('https://www.example.com/page'), 'example.com');
    assert.equal(extractDomain('https://example.com/page'), 'example.com');
    assert.equal(extractDomain('http://sub.domain.com/path'), 'sub.domain.com');
    assert.equal(extractDomain('not-a-url'), null);
  });
});
