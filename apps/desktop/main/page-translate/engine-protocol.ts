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

export interface TranslateMessage {
  type: 'translate';
  id: number;
  from: string;
  to: string;
  segments: string[];
  isHTML: boolean;
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
