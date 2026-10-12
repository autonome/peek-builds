#!/usr/bin/env node
// Loads a Bergamot translator build (wasm + Emscripten glue) under plain Node,
// constructs one translation model from Remote Settings model files, and
// translates a sentence and a paragraph batch. Prints load and inference timings.
//
// Usage:
//   node tools/translate-spike/spike.mjs --engine firefox|npm \
//     --glue <glue.js> --wasm <engine.wasm> --model-dir <dir with model, lex, vocab>
//
// --engine firefox: Firefox's build (Remote Settings `translations-wasm`,
//   record `bergamot-translator`; glue `bergamot-translator.js` from Firefox
//   `toolkit/components/translations/bergamot-translator/`). The glue defines
//   `loadBergamot(Module)` and links the matrix-multiply imports itself,
//   falling back to the wasm's own implementation when `WebAssembly.mozIntGemm`
//   is absent.
// --engine npm: `@browsermt/bergamot-translator` (worker/bergamot-translator-worker.{js,wasm}).
//   The glue expects a global `Module` and leaves the `wasm_gemm` import to the
//   caller, so this script supplies it through `Module.instantiateWasm`.
//
// Model files are the decompressed attachments of `translations-models-v2`:
// `model` (*.intgemm.alphas.bin or *.intgemm8.bin), `lex`, `vocab`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    engine: { type: 'string' },
    glue: { type: 'string' },
    wasm: { type: 'string' },
    'model-dir': { type: 'string' },
    'model-name': { type: 'string', default: 'model.intgemm.alphas.bin' },
  },
});

for (const k of ['engine', 'glue', 'wasm', 'model-dir']) {
  if (!args[k]) {
    console.error(`missing --${k}`);
    process.exit(2);
  }
}

// Same names and wasm-heap alignments Firefox's translations-engine.worker.js uses.
const ALIGNMENTS = { model: 256, lex: 64, vocab: 64 };

const GEMM_TO_FALLBACK = {
  int8_prepare_a: 'int8PrepareAFallback',
  int8_prepare_b: 'int8PrepareBFallback',
  int8_prepare_b_from_transposed: 'int8PrepareBFromTransposedFallback',
  int8_prepare_b_from_quantized_transposed: 'int8PrepareBFromQuantizedTransposedFallback',
  int8_prepare_bias: 'int8PrepareBiasFallback',
  int8_multiply_and_add_bias: 'int8MultiplyAndAddBiasFallback',
  int8_select_columns_of_b: 'int8SelectColumnsOfBFallback',
};

const log = (...a) => console.log('[spike]', ...a);
const ms = (t0) => `${(performance.now() - t0).toFixed(0)} ms`;
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

function loadEngine(engine, gluePath, wasmPath) {
  const glue = readFileSync(gluePath, 'utf8');
  const wasmBinary = readFileSync(wasmPath);
  const printed = [];
  return new Promise((resolve, reject) => {
    const Module = {
      wasmBinary,
      INITIAL_MEMORY: 41_943_040,
      print: (s) => printed.push(String(s)),
      printErr: (s) => printed.push(`err: ${s}`),
      onAbort: (why) => reject(new Error(`abort: ${why}\n${printed.join('\n')}`)),
      onRuntimeInitialized: async () => {
        await Promise.resolve();
        resolve({ bergamot: Module, printed });
      },
    };
    if (engine === 'firefox') {
      // The glue is a single function declaration; evaluate it and call it.
      const loadBergamot = new Function(`${glue}\nreturn loadBergamot;`)();
      const result = loadBergamot(Module);
      // loadBergamot returns the same object it was given, with bindings attached.
      if (result !== Module) Object.assign(Module, result);
    } else if (engine === 'npm') {
      Module.instantiateWasm = (info, accept) => {
        const wasm_gemm = Object.fromEntries(
          Object.entries(GEMM_TO_FALLBACK).map(([k, name]) => [k, (...a) => Module.asm[name](...a)]),
        );
        WebAssembly.instantiate(wasmBinary, { ...info, wasm_gemm })
          .then(({ instance }) => accept(instance))
          .catch(reject);
        return {};
      };
      // The glue is top-level script code reading a `Module` binding.
      new Function('Module', `${glue}\nreturn Module;`)(Module);
    } else {
      reject(new Error(`unknown engine ${engine}`));
    }
  });
}

function configText(entries) {
  const indent = '            ';
  let out = '\n';
  for (const [k, v] of Object.entries(entries)) out += `${indent}${k}: ${v}\n`;
  return out + indent;
}

function aligned(bergamot, bytes, alignment) {
  const mem = new bergamot.AlignedMemory(bytes.byteLength, alignment);
  mem.getByteArrayView().set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return mem;
}

function buildModel(engine, bergamot, dir, modelName) {
  const model = aligned(bergamot, readFileSync(join(dir, 'model')), ALIGNMENTS.model);
  const lex = aligned(bergamot, readFileSync(join(dir, 'lex')), ALIGNMENTS.lex);
  const vocab = aligned(bergamot, readFileSync(join(dir, 'vocab')), ALIGNMENTS.vocab);
  const vocabs = new bergamot.AlignedMemoryList();
  vocabs.push_back(vocab);
  const config = configText({
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
  });
  if (engine === 'firefox') {
    // v0.6 signature: (src, tgt, config, model, lex, vocabs, qualityModel)
    return new bergamot.TranslationModel('en', 'de', config, model, lex, vocabs, null);
  }
  // v0.4 signature: (config, model, lex, vocabs, qualityModel)
  return new bergamot.TranslationModel(config, model, lex, vocabs, null);
}

function translate(bergamot, service, model, texts, html) {
  const messages = new bergamot.VectorString();
  const options = new bergamot.VectorResponseOptions();
  for (const t of texts) {
    messages.push_back(t);
    options.push_back({ qualityScores: false, alignment: true, html });
  }
  const responses = service.translate(model, messages, options);
  const out = [];
  for (let i = 0; i < responses.size(); i++) out.push(responses.get(i).getTranslatedText());
  messages.delete();
  options.delete();
  responses.delete();
  return out;
}

const SENTENCE = 'The weather is nice today, so we are going for a walk in the park.';
const HTML = '<p>Read the <a href="/docs">documentation</a> before you <b>install</b> the app.</p>';
const PARAGRAPHS = [
  'Machine translation is the use of software to translate text or speech from one language to another.',
  'On a basic level, it performs mechanical substitution of words in one language for words in another, but that alone rarely produces a good translation.',
  'Neural machine translation uses an artificial neural network to predict the likelihood of a sequence of words, typically modeling entire sentences in a single integrated model.',
  'Running the model on the device means that the text of a page never has to leave the computer.',
  'Small models trained with knowledge distillation can run at interactive speed on an ordinary laptop processor.',
];

const t0 = performance.now();
const { bergamot, printed } = await loadEngine(args.engine, args.glue, args.wasm);
log(`engine ${args.engine} initialized in ${ms(t0)}`);
for (const line of printed) log(`glue: ${line}`);

const t1 = performance.now();
const service = new bergamot.BlockingService({ cacheSize: 0 });
const model = buildModel(args.engine, bergamot, args['model-dir'], args['model-name']);
log(`model constructed in ${ms(t1)}`);

const t2 = performance.now();
const [first] = translate(bergamot, service, model, [SENTENCE], false);
log(`first sentence in ${ms(t2)}: ${first}`);

const t3 = performance.now();
const [html] = translate(bergamot, service, model, [HTML], true);
log(`html in ${ms(t3)}: ${html}`);

const words = PARAGRAPHS.join(' ').split(/\s+/).length;
const t4 = performance.now();
const outs = translate(bergamot, service, model, PARAGRAPHS, false);
const dt = performance.now() - t4;
log(`batch of ${PARAGRAPHS.length} paragraphs (${words} words) in ${dt.toFixed(0)} ms = ${((words * 1000) / dt).toFixed(0)} words/s`);
for (const o of outs) log(`  ${o}`);

const mem = process.memoryUsage();
log(`rss ${mb(mem.rss)}, arrayBuffers ${mb(mem.arrayBuffers)}`);
