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
import { createEngineProvider, type EngineProvider } from './engine-files.js';
import { createEngineHost, electronSpawner } from './engine-host.js';
import { engineModeFromEnv } from './engine-protocol.js';
import { createResourceResolver } from './engine-resources.js';
import { createModelProvider, type ModelProvider } from './model-provider.js';
import { installModelTopics } from './model-topics.js';
import {
  DECLARED_LANGUAGE_SCRIPT,
  PAGE_TRANSLATABLE_TOPIC,
  translatableLanguage,
  type PageTranslatablePayload,
} from './page-language.js';
import {
  createTranslationService,
  pageFromWebContents,
  TRANSLATE_WORLD_ID,
  type TranslationService,
} from './translation-service.js';
import { installTranslateTopics, lazyEngine, statePayload, TRANSLATE_STATE_TOPIC, type LazyEngine } from './translate-topics.js';

const SOURCE = 'page-translate';

let service: TranslationService | null = null;
let engine: LazyEngine | null = null;
let models: Promise<ModelProvider> | null = null;
let engineFiles: Promise<EngineProvider> | null = null;
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

async function electronEngineProvider(): Promise<EngineProvider> {
  const { app, net } = await import('electron');
  return createEngineProvider({
    fetch: (url, init) => net.fetch(url, init),
    root: path.join(app.getPath('userData'), TRANSLATIONS_DIR),
  });
}

/**
 * The engine wasm provider over the same fetch and folder as the models, created on first use.
 * `ensure` downloads, so its callers obtain consent first.
 */
export function pageTranslationEngineFiles(): Promise<EngineProvider> {
  engineFiles ??= electronEngineProvider();
  return engineFiles;
}

/** Starts page translation. Idempotent. */
export function initPageTranslation(): void {
  if (service) return;
  // The stub needs no files; Bergamot gets the engine and model paths with every request.
  const resources =
    engineModeFromEnv(process.env) === 'stub'
      ? undefined
      : createResourceResolver({ models: pageTranslationModels, engine: pageTranslationEngineFiles });
  engine = lazyEngine(async () =>
    createEngineHost({
      spawn: await electronSpawner(),
      resources: resources ? (from, to, signal) => resources.resolve(from, to, signal) : undefined,
    }),
  );
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
    }, pageTranslationEngineFiles).dispose,
  ];
}

/** The window's page started a new document; any translation of the old one is gone. */
export function pageTranslationNavigated(windowId: number): void {
  service?.navigated(windowId);
}

/**
 * The window's page finished loading. When the page declares a language other than the system
 * language, publishes `page:translatable {windowId, url, lang}`, which wakes the translate tile
 * so it can offer a translation. The declared language is read in the translator's isolated
 * world, so a page's own scripts cannot change what the read sees.
 */
export async function pageTranslationLoaded(windowId: number): Promise<void> {
  if (!service) return;
  const wc = getHybridContentWC(windowId);
  if (!wc || wc.isDestroyed()) return;
  const url = wc.getURL();
  if (!isWebPage(url)) return;
  let declared: unknown = null;
  try {
    declared = await wc.executeJavaScriptInIsolatedWorld(TRANSLATE_WORLD_ID, [{ code: DECLARED_LANGUAGE_SCRIPT }]);
  } catch {
    return;
  }
  // A navigation while the script ran makes the answer belong to a page that is gone.
  if (wc.isDestroyed() || wc.getURL() !== url) return;
  const { app } = await import('electron');
  const lang = translatableLanguage(declared, app.getLocale());
  if (!lang) return;
  publish(SOURCE, PAGE_TRANSLATABLE_TOPIC, { windowId, url, lang } satisfies PageTranslatablePayload);
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
  engineFiles = null;
}
