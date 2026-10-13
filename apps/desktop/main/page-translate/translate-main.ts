/**
 * Electron wiring for page translation: one `translation-service.ts` service over the hybrid
 * page hosts, one lazily spawned engine process, the pubsub topics in `translate-topics.ts`,
 * and the models manager topics in `model-topics.ts`.
 *
 * Only web pages (http and https) are translatable; a window showing anything else answers as
 * having no page. A window's session ends through the hybrid registry's closed listener, so no
 * extra listener is added to the page's WebContents.
 */

import * as path from 'node:path';

import { getHybridContentWC, registerHybridWindowClosedListener } from '../hybrid-page-host-registry.js';
import { publish, subscribe, unsubscribe } from '../pubsub.js';
import { createEngineHost, electronSpawner } from './engine-host.js';
import { createModelProvider, type ModelProvider } from './model-provider.js';
import { installModelTopics } from './model-topics.js';
import { createTranslationService, pageFromWebContents, type TranslationService } from './translation-service.js';
import { installTranslateTopics, lazyEngine, statePayload, TRANSLATE_STATE_TOPIC, type LazyEngine } from './translate-topics.js';

const SOURCE = 'page-translate';

let service: TranslationService | null = null;
let engine: LazyEngine | null = null;
let models: Promise<ModelProvider> | null = null;
let teardown: Array<() => void> = [];

/** `<userData>/translations` holds the profile's catalogue and model cache. */
export const TRANSLATIONS_DIR = 'translations';

async function electronModelProvider(): Promise<ModelProvider> {
  const { app, net } = await import('electron');
  return createModelProvider({
    fetch: (url, init) => net.fetch(url, init),
    root: path.join(app.getPath('userData'), TRANSLATIONS_DIR),
  });
}

/**
 * The model provider over Electron's `net.fetch` and the profile's translations folder,
 * created on first use. `ensure` downloads, so its callers obtain consent first.
 */
export function pageTranslationModels(): Promise<ModelProvider> {
  models ??= electronModelProvider();
  return models;
}

function isWebPage(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

/** Starts page translation. Idempotent. */
export function initPageTranslation(): void {
  if (service) return;
  engine = lazyEngine(async () => createEngineHost({ spawn: await electronSpawner() }));
  const svc = createTranslationService({
    pageFor(windowId) {
      const wc = getHybridContentWC(windowId);
      return wc && isWebPage(wc.getURL()) ? pageFromWebContents(wc) : null;
    },
    engine,
    onState(windowId, state) {
      publish(SOURCE, TRANSLATE_STATE_TOPIC, statePayload(windowId, state));
    },
  });
  service = svc;
  teardown = [
    installTranslateTopics(svc, {
      subscribe: (topic, cb) => subscribe(SOURCE, topic, cb),
      unsubscribe: (topic) => {
        unsubscribe(SOURCE, topic);
      },
      publish: (topic, msg) => publish(SOURCE, topic, msg),
    }),
    registerHybridWindowClosedListener((windowId) => svc.closed(windowId)),
    installModelTopics(pageTranslationModels, {
      subscribe: (topic, cb) => subscribe(SOURCE, topic, cb),
      unsubscribe: (topic) => {
        unsubscribe(SOURCE, topic);
      },
      publish: (topic, msg) => publish(SOURCE, topic, msg),
    }).dispose,
  ];
}

/** The window's page started a new document; any translation of the old one is gone. */
export function pageTranslationNavigated(windowId: number): void {
  service?.navigated(windowId);
}

/** Ends every session and stops the engine process. Called on app quit. */
export function disposePageTranslation(): void {
  for (const fn of teardown) fn();
  teardown = [];
  service?.dispose();
  service = null;
  engine?.dispose();
  engine = null;
  models = null;
}
