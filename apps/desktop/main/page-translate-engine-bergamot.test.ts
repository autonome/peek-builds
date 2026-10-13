/**
 * The Bergamot engine (page-translate/engine-bergamot.ts): first against a fake wasm module
 * (model reuse and eviction, pivoting, the html option, empty segments, cancel, missing files),
 * then, only when the worktree's `.tmp/real-download/` already holds the real engine wasm and
 * the es→en models, a real translation through a forked engine process. That last test never
 * downloads anything and skips otherwise; `PEEK_TRANSLATE_REAL_DIR` points it elsewhere.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { execFileSync, fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BERGAMOT_GLUE_PATH,
  createBergamotEngine,
  modelConfig,
  type BergamotModule,
  type BergamotVector,
  type ResponseOptions,
} from './page-translate/engine-bergamot.js';
import { ENGINE_WORKER_PATH } from './page-translate/engine-host.js';
import {
  ENGINE_MODE_ENV,
  engineStepsFromReady,
  type EngineResources,
  type EngineToHost,
  type HostToEngine,
} from './page-translate/engine-protocol.js';
import { EngineWorkerError } from './page-translate/engine-worker.js';

class FakeVector<T> {
  items: T[] = [];
  deleted = false;
  push_back(v: T) {
    this.items.push(v);
  }
  size() {
    return this.items.length;
  }
  get(i: number) {
    return this.items[i]!;
  }
  delete() {
    this.deleted = true;
  }
}

interface FakeModel {
  from: string;
  to: string;
  config: string;
  vocabs: number;
  deleted: boolean;
  delete(): void;
}

function fakeModule() {
  const log: string[] = [];
  const built: FakeModel[] = [];
  const optionsSeen: ResponseOptions[] = [];
  const respond = (texts: string[], tag: string) => {
    const v = new FakeVector<{ getTranslatedText(): string }>();
    for (const t of texts) v.push_back({ getTranslatedText: () => `${tag}(${t})` });
    return v;
  };
  const module = {
    AlignedMemory: class {
      view: Uint8Array;
      constructor(size: number) {
        this.view = new Uint8Array(size);
      }
      getByteArrayView() {
        return this.view;
      }
    },
    AlignedMemoryList: class {
      n = 0;
      push_back() {
        this.n++;
      }
    },
    BlockingService: class {
      translate(m: FakeModel, msgs: FakeVector<string>, opts: FakeVector<ResponseOptions>) {
        optionsSeen.push(...opts.items);
        log.push(`translate ${m.from}>${m.to} ${msgs.items.length}`);
        return respond(msgs.items, `${m.from}>${m.to}`);
      }
      translateViaPivoting(a: FakeModel, b: FakeModel, msgs: FakeVector<string>, opts: FakeVector<ResponseOptions>) {
        optionsSeen.push(...opts.items);
        log.push(`pivot ${a.from}>${a.to}>${b.to} ${msgs.items.length}`);
        return respond(msgs.items, `${a.from}>${a.to}>${b.to}`);
      }
      delete() {}
    },
    TranslationModel: class {
      deleted = false;
      vocabs: number;
      constructor(
        public from: string,
        public to: string,
        public config: string,
        _model: unknown,
        _lex: unknown,
        vocabs: { n: number },
      ) {
        this.vocabs = vocabs.n;
        built.push(this as unknown as FakeModel);
      }
      delete() {
        this.deleted = true;
      }
    },
    VectorString: FakeVector,
    VectorResponseOptions: FakeVector,
  } as unknown as BergamotModule;
  return { module, log, built, optionsSeen };
}

function step(from: string, to: string, extra: Record<string, string> = {}) {
  return { from, to, modelName: `model.${from}${to}.intgemm.alphas.bin`, files: { model: `/m/${from}${to}`, lex: `/l/${from}${to}`, vocab: `/v/${from}${to}`, ...extra } };
}

function request(from: string, to: string, segments: string[], resources?: EngineResources, signal = new AbortController().signal, isHTML = false) {
  return { from, to, segments, isHTML, signal, resources };
}

function engineWith(fake: ReturnType<typeof fakeModule>, extra: Parameters<typeof createBergamotEngine>[0] = {}) {
  let loads = 0;
  const engine = createBergamotEngine({
    loadRuntime: async () => {
      loads++;
      return fake.module;
    },
    readFile: () => new Uint8Array(4),
    yieldTurn: async () => {},
    ...extra,
  });
  return { engine, loads: () => loads };
}

async function rejectsCode(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof EngineWorkerError, `expected EngineWorkerError, got ${String(err)}`);
    assert.strictEqual(err.code, code);
    return true;
  });
}

describe('bergamot engine against a fake module', () => {
  it('translates through one model, builds it once and loads the runtime once', async () => {
    const fake = fakeModule();
    const { engine, loads } = engineWith(fake);
    const res = { wasmPath: '/e.wasm', steps: [step('es', 'en')] };
    assert.deepStrictEqual(await engine.translate(request('es', 'en', ['hola'], res)), ['es>en(hola)']);
    assert.deepStrictEqual(await engine.translate(request('es', 'en', ['adiós'], res)), ['es>en(adiós)']);
    assert.strictEqual(fake.built.length, 1);
    assert.strictEqual(loads(), 1);
    assert.match(fake.built[0]!.config, /gemm-precision: int8shiftAlphaAll/);
  });

  it('pivots through two models with translateViaPivoting', async () => {
    const fake = fakeModule();
    const { engine } = engineWith(fake);
    const res = { wasmPath: '/e.wasm', steps: [step('es', 'en'), step('en', 'de')] };
    assert.deepStrictEqual(await engine.translate(request('es', 'de', ['hola'], res)), ['es>en>de(hola)']);
    assert.deepStrictEqual(fake.log, ['pivot es>en>de 1']);
  });

  it('passes isHTML as the html response option', async () => {
    const fake = fakeModule();
    const { engine } = engineWith(fake);
    const res = { wasmPath: '/e.wasm', steps: [step('es', 'en')] };
    await engine.translate(request('es', 'en', ['<b>hola</b>'], res, undefined, true));
    assert.deepStrictEqual(fake.optionsSeen, [{ qualityScores: false, alignment: true, html: true }]);
  });

  it('returns blank segments unchanged without sending them, and batches the rest', async () => {
    const fake = fakeModule();
    const { engine } = engineWith(fake, { segmentsPerCall: 2 });
    const res = { wasmPath: '/e.wasm', steps: [step('es', 'en')] };
    const out = await engine.translate(request('es', 'en', ['a', ' ', 'b', '', 'c'], res));
    assert.deepStrictEqual(out, ['es>en(a)', ' ', 'es>en(b)', '', 'es>en(c)']);
    assert.deepStrictEqual(fake.log, ['translate es>en 2', 'translate es>en 1']);
  });

  it('a cancel between engine calls stops the request', async () => {
    const fake = fakeModule();
    const ctrl = new AbortController();
    const { engine } = engineWith(fake, { segmentsPerCall: 1, yieldTurn: async () => ctrl.abort() });
    const res = { wasmPath: '/e.wasm', steps: [step('es', 'en')] };
    await rejectsCode(engine.translate(request('es', 'en', ['a', 'b', 'c'], res, ctrl.signal)), 'aborted');
    assert.deepStrictEqual(fake.log, ['translate es>en 1']);
  });

  it('keeps the most recently used directions and frees the oldest', async () => {
    const fake = fakeModule();
    const { engine } = engineWith(fake, { maxWarmModels: 2 });
    for (const [f, t] of [['es', 'en'], ['de', 'en'], ['es', 'en'], ['fr', 'en']] as const) {
      await engine.translate(request(f, t, ['x'], { wasmPath: '/e.wasm', steps: [step(f, t)] }));
    }
    assert.deepStrictEqual(engine.warmDirections(), ['es>en', 'fr>en']);
    assert.deepStrictEqual(fake.built.map((m) => `${m.from}>${m.to}:${m.deleted}`), ['es>en:false', 'de>en:true', 'fr>en:false']);
  });

  it('a different wasm replaces the runtime and frees every model', async () => {
    const fake = fakeModule();
    const { engine, loads } = engineWith(fake);
    await engine.translate(request('es', 'en', ['x'], { wasmPath: '/3.0.wasm', steps: [step('es', 'en')] }));
    await engine.translate(request('es', 'en', ['x'], { wasmPath: '/3.1.wasm', steps: [step('es', 'en')] }));
    assert.strictEqual(loads(), 2);
    assert.deepStrictEqual(fake.built.map((m) => m.deleted), [true, false]);
  });

  it('reads split vocabularies and the int8 precision from the model name', async () => {
    const fake = fakeModule();
    const { engine } = engineWith(fake);
    const s = { ...step('zh', 'en'), modelName: 'model.zhen.intgemm8.bin', files: { model: '/m', lex: '/l', srcvocab: '/s', trgvocab: '/t' } };
    await engine.translate(request('zh', 'en', ['x'], { wasmPath: '/e.wasm', steps: [s] }));
    assert.strictEqual(fake.built[0]!.vocabs, 2);
    assert.match(fake.built[0]!.config, /gemm-precision: int8shiftAll\n/);
  });

  it('answers clear codes for missing resources, broken chains, unreadable files and a failed load', async () => {
    const fake = fakeModule();
    const { engine } = engineWith(fake);
    await rejectsCode(engine.translate(request('es', 'en', ['x'])), 'engine-unavailable');
    await rejectsCode(engine.translate(request('es', 'en', ['x'], { wasmPath: '/e.wasm', steps: [step('de', 'en')] })), 'bad-request');
    await rejectsCode(
      engine.translate(request('es', 'de', ['x'], { wasmPath: '/e.wasm', steps: [step('es', 'en'), step('fr', 'de')] })),
      'bad-request',
    );
    const noVocab = { ...step('es', 'en'), files: { model: '/m', lex: '/l' } };
    await rejectsCode(engine.translate(request('es', 'en', ['x'], { wasmPath: '/e.wasm', steps: [noVocab] })), 'model-files-missing');

    const unreadable = engineWith(fake, {
      readFile: () => {
        throw new Error('ENOENT');
      },
    });
    await rejectsCode(unreadable.engine.translate(request('es', 'en', ['x'], { wasmPath: '/e.wasm', steps: [step('es', 'en')] })), 'model-files-missing');

    let attempts = 0;
    const failing = createBergamotEngine({
      loadRuntime: async () => {
        attempts++;
        throw new Error('bad wasm');
      },
    });
    const res = { wasmPath: '/e.wasm', steps: [step('es', 'en')] };
    await rejectsCode(failing.translate(request('es', 'en', ['x'], res)), 'engine-load-failed');
    await rejectsCode(failing.translate(request('es', 'en', ['x'], res)), 'engine-load-failed');
    assert.strictEqual(attempts, 2, 'a failed load is retried on the next request');
  });

  it('the config matches the one Firefox builds', () => {
    const c = modelConfig('model.esen.intgemm.alphas.bin');
    assert.match(c, /^\n {12}beam-size: 1\n/);
    assert.match(c, /alignment: soft\n {12}$/);
  });

  it('engineStepsFromReady carries direction, model name and file paths', () => {
    const steps = engineStepsFromReady([
      {
        plan: { sourceLanguage: 'es', targetLanguage: 'en', files: { model: { name: 'model.esen.intgemm.alphas.bin' } } },
        files: { model: '/a/model', lex: '/a/lex', vocab: '/a/vocab' },
      },
    ]);
    assert.deepStrictEqual(steps, [
      { from: 'es', to: 'en', modelName: 'model.esen.intgemm.alphas.bin', files: { model: '/a/model', lex: '/a/lex', vocab: '/a/vocab' } },
    ]);
  });

  it('the vendored glue sits where the engine looks for it', () => {
    assert.ok(existsSync(BERGAMOT_GLUE_PATH), BERGAMOT_GLUE_PATH);
  });
});

// dist/main/<this file> → the worktree root is four levels up.
const REAL_DIR =
  process.env.PEEK_TRANSLATE_REAL_DIR ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../.tmp/real-download');
const REAL_WASM = path.join(REAL_DIR, 'engine/bergamot-translator/3.0/bergamot-translator.wasm');
const REAL_MODEL_DIR = path.join(REAL_DIR, 'models/es-en/base-memory/3.0');
const haveReal = ['model', 'lex', 'vocab'].every((f) => existsSync(path.join(REAL_MODEL_DIR, f))) && existsSync(REAL_WASM);

describe('bergamot engine with the real wasm and es→en models', () => {
  it('translates Spanish through a forked engine process', { skip: haveReal ? false : `no real engine files in ${REAL_DIR}` }, async (t) => {
    const child = fork(ENGINE_WORKER_PATH, [], {
      env: { ...process.env, [ENGINE_MODE_ENV]: '' },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const replies: EngineToHost[] = [];
    const waiters: Array<() => void> = [];
    child.on('message', (m) => {
      replies.push(m as EngineToHost);
      waiters.splice(0).forEach((w) => w());
    });
    const next = async (pred: (m: EngineToHost) => boolean): Promise<EngineToHost> => {
      for (;;) {
        const hit = replies.find(pred);
        if (hit) return hit;
        await new Promise<void>((r) => waiters.push(r));
      }
    };
    const send = (m: HostToEngine) => child.send(m);
    try {
      await next((m) => m.type === 'ready');
      const resources: EngineResources = {
        wasmPath: REAL_WASM,
        steps: [
          {
            from: 'es',
            to: 'en',
            modelName: 'model.esen.intgemm.alphas.bin',
            files: { model: path.join(REAL_MODEL_DIR, 'model'), lex: path.join(REAL_MODEL_DIR, 'lex'), vocab: path.join(REAL_MODEL_DIR, 'vocab') },
          },
        ],
      };
      const sentences = [
        'El tiempo está agradable hoy, así que vamos a dar un paseo por el parque.',
        'La traducción automática se ejecuta en el propio ordenador.',
        'Ningún texto de la página sale del dispositivo.',
      ];
      const t0 = performance.now();
      send({ type: 'translate', id: 1, from: 'es', to: 'en', segments: sentences, isHTML: false, resources });
      const first = await next((m) => m.type !== 'ready' && m.id === 1);
      const cold = performance.now() - t0;

      const t1 = performance.now();
      const html = '<p>Lee la <a href="/docs">documentación</a> antes de <b>instalar</b> la aplicación.</p>';
      send({ type: 'translate', id: 2, from: 'es', to: 'en', segments: [html], isHTML: true, resources });
      const second = await next((m) => m.type !== 'ready' && m.id === 2);
      const warm = performance.now() - t1;

      const rssKb = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8' }).trim());

      assert.strictEqual(first.type, 'result', JSON.stringify(first));
      assert.strictEqual(second.type, 'result', JSON.stringify(second));
      const out = first.type === 'result' ? first.translations : [];
      const outHtml = second.type === 'result' ? second.translations[0]! : '';
      t.diagnostic(`cold (runtime + model + 3 sentences): ${cold.toFixed(0)} ms; warm html: ${warm.toFixed(0)} ms; engine rss ${(rssKb / 1024).toFixed(0)} MB`);
      for (const s of out) t.diagnostic(`es→en: ${s}`);
      t.diagnostic(`es→en html: ${outHtml}`);

      assert.strictEqual(out.length, 3);
      assert.match(out[0]!, /weather/i);
      assert.match(out[0]!, /park/i);
      assert.match(outHtml, /<a href="\/docs">[^<]+<\/a>/);
      assert.match(outHtml, /<b>[^<]+<\/b>/);
    } finally {
      child.kill();
    }
  });
});
