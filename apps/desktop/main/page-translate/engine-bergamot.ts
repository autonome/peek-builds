/**
 * The Bergamot engine inside the engine process (`engine-worker-main.ts`): loads Firefox's
 * Bergamot glue (`vendor/bergamot-translator.js`, MPL-2.0) and the downloaded wasm, builds one
 * `TranslationModel` per direction and keeps the most recently used ones warm, and translates
 * through one model or, for a pivot pair, through two with `translateViaPivoting` (as Firefox's
 * `translations-engine.worker.js` does, which keeps inline HTML aligned across both legs).
 *
 * Every file comes in with the request (`engine-protocol.ts EngineResources`), so this module
 * never reaches the network or the catalogue. The runtime and models are behind the
 * `loadRuntime` / `readFile` ports so tests can pass a fake module.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { EngineModelFile, EngineResources, EngineStep } from './engine-protocol.js';
import { EngineWorkerError, type WorkerEngine, type WorkerEngineRequest } from './engine-worker.js';

/** The vendored glue as the build lays it out next to this module (see `vendor/README.md`). */
export const BERGAMOT_GLUE_PATH = fileURLToPath(new URL('./vendor/bergamot-translator.js', import.meta.url));

/** Directions kept built; each holds ~30–60 MB of wasm heap, so older ones are freed. */
export const MAX_WARM_MODELS = 4;

/** Segments per engine call: large enough to batch well, small enough to notice a cancel. */
export const SEGMENTS_PER_CALL = 8;

/** Wasm-heap alignments per file kind, the ones Firefox's engine worker uses. */
const ALIGNMENTS: Record<EngineModelFile, number> = { model: 256, lex: 64, vocab: 64, srcvocab: 64, trgvocab: 64 };

/** Initial wasm heap, as in the spike; the heap grows as models are added. */
const INITIAL_MEMORY = 41_943_040;

interface Deletable {
  delete(): void;
}

export interface AlignedMemory {
  getByteArrayView(): Uint8Array;
}

export interface BergamotVector<T> extends Deletable {
  push_back(v: T): void;
  size(): number;
  get(i: number): T;
}

export interface BergamotResponse {
  getTranslatedText(): string;
}

export interface ResponseOptions {
  qualityScores: boolean;
  alignment: boolean;
  html: boolean;
}

export type TranslationModel = Deletable;

export interface BlockingService extends Deletable {
  translate(
    model: TranslationModel,
    messages: BergamotVector<string>,
    options: BergamotVector<ResponseOptions>,
  ): BergamotVector<BergamotResponse>;
  translateViaPivoting(
    first: TranslationModel,
    second: TranslationModel,
    messages: BergamotVector<string>,
    options: BergamotVector<ResponseOptions>,
  ): BergamotVector<BergamotResponse>;
}

/** The part of the Bergamot wasm module this engine uses. */
export interface BergamotModule {
  AlignedMemory: new (size: number, alignment: number) => AlignedMemory;
  AlignedMemoryList: new () => { push_back(m: AlignedMemory): void };
  BlockingService: new (opts: { cacheSize: number }) => BlockingService;
  TranslationModel: new (
    from: string,
    to: string,
    config: string,
    model: AlignedMemory,
    lex: AlignedMemory | null,
    vocabs: { push_back(m: AlignedMemory): void },
    qualityModel: null,
  ) => TranslationModel;
  VectorString: new () => BergamotVector<string>;
  VectorResponseOptions: new () => BergamotVector<ResponseOptions>;
}

/**
 * Evaluates the glue and starts the wasm. The glue is a bare `function loadBergamot(Module)`
 * with no export; passing `wasmBinary` keeps it from looking for the wasm on its own, and
 * without `WebAssembly.mozIntGemm` it links the wasm's own matrix multiply.
 */
export function loadBergamotRuntime(gluePath: string, wasmPath: string): Promise<BergamotModule> {
  const glue = readFileSync(gluePath, 'utf8');
  const wasmBinary = readFileSync(wasmPath);
  const errors: string[] = [];
  return new Promise((resolve, reject) => {
    const Module: Record<string, unknown> = {
      wasmBinary,
      INITIAL_MEMORY,
      print: () => {},
      printErr: (s: unknown) => errors.push(String(s)),
      onAbort: (why: unknown) => reject(new Error(`bergamot aborted: ${String(why)} ${errors.join('; ')}`.trim())),
      onRuntimeInitialized: () => {
        // The glue attaches its bindings after this callback returns.
        void Promise.resolve().then(() => resolve(Module as unknown as BergamotModule));
      },
    };
    try {
      const loadBergamot = new Function(`${glue}\nreturn loadBergamot;`)() as (m: object) => object;
      const result = loadBergamot(Module);
      if (result !== Module) Object.assign(Module, result);
    } catch (err) {
      reject(err);
    }
  });
}

/** The marian config text Firefox builds for every model. */
export function modelConfig(modelName: string): string {
  const entries: Record<string, string> = {
    'beam-size': '1',
    normalize: '1.0',
    'word-penalty': '0',
    'max-length-break': '128',
    'mini-batch-words': '1024',
    workspace: '128',
    'max-length-factor': '2.0',
    'skip-cost': 'true',
    'cpu-threads': '0',
    quiet: 'true',
    'quiet-translation': 'true',
    'gemm-precision': modelName.endsWith('intgemm8.bin') ? 'int8shiftAll' : 'int8shiftAlphaAll',
    alignment: 'soft',
  };
  const indent = '            ';
  let out = '\n';
  for (const [k, v] of Object.entries(entries)) out += `${indent}${k}: ${v}\n`;
  return out + indent;
}

export interface BergamotEngineOptions {
  gluePath?: string;
  loadRuntime?: (wasmPath: string) => Promise<BergamotModule>;
  readFile?: (path: string) => Uint8Array;
  maxWarmModels?: number;
  segmentsPerCall?: number;
  /** Lets queued messages (a cancel) arrive between engine calls; defaults to `setImmediate`. */
  yieldTurn?: () => Promise<void>;
}

export interface BergamotEngine extends WorkerEngine {
  /** Directions currently built, oldest first, as `from>to`; for tests. */
  warmDirections(): string[];
}

interface Runtime {
  wasmPath: string;
  module: BergamotModule;
  service: BlockingService;
}

function stepKey(step: EngineStep): string {
  return `${step.from}>${step.to}:${step.files.model ?? ''}`;
}

export function createBergamotEngine(opts: BergamotEngineOptions = {}): BergamotEngine {
  const gluePath = opts.gluePath ?? BERGAMOT_GLUE_PATH;
  const loadRuntime = opts.loadRuntime ?? ((wasmPath: string) => loadBergamotRuntime(gluePath, wasmPath));
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p));
  const maxWarm = Math.max(2, opts.maxWarmModels ?? MAX_WARM_MODELS);
  const perCall = Math.max(1, opts.segmentsPerCall ?? SEGMENTS_PER_CALL);
  const yieldTurn = opts.yieldTurn ?? (() => new Promise<void>((r) => setImmediate(r)));

  let runtime: Promise<Runtime> | null = null;
  let runtimeWasm: string | null = null;
  /** Insertion order is use order: a used model is moved to the end. */
  const models = new Map<string, TranslationModel>();

  function dropModels() {
    for (const m of models.values()) m.delete();
    models.clear();
  }

  function runtimeFor(wasmPath: string): Promise<Runtime> {
    if (runtime && runtimeWasm === wasmPath) return runtime;
    // A different wasm (a newer engine version) replaces the runtime and everything built in it.
    dropModels();
    runtimeWasm = wasmPath;
    const loading = loadRuntime(wasmPath).then((module) => ({
      wasmPath,
      module,
      // Caching is off, as in Firefox: the page side keeps its own cache of results.
      service: new module.BlockingService({ cacheSize: 0 }),
    }));
    runtime = loading;
    loading.catch(() => {
      if (runtime === loading) {
        runtime = null;
        runtimeWasm = null;
      }
    });
    return loading;
  }

  function aligned(module: BergamotModule, path: string, kind: EngineModelFile): AlignedMemory {
    let bytes: Uint8Array;
    try {
      bytes = readFile(path);
    } catch (err) {
      throw new EngineWorkerError('model-files-missing', `cannot read ${kind}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const mem = new module.AlignedMemory(bytes.byteLength, ALIGNMENTS[kind]);
    mem.getByteArrayView().set(bytes);
    return mem;
  }

  function build(module: BergamotModule, step: EngineStep): TranslationModel {
    const { files } = step;
    if (!files.model) throw new EngineWorkerError('model-files-missing', `no model file for ${step.from}→${step.to}`);
    const hasVocab = Boolean(files.vocab) || (Boolean(files.srcvocab) && Boolean(files.trgvocab));
    if (!hasVocab) throw new EngineWorkerError('model-files-missing', `no vocabulary for ${step.from}→${step.to}`);
    const model = aligned(module, files.model, 'model');
    const lex = files.lex ? aligned(module, files.lex, 'lex') : null;
    const vocabs = new module.AlignedMemoryList();
    if (files.vocab) vocabs.push_back(aligned(module, files.vocab, 'vocab'));
    else {
      vocabs.push_back(aligned(module, files.srcvocab!, 'srcvocab'));
      vocabs.push_back(aligned(module, files.trgvocab!, 'trgvocab'));
    }
    return new module.TranslationModel(step.from, step.to, modelConfig(step.modelName), model, lex, vocabs, null);
  }

  function modelsFor(module: BergamotModule, steps: EngineStep[]): TranslationModel[] {
    const keys = steps.map(stepKey);
    const out = steps.map((step, i) => {
      const key = keys[i]!;
      let m = models.get(key);
      if (m) models.delete(key);
      else m = build(module, step);
      models.set(key, m);
      return m;
    });
    for (const [key, m] of models) {
      if (models.size <= maxWarm) break;
      if (keys.includes(key)) continue;
      m.delete();
      models.delete(key);
    }
    return out;
  }

  function checkResources(req: WorkerEngineRequest): EngineResources {
    const res = req.resources;
    if (!res || !res.wasmPath || !Array.isArray(res.steps) || res.steps.length === 0) {
      throw new EngineWorkerError('engine-unavailable', 'no engine files were named for this request');
    }
    const { steps } = res;
    const chained =
      steps.length <= 2 &&
      steps[0]!.from === req.from &&
      steps[steps.length - 1]!.to === req.to &&
      steps.every((s, i) => i === 0 || steps[i - 1]!.to === s.from);
    if (!chained) {
      throw new EngineWorkerError('bad-request', `model steps do not translate ${req.from} into ${req.to}`);
    }
    return res;
  }

  function translateBatch(rt: Runtime, chain: TranslationModel[], texts: string[], html: boolean): string[] {
    const { module, service } = rt;
    const messages = new module.VectorString();
    const options = new module.VectorResponseOptions();
    let responses: BergamotVector<BergamotResponse> | null = null;
    try {
      for (const t of texts) {
        messages.push_back(t);
        options.push_back({ qualityScores: false, alignment: true, html });
      }
      responses =
        chain.length === 1
          ? service.translate(chain[0]!, messages, options)
          : service.translateViaPivoting(chain[0]!, chain[1]!, messages, options);
      const out: string[] = [];
      for (let i = 0; i < responses.size(); i++) out.push(responses.get(i).getTranslatedText());
      return out;
    } finally {
      messages.delete();
      options.delete();
      responses?.delete();
    }
  }

  return {
    async translate(req) {
      const res = checkResources(req);
      let rt: Runtime;
      try {
        rt = await runtimeFor(res.wasmPath);
      } catch (err) {
        throw new EngineWorkerError('engine-load-failed', err instanceof Error ? err.message : String(err));
      }
      if (req.signal.aborted) throw new EngineWorkerError('aborted', 'request cancelled');
      const chain = modelsFor(rt.module, res.steps);

      const out = req.segments.slice();
      // Empty text breaks the engine (as Firefox notes); such segments come back unchanged.
      const todo = req.segments.map((s, i) => (s.trim() === '' ? -1 : i)).filter((i) => i >= 0);
      for (let start = 0; start < todo.length; start += perCall) {
        if (req.signal.aborted) throw new EngineWorkerError('aborted', 'request cancelled');
        const idx = todo.slice(start, start + perCall);
        const got = translateBatch(rt, chain, idx.map((i) => req.segments[i]!), req.isHTML);
        if (got.length !== idx.length) {
          throw new EngineWorkerError('engine-failed', `engine returned ${got.length} translations for ${idx.length} segments`);
        }
        idx.forEach((i, k) => {
          out[i] = got[k]!;
        });
        if (start + perCall < todo.length) await yieldTurn();
      }
      return out;
    },
    warmDirections: () => [...models.keys()].map((k) => k.slice(0, k.indexOf(':'))),
  };
}
