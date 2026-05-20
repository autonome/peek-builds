/**
 * Shared types for the Electron chrome-extension debugging harness.
 *
 * See tests/manual/harness/README.md for usage.
 */

import { ElectronApplication, Page } from '@playwright/test';

export interface TraceEvent {
  /** ms since harness start */
  t: number;
  kind: 'console' | 'pageerror' | 'request' | 'response' | 'response-body' | 'request-failed' | 'navigation' | 'runtime' | 'note';
  /** human label for the source page/webContents (e.g. "popup", "auth-window", "auth-window:webview") */
  source: string;
  /** kind-specific payload */
  data: any;
}

export interface RuntimeSnapshot {
  id: string | null;
  sendMessage: string;
  getURL: string;
  getManifest: string;
  onMessageExternal: string;
  keys: string[];
  hasChrome: boolean;
  hasBrowser: boolean;
}

export interface HarnessTrace {
  scenario: string;
  startedAt: string;
  endedAt: string;
  result: { ok: boolean; reason?: string };
  env: {
    profile: string;
    backend: string;
    redactedEnvKeys: string[];
  };
  events: TraceEvent[];
}

export interface Tracer {
  /** Record a console listener on a Page (top-level windows only — webview content is captured via CDP). */
  attachToPage(page: Page, sourceLabel: string): void;
  /** Capture a chrome.runtime snapshot from a Page or webview wrapper. */
  snapshotRuntime(page: Page, sourceLabel: string, opts?: { fromWebview?: string }): Promise<void>;
  /** Append an arbitrary event (notes, scenario milestones). */
  record(kind: TraceEvent['kind'], source: string, data: any): void;
  /** Tear down the CDP attachment and write the final trace to disk. */
  dump(result: { ok: boolean; reason?: string }): Promise<{ jsonPath: string; logPath: string }>;
}
