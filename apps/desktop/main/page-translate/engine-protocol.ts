/**
 * Messages between the engine host in main (`engine-host.ts`) and the engine process
 * (`engine-worker.ts`). Plain JSON-shaped objects, so they cross both Electron's
 * `utilityProcess` channel and Node's `child_process` IPC unchanged.
 */

export type EngineMode = 'stub' | 'bergamot';

/** Environment variable that selects the engine; anything but `stub` means Bergamot. */
export const ENGINE_MODE_ENV = 'PEEK_TRANSLATE_ENGINE';

/** Stub only: delay per segment in milliseconds, so tests can cancel mid-request. */
export const STUB_DELAY_ENV = 'PEEK_TRANSLATE_STUB_DELAY_MS';

export function engineModeFromEnv(env: Record<string, string | undefined>): EngineMode {
  return env[ENGINE_MODE_ENV] === 'stub' ? 'stub' : 'bergamot';
}

/** Model file kinds a direction can carry: `vocab`, or the `srcvocab` + `trgvocab` pair. */
export type EngineModelFile = 'model' | 'lex' | 'vocab' | 'srcvocab' | 'trgvocab';

/** One direction of a translation with its model files already on disk. */
export interface EngineStep {
  from: string;
  to: string;
  /** The model record's name; `*.intgemm8.bin` selects a different matrix-multiply precision. */
  modelName: string;
  files: Partial<Record<EngineModelFile, string>>;
}

/**
 * Everything on disk the Bergamot engine needs for one request: the engine wasm and one or two
 * directions (two when pivoting through English). Main resolves and downloads these, so the
 * engine process never touches the network or the catalogue.
 */
export interface EngineResources {
  wasmPath: string;
  steps: EngineStep[];
}

/** Turns `model-provider.ts ReadyStep`s into the steps a translate message carries. */
export function engineStepsFromReady(
  steps: Array<{
    plan: { sourceLanguage: string; targetLanguage: string; files: { model?: { name: string } } };
    files: Partial<Record<EngineModelFile, string>>;
  }>,
): EngineStep[] {
  return steps.map((s) => ({
    from: s.plan.sourceLanguage,
    to: s.plan.targetLanguage,
    modelName: s.plan.files.model?.name ?? '',
    files: { ...s.files },
  }));
}

export interface TranslateMessage {
  type: 'translate';
  id: number;
  from: string;
  to: string;
  segments: string[];
  isHTML: boolean;
  /** Required by the Bergamot engine, ignored by the stub. */
  resources?: EngineResources;
}

export interface CancelMessage {
  type: 'cancel';
  id: number;
}

export type HostToEngine = TranslateMessage | CancelMessage;

export interface ResultMessage {
  type: 'result';
  id: number;
  translations: string[];
}

export interface ErrorMessage {
  type: 'error';
  id: number;
  code: string;
  message: string;
}

/** Sent once when the process is ready to take requests. */
export interface ReadyMessage {
  type: 'ready';
  mode: EngineMode;
}

export type EngineToHost = ResultMessage | ErrorMessage | ReadyMessage;
