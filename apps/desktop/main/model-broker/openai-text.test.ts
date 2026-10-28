import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { setImmediate as immediate } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { OpenAITextConfig, OpenAITextFetch } from './openai-text.js';

// Runs both directly with node --experimental-strip-types and after the desktop TS build.
const { OpenAITextAdapter } = await import(new URL(
  import.meta.url.endsWith('.ts') ? './openai-text.ts' : './openai-text.js', import.meta.url,
).href) as typeof import('./openai-text.js');
const encoder = new TextEncoder();
const config: OpenAITextConfig = {
  url: 'https://offline.invalid/exact/v1/chat/completions', key: 'fake-host-key',
  wireModel: 'operator-wire-model', text: 'Explicitly approved 🐦 text', maxOutputTokens: 128,
};
const chunk = (delta: unknown = {}, finish_reason: unknown = null) =>
  ({ choices: [{ index: 0, delta, finish_reason }] });
const sse = (value: unknown) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const finish = sse(chunk({}, 'stop'));
const done = sse('[DONE]');
const usage = { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 };
const errorCode = (code: string) => (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.equal(error.message, code);
  assert.equal(error.cause, undefined);
  return true;
};

function response(body: string | Uint8Array, sizes: number[] = []): Response {
  const bytes = typeof body === 'string' ? encoder.encode(body) : body;
  let offset = 0;
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const size = sizes[index++ % sizes.length] ?? bytes.length;
      controller.enqueue(bytes.slice(offset, offset += Math.min(size, bytes.length - offset)));
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}
async function run(body: string | Uint8Array, sizes?: number[]) {
  const deltas: string[] = [];
  const adapter = new OpenAITextAdapter(async () => response(body, sizes));
  const result = await adapter.run(config, new AbortController().signal, text => deltas.push(text));
  return { result, deltas };
}
async function fixture(t: TestContext, handle: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handle);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const url = `http://127.0.0.1:${address.port}/configured/exact?revision=fake`;
  let attempts = 0;
  const fetch: OpenAITextFetch = async (input, init) => {
    assert.equal(input, url, 'test must never contact a non-fixture destination');
    attempts++;
    return globalThis.fetch(input, init);
  };
  return { url, fetch, attempts: () => attempts };
}

test('loopback: exact configured destination, headers, body; fragmented SSE and usage', async t => {
  let requestBody = '';
  const f = await fixture(t, (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/configured/exact?revision=fake');
    assert.equal(req.headers.authorization, 'Bearer fake-host-key');
    assert.equal(req.headers['content-type'], 'application/json');
    assert.equal(req.headers.accept, 'text/event-stream');
    assert.equal(req.headers['accept-encoding'], 'identity');
    assert.equal(req.headers.cookie, undefined);
    req.on('data', data => { requestBody += data.toString(); });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      const body = encoder.encode(': comment\r\nid: ignored\r\nevent: message\r\ndata: {"choices":[{\r\ndata: "delta":{"role":"assistant","content":null}}]}\r\n\r\n' +
        sse(chunk({ content: 'Hello 🐦\n<script>untrusted()</script>' })) + finish +
        sse({ choices: [], usage }) + done);
      void (async () => {
        for (const byte of body) { res.write(Buffer.from([byte])); await immediate(); }
        res.end();
      })();
    });
  });
  const deltas: string[] = [];
  const adapter = new OpenAITextAdapter(async (url, init) => {
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.deepEqual(init.headers, {
      Authorization: 'Bearer fake-host-key', 'Content-Type': 'application/json',
      Accept: 'text/event-stream', 'Accept-Encoding': 'identity',
    });
    return f.fetch(url, init);
  });
  const result = await adapter.run({ ...config, url: f.url }, new AbortController().signal, text => deltas.push(text));
  assert.equal(requestBody, JSON.stringify({
    model: config.wireModel, messages: [{ role: 'user', content: config.text }],
    max_tokens: 128, stream: true, stream_options: { include_usage: true },
  }));
  assert.equal(deltas.join(''), 'Hello 🐦\n<script>untrusted()</script>');
  assert.deepEqual(result, { outcome: 'completed', usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 } });
  assert.equal(f.attempts(), 1);
});

test('arbitrary single-byte UTF-8 and CRLF splits, comments, multiline data and empty deltas', async () => {
  const body = ':🐦\r\nid: ignored\r\nevent: ignored\r\ndata: {"choices":[{\r\ndata: "delta":{"content":"é🐦"}}]}\r\n\r\n' +
    sse(chunk({ role: 'assistant' })) + sse(chunk({ content: null, reasoning_content: '' })) +
    sse(chunk()) + finish + done;
  for (const sizes of [[1], [2, 7, 1, 3], [65536]]) {
    assert.deepEqual(await run(body, sizes), { result: { outcome: 'completed', usage: null }, deltas: ['é🐦'] });
  }
  assert.equal((await run('\uFEFF' + finish + done, [1])).result.outcome, 'completed');
});

test('finish mapping, refusal display, missing/incomplete usage remains null', async () => {
  for (const [reason, outcome] of [['stop', 'completed'], ['length', 'truncated'], ['content_filter', 'refused']]) {
    const { result, deltas } = await run(sse(chunk({ refusal: 'Untrusted refusal' }, reason)) + done);
    assert.deepEqual(result, { outcome, usage: null });
    assert.deepEqual(deltas, ['Untrusted refusal']);
  }
  assert.equal((await run(finish + sse({ choices: [], usage: { prompt_tokens: 1 } }) + done)).result.usage, null);
  assert.equal((await run(sse({ ...chunk(), usage: null }) + sse({ ...chunk(), usage: null }) + finish + done)).result.usage, null);
  assert.deepEqual((await run(sse({ ...chunk({}, 'stop'), usage }) + done)).result.usage,
    { promptTokens: 3, completionTokens: 4, totalTokens: 7 });
});

test('malformed/unsupported wire is PROTOCOL, without raw provider details', async t => {
  const cases: Record<string, string> = {
    'missing finish': sse(chunk({ content: 'x' })) + done,
    'missing DONE': finish,
    'premature EOF': sse(chunk()),
    'unterminated DONE event': finish + 'data: [DONE]',
    'malformed JSON': sse('{fake-provider-secret'),
    'nonstream JSON': JSON.stringify({ choices: [{ message: { content: 'x' } }] }),
    'in-stream error': sse({ error: { message: 'fake-provider-secret' }, choices: [] }),
    'extra choices': sse({ choices: [{ delta: {} }, { delta: {} }] }),
    'bad index': sse({ choices: [{ index: 1, delta: {} }] }),
    'bad content': sse(chunk({ content: 123 })),
    'bad refusal': sse(chunk({ refusal: {} })),
    'bad role': sse(chunk({ role: 'tool' })),
    'bad delta': sse({ choices: [{ delta: null }] }),
    'missing choices': sse({ id: 'metadata' }),
    'empty nonusage chunk': sse({ choices: [] }),
    'tools': sse(chunk({ tool_calls: [] })),
    'usage-only tools': sse({ choices: [], usage, tool_calls: [] }),
    'usage-only reasoning': sse({ choices: [], usage, reasoning_content: 'hidden' }),
    'delta error': sse(chunk({ error: { message: 'fake-provider-secret' } })),
    'function': sse(chunk({ function_call: null })),
    'reasoning': sse(chunk({ reasoning_content: 'hidden' })),
    'reasoning array': sse(chunk({ reasoning_details: [{ text: 'hidden' }] })),
    'unsupported finish': sse(chunk({}, 'tool_calls')) + done,
    'content after finish': finish + sse(chunk({ content: 'late' })) + done,
    'refusal after finish': finish + sse(chunk({ refusal: 'late' })) + done,
    'duplicate finish': finish + finish + done,
    'conflicting finish': finish + sse(chunk({}, 'length')) + done,
    'duplicate DONE': finish + done + done,
    'data after DONE': finish + done + sse(chunk()),
    'duplicate usage': finish + sse({ choices: [], usage }) + sse({ choices: [], usage }) + done,
    'conflicting usage': finish + sse({ choices: [], usage }) + sse({ choices: [], usage: { ...usage, total_tokens: 8 } }) + done,
    'invalid usage': finish + sse({ choices: [], usage: 'fake-provider-secret' }) + done,
    'negative usage': sse({ ...chunk({}, 'stop'), usage: { ...usage, total_tokens: -1 } }) + done,
    'unsafe usage': sse({ ...chunk({}, 'stop'), usage: { ...usage, total_tokens: 2 ** 53 } }) + done,
    'fractional usage': sse({ ...chunk({}, 'stop'), usage: { ...usage, total_tokens: 1.5 } }) + done,
    'null usage value': sse({ ...chunk({}, 'stop'), usage: { ...usage, total_tokens: null } }) + done,
  };
  for (const [name, body] of Object.entries(cases)) {
    await t.test(name, async () => { await assert.rejects(run(body, [1, 19]), errorCode('PROTOCOL')); });
  }
});

test('fatal UTF-8, including ignored comments and partial codepoints at EOF', async () => {
  for (const invalid of [new Uint8Array([0xff, 10, 10]), new Uint8Array([58, 0xc0, 0xaf, 10, 10]), new Uint8Array([0xf0, 0x9f])]) {
    await assert.rejects(run(invalid, [1]), errorCode('PROTOCOL'));
  }
});

test('event, wire, output and delta limits, including discarded metadata', async () => {
  for (const body of [
    ':' + 'x'.repeat(8192) + '\n\n',
    'id: ' + 'x'.repeat(8192) + '\n\n',
    sse({ ignored: 'x'.repeat(8192), choices: [{ delta: {} }] }),
    (':' + 'x'.repeat(1020) + '\n\n').repeat(258),
    sse(chunk({ content: 'x'.repeat(4000) })).repeat(9) + finish + done,
  ]) await assert.rejects(run(body, [500, 1, 3000]), errorCode('LIMIT'));
  // Event limit counts CRLF bytes too, even when every CR/LF pair is split.
  await assert.rejects(run('id: x\r\n'.repeat(1171) + '\r\n', [1]), errorCode('LIMIT'));
  const text = '🐦'.repeat(1400);
  const { deltas } = await run(sse(chunk({ content: text })) + finish + done, [1]);
  assert.equal(deltas.join(''), text);
  assert.ok(deltas.every(delta => encoder.encode(delta).length <= 4096));
  assert.ok(deltas.every(delta => !delta.includes('\ufffd')));
  const exactOutput = sse(chunk({ content: 'x'.repeat(4096) })).repeat(8) + finish + done;
  assert.equal((await run(exactOutput)).deltas.join('').length, 32768);
  // A comment-only event can reach exactly 8192 raw bytes, not one more.
  await run(':' + 'x'.repeat(8189) + '\n\n' + finish + done, [1]);
  await assert.rejects(run(':' + 'x'.repeat(8190) + '\n\n' + finish + done, [1]), errorCode('LIMIT'));
  const remaining = 262144 - encoder.encode(finish + done).length;
  const repeats = Math.floor((remaining - 3) / 4);
  const padding = ':x\n\n'.repeat(repeats) + ':' + 'x'.repeat(remaining - repeats * 4 - 3) + '\n\n';
  // Use bounded comment events to consume the entire wire budget exactly.
  const wire = padding + finish + done;
  assert.equal(encoder.encode(wire).length, 262144);
  await run(wire);
  await assert.rejects(run(wire + '\n'), errorCode('LIMIT'));
});

test('local request bounds reject before a fetch attempt', async () => {
  let attempts = 0;
  const adapter = new OpenAITextAdapter(async () => { attempts++; return response(finish + done); });
  for (const [change, code] of [
    [{ text: '🐦'.repeat(4097) }, 'LIMIT'],
    [{ text: '\u0000'.repeat(5000) }, 'LIMIT'], // JSON escaping exceeds 24 KiB.
    [{ wireModel: 'x'.repeat(25000) }, 'LIMIT'],
    [{ maxOutputTokens: 513 }, 'REQUEST_REJECTED'],
    [{ maxOutputTokens: 0 }, 'REQUEST_REJECTED'],
    [{ maxOutputTokens: NaN }, 'REQUEST_REJECTED'],
    [{ maxOutputTokens: 1.5 }, 'REQUEST_REJECTED'],
    [{ key: 'fake\r\nInjected: header' }, 'REQUEST_REJECTED'],
  ] as const) {
    await assert.rejects(adapter.run({ ...config, ...change }, new AbortController().signal, () => {}), errorCode(code));
  }
  assert.equal(attempts, 0);
});

test('loopback statuses and unsupported response headers: fixed codes, one POST, no body exposure', async t => {
  for (const [status, code] of [[401, 'AUTH'], [403, 'AUTH'], [429, 'RATE_LIMIT'], [400, 'REQUEST_REJECTED'], [418, 'REQUEST_REJECTED'], [500, 'PROVIDER'], [503, 'PROVIDER'], [204, 'PROTOCOL']] as const) {
    await t.test(String(status), async t => {
      const f = await fixture(t, (_req, res) => { res.writeHead(status); res.end('fake-provider-secret'); });
      await assert.rejects(new OpenAITextAdapter(f.fetch).run({ ...config, url: f.url }, new AbortController().signal, () => {}), errorCode(code));
      assert.equal(f.attempts(), 1);
    });
  }
  for (const headers of [
    { 'content-type': 'application/json' },
    { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' },
    { 'content-type': 'text/event-stream', 'content-encoding': 'br' },
    { 'content-type': 'text/event-streamish' },
  ]) {
    let attempts = 0;
    await assert.rejects(new OpenAITextAdapter(async () => {
      attempts++; return new Response(finish + done, { headers: new Headers(Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) });
    }).run(config, new AbortController().signal, () => {}), errorCode('PROTOCOL'));
    assert.equal(attempts, 1);
  }
});

test('loopback redirect is never followed or retried', async t => {
  let contacts = 0;
  const f = await fixture(t, (_req, res) => {
    contacts++;
    res.writeHead(307, { Location: '/must-not-follow' });
    res.end('fake-provider-secret');
  });
  await assert.rejects(new OpenAITextAdapter(f.fetch).run({ ...config, url: f.url }, new AbortController().signal, () => {}), errorCode('TRANSPORT'));
  assert.equal(contacts, 1);
  assert.equal(f.attempts(), 1);
});

test('transport/TLS/reader/callback errors cannot leak or impersonate adapter errors', async () => {
  for (const message of ['TLS fake-key fake-prompt', 'AUTH', 'PROTOCOL']) {
    let attempts = 0;
    await assert.rejects(new OpenAITextAdapter(async () => {
      attempts++; throw new Error(message);
    }).run(config, new AbortController().signal, () => {}), errorCode('TRANSPORT'));
    assert.equal(attempts, 1);
  }
  await assert.rejects(new OpenAITextAdapter(async () => new Response(new ReadableStream({
    pull(controller) { controller.error(new Error('fake-reader-secret')); },
  }), { headers: { 'content-type': 'text/event-stream' } })).run(config, new AbortController().signal, () => {}), errorCode('TRANSPORT'));
  await assert.rejects(new OpenAITextAdapter(async () => response(sse(chunk({ content: 'x' })) + finish + done))
    .run(config, new AbortController().signal, () => { throw new Error('fake-callback-secret'); }), errorCode('TRANSPORT'));
});

test('pre-abort sends nothing; midstream abort suppresses late deltas and cancels reader', async () => {
  const controller = new AbortController();
  controller.abort(new Error('fake-abort-secret'));
  let attempts = 0;
  const adapter = new OpenAITextAdapter(async () => { attempts++; return response(finish + done); });
  await assert.rejects(adapter.run(config, controller.signal, () => {}), errorCode('ABORTED'));
  assert.equal(attempts, 0);
  const mid = new AbortController();
  let cancelled = false;
  const deltas: string[] = [];
  const streaming = new OpenAITextAdapter(async () => new Response(new ReadableStream({
    start(stream) { stream.enqueue(encoder.encode(sse(chunk({ content: 'first' })) + sse(chunk({ content: 'late' })) + finish + done)); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'text/event-stream' } }));
  await assert.rejects(streaming.run(config, mid.signal, text => { deltas.push(text); mid.abort(); }), errorCode('ABORTED'));
  assert.deepEqual(deltas, ['first']);
  assert.equal(cancelled, true);
});

test('late headers after sleep are rejected even before the timer callback runs', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  let resolve!: (value: Response) => void;
  const adapter = new OpenAITextAdapter(async () => new Promise<Response>(r => { resolve = r; }));
  const result = adapter.run(config, new AbortController().signal, () => { assert.fail('late output'); });
  const rejected = assert.rejects(result, errorCode('TIMEOUT'));
  t.mock.timers.setTime(Date.now() + 5001);
  resolve(response(finish + done));
  await rejected;
});

test('a fetch resolving after abort has its late body cancelled', async () => {
  let resolve!: (value: Response) => void;
  let cancelled = false;
  const controller = new AbortController();
  const adapter = new OpenAITextAdapter(async () => new Promise<Response>(r => { resolve = r; }));
  const result = adapter.run(config, controller.signal, () => { assert.fail('late output'); });
  const rejected = assert.rejects(result, errorCode('ABORTED'));
  controller.abort();
  await rejected;
  resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await immediate();
  assert.equal(cancelled, true);
});

test('headers and total deadline bound even uncooperative injected transports', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const hanging = new OpenAITextAdapter(async () => new Promise<Response>(() => {}));
  const headers = hanging.run(config, new AbortController().signal, () => {});
  const headerCheck = assert.rejects(headers, errorCode('TIMEOUT'));
  t.mock.timers.tick(5000);
  await headerCheck;

  let cancelled = false;
  const adapter = new OpenAITextAdapter(async () => new Response(new ReadableStream({
    pull() { return new Promise<void>(() => {}); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'text/event-stream' } }));
  const body = adapter.run(config, new AbortController().signal, () => {});
  const bodyCheck = assert.rejects(body, errorCode('TIMEOUT'));
  await immediate(); // Accept headers and clear their timer before advancing time.
  t.mock.timers.tick(30_000);
  await bodyCheck;
  assert.equal(cancelled, true);
});
