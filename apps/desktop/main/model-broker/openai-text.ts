// Deliberately independent of the broker contract. No ambient/production fetch default.
export type OpenAITextConfig = {
  url: string;
  key: string;
  wireModel: string;
  text: string;
  maxOutputTokens: number;
};
export type OpenAITextUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};
export type OpenAITextResult = {
  outcome: 'completed' | 'truncated' | 'refused';
  usage: OpenAITextUsage | null;
};
export type OpenAITextFetch = (url: string, init: RequestInit) => Promise<Response>;
export type OpenAITextErrorCode = 'AUTH' | 'RATE_LIMIT' | 'REQUEST_REJECTED' |
  'PROVIDER' | 'TRANSPORT' | 'PROTOCOL' | 'LIMIT' | 'ABORTED' | 'TIMEOUT';

const INPUT_LIMIT = 16 * 1024;
const REQUEST_LIMIT = 24 * 1024;
const OUTPUT_LIMIT = 32 * 1024;
const WIRE_LIMIT = 256 * 1024;
const EVENT_LIMIT = 8 * 1024;
const DELTA_LIMIT = 4 * 1024;
function fail(code: OpenAITextErrorCode): never {
  const error = new Error(code);
  fixedErrors.add(error);
  throw error;
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

/** One POST, bounded SSE, and fixed errors only. URL/account authorization belongs to the host. */
export class OpenAITextAdapter {
  private readonly fetch: OpenAITextFetch;

  constructor(fetch: OpenAITextFetch) {
    if (typeof fetch !== 'function') throw new Error('REQUEST_REJECTED');
    this.fetch = fetch;
  }

  async run(
    config: OpenAITextConfig,
    signal: AbortSignal,
    onDelta: (text: string) => void,
  ): Promise<OpenAITextResult> {
    if (signal.aborted) fail('ABORTED');
    if (typeof config.url !== 'string' || typeof config.key !== 'string' || !config.key ||
        /[\r\n]/.test(config.key) || typeof config.wireModel !== 'string' || !config.wireModel ||
        typeof config.text !== 'string' || !Number.isSafeInteger(config.maxOutputTokens) ||
        config.maxOutputTokens < 1 || config.maxOutputTokens > 512) fail('REQUEST_REJECTED');
    if (bytes(config.text) > INPUT_LIMIT) fail('LIMIT');
    const body = JSON.stringify({
      model: config.wireModel,
      messages: [{ role: 'user', content: config.text }],
      max_tokens: config.maxOutputTokens,
      stream: true,
      stream_options: { include_usage: true },
    });
    if (bytes(body) > REQUEST_LIMIT) fail('LIMIT');

    const controller = new AbortController();
    let abortCode: OpenAITextErrorCode = 'ABORTED';
    let rejectAbort!: (reason: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    // The race also bounds injected transports which do not honor AbortSignal.
    const abort = (code: OpenAITextErrorCode) => {
      if (controller.signal.aborted) return;
      abortCode = code;
      controller.abort();
      rejectAbort(new Error(code));
    };
    const onAbort = () => abort('ABORTED');
    signal.addEventListener('abort', onAbort, { once: true });
    const startedAt = Date.now();
    const deadline = startedAt + 30_000;
    const headerDeadline = startedAt + 5_000;
    const totalTimer = setTimeout(() => abort('TIMEOUT'), 30_000);
    const headerTimer = setTimeout(() => abort('TIMEOUT'), 5_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let response: Response | undefined;
    const check = () => {
      if (controller.signal.aborted || signal.aborted) fail(abortCode);
      if (Date.now() >= deadline) { abort('TIMEOUT'); fail('TIMEOUT'); }
    };
    try {
      check();
      const pendingResponse = this.fetch(config.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.key}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'Accept-Encoding': 'identity',
        },
        body,
        redirect: 'error',
        credentials: 'omit',
        signal: controller.signal,
      }).then(result => {
        // A transport ignoring abort may still resolve after the caller has returned.
        if (controller.signal.aborted && result.body) void result.body.cancel().catch(() => {});
        return result;
      });
      response = await Promise.race([pendingResponse, aborted]);
      clearTimeout(headerTimer);
      check();
      if (Date.now() >= headerDeadline) fail('TIMEOUT');
      if (response.status !== 200) {
        if (response.status === 401 || response.status === 403) fail('AUTH');
        if (response.status === 429) fail('RATE_LIMIT');
        if (response.status >= 400 && response.status < 500) fail('REQUEST_REJECTED');
        if (response.status >= 500 && response.status < 600) fail('PROVIDER');
        fail('PROTOCOL');
      }
      if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'text/event-stream' ||
          !['', 'identity'].includes((response.headers.get('content-encoding') ?? '').trim().toLowerCase()) ||
          !response.body) fail('PROTOCOL');
      reader = response.body.getReader();
      let wireBytes = 0;
      let outputBytes = 0;
      let outcome: OpenAITextResult['outcome'] | null = null;
      let usage: OpenAITextUsage | null = null;
      let usageSeen = false;
      let done = false;
      const emit = (text: string) => {
        const size = bytes(text);
        if (outputBytes + size > OUTPUT_LIMIT) fail('LIMIT');
        outputBytes += size;
        // Split on Unicode scalar boundaries, not UTF-16 code units.
        let part = '';
        let partBytes = 0;
        for (const char of text) {
          const size = bytes(char);
          if (partBytes + size > DELTA_LIMIT) {
            check();
            onDelta(part);
            part = '';
            partBytes = 0;
          }
          part += char;
          partBytes += size;
        }
        if (part) { check(); onDelta(part); }
        check();
      };
      const event = (data: string) => {
        check();
        if (done) fail('PROTOCOL');
        if (data === '[DONE]') {
          if (!outcome) fail('PROTOCOL');
          done = true;
          return;
        }
        let chunk: unknown;
        try { chunk = JSON.parse(data); } catch { fail('PROTOCOL'); }
        if (!record(chunk) || 'error' in chunk || !Array.isArray(chunk.choices) || chunk.choices.length > 1) fail('PROTOCOL');
        const rejectExtensions = (object: Record<string, unknown>) => {
          if ('tool_calls' in object || 'function_call' in object || 'error' in object) fail('PROTOCOL');
          for (const key of Object.keys(object)) {
            const value = object[key];
            if (key.startsWith('reasoning') && value !== undefined && value !== null && value !== '' &&
                !(Array.isArray(value) && value.length === 0)) fail('PROTOCOL');
          }
        };
        rejectExtensions(chunk);
        if (chunk.usage !== undefined && chunk.usage !== null) {
          if (usageSeen || !record(chunk.usage)) fail('PROTOCOL');
          usageSeen = true;
          const fields = ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const;
          for (const key of fields) {
            const value = chunk.usage[key];
            if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) fail('PROTOCOL');
          }
          if (fields.every(key => chunk.usage && (chunk.usage as Record<string, unknown>)[key] !== undefined)) {
            usage = {
              promptTokens: chunk.usage.prompt_tokens as number,
              completionTokens: chunk.usage.completion_tokens as number,
              totalTokens: chunk.usage.total_tokens as number,
            };
          }
        }
        if (chunk.choices.length === 0) {
          if (chunk.usage === undefined || chunk.usage === null) fail('PROTOCOL');
          return;
        }
        const choice: unknown = chunk.choices[0];
        if (!record(choice) || (choice.index !== undefined && choice.index !== 0) || !record(choice.delta)) fail('PROTOCOL');
        const delta = choice.delta;
        rejectExtensions(choice);
        rejectExtensions(delta);
        if (delta.role !== undefined && delta.role !== 'assistant') fail('PROTOCOL');
        for (const key of ['content', 'refusal']) {
          const text = delta[key];
          if (text !== undefined && text !== null && typeof text !== 'string') fail('PROTOCOL');
          if (typeof text === 'string' && text.length) {
            if (outcome) fail('PROTOCOL');
            emit(text);
          }
        }
        const finish = choice.finish_reason;
        if (finish !== undefined && finish !== null) {
          if (outcome) fail('PROTOCOL');
          if (finish === 'stop') outcome = 'completed';
          else if (finish === 'length') outcome = 'truncated';
          else if (finish === 'content_filter') outcome = 'refused';
          else fail('PROTOCOL');
        }
      };

      // Count raw event bytes, including comments/ignored fields, before decoding or JSON.
      // A byte-at-a-time scanner avoids retaining an arbitrarily large transport chunk.
      let eventBytes = 0;
      let line: number[] = [];
      let data: string[] = [];
      let pendingCR = false;
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      let firstLine = true;
      const endLine = () => {
        let text: string;
        try { text = decoder.decode(new Uint8Array(line)); } catch { fail('PROTOCOL'); }
        line = [];
        if (firstLine && text.startsWith('\uFEFF')) text = text.slice(1);
        firstLine = false;
        if (text === '') {
          if (data.length) event(data.join('\n'));
          data = [];
          eventBytes = 0;
        } else if (!text.startsWith(':')) {
          const colon = text.indexOf(':');
          const field = colon < 0 ? text : text.slice(0, colon);
          let value = colon < 0 ? '' : text.slice(colon + 1);
          if (value.startsWith(' ')) value = value.slice(1);
          if (field === 'data') data.push(value);
        }
      };
      while (true) {
        const next = await Promise.race([reader.read(), aborted]);
        check();
        if (next.done) break;
        wireBytes += next.value.byteLength;
        if (wireBytes > WIRE_LIMIT) fail('LIMIT');
        for (const byte of next.value) {
          if (pendingCR) {
            pendingCR = false;
            if (byte === 10) {
              if (++eventBytes > EVENT_LIMIT) fail('LIMIT');
              endLine();
              continue;
            }
            endLine();
          }
          if (++eventBytes > EVENT_LIMIT) fail('LIMIT');
          if (byte === 13) pendingCR = true;
          else if (byte === 10) endLine();
          else line.push(byte);
        }
      }
      if (pendingCR) endLine();
      // SSE dispatch requires a blank line; EOF cannot manufacture a terminal event.
      if (line.length) {
        try { decoder.decode(new Uint8Array(line)); } catch { fail('PROTOCOL'); }
      }
      if (!done || line.length || data.length || !outcome) fail('PROTOCOL');
      return { outcome, usage };
    } catch (error) {
      if (controller.signal.aborted) fail(abortCode);
      // Only errors created here may cross the boundary; never provider/callback messages.
      if (error instanceof Error && fixedErrors.has(error)) throw error;
      return fail('TRANSPORT');
    } finally {
      clearTimeout(headerTimer);
      clearTimeout(totalTimer);
      signal.removeEventListener('abort', onAbort);
      // Do not await cancellation: an uncooperative injected reader cannot hold the deadline open.
      if (reader) { void reader.cancel().catch(() => {}); }
      else if (response?.body) { void response.body.cancel().catch(() => {}); }
      controller.abort();
    }
  }
}

// Identity, not message matching, prevents an injected transport from laundering raw errors.
const fixedErrors = new WeakSet<Error>();
