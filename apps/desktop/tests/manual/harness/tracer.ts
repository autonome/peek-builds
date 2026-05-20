/**
 * CDP-based tracer for the harness.
 *
 * Why CDP and not Playwright's page.on('request')?
 *   - Playwright's network events fire only for the top-level Page's
 *     webContents. Peek's chrome-extension flows happen inside <webview>
 *     elements, which are *separate* webContents that Playwright doesn't see
 *     as Pages.
 *   - Electron's `webContents.debugger` (CDP) is per-webContents and can be
 *     attached from the main process to every existing and newly-created
 *     webContents — popup, host page, embedded webview, extension service
 *     worker. That covers everything we care about.
 *
 * Architecture:
 *   1. start():
 *      - calls electronApp.evaluate(...) to install a main-process tap that
 *        attaches `webContents.debugger` to every existing webContents and
 *        listens for `app.on('web-contents-created')` to catch new ones.
 *      - the tap appends raw CDP messages + per-wc metadata to a JSONL file
 *        in tmp/harness/.
 *   2. While the scenario runs, the harness collects in-memory events from
 *      the Playwright side too (page-level console, pageerror, scenario
 *      milestones via record()).
 *   3. dump():
 *      - calls electronApp.evaluate(...) again to detach debuggers,
 *      - reads the JSONL file,
 *      - translates CDP events to canonical TraceEvent objects,
 *      - merges with in-memory events, sorts by t,
 *      - writes a final structured JSON + a flat .log companion to tmp/harness/.
 *
 * The JSONL is left on disk (intentionally) — it's the raw record, useful
 * if the post-processing has a bug.
 */

import fs from 'fs';
import path from 'path';
import { Page } from '@playwright/test';
import { DesktopApp } from '../../fixtures/desktop-app';
import { HarnessTrace, Tracer, TraceEvent, RuntimeSnapshot } from './types';

interface TracerOpts {
  app: DesktopApp;
  scenarioName: string;
  tmpDir: string;
  profile: string;
  backend: string;
  redactedEnvKeys: string[];
}

interface RawCdpLine {
  t: number;
  wcId: number;
  kind: string;
  method?: string;
  params?: any;
  info?: { id: number; type: string; url: string };
  url?: string;
  error?: string;
  body?: string;
  base64Encoded?: boolean;
  requestId?: string;
}

export async function startTracer(opts: TracerOpts): Promise<Tracer> {
  fs.mkdirSync(opts.tmpDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = `${opts.scenarioName}-${ts}`;
  const jsonlPath = path.join(opts.tmpDir, `${baseName}.jsonl`);
  const jsonPath = path.join(opts.tmpDir, `${baseName}.json`);
  const logPath = path.join(opts.tmpDir, `${baseName}.log`);

  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const inMemory: TraceEvent[] = [];
  const wcLabels = new Map<number, string>();

  const record = (kind: TraceEvent['kind'], source: string, data: any) => {
    inMemory.push({ t: Date.now() - startedAt, kind, source, data });
  };

  if (!opts.app.evaluateMain) {
    throw new Error('[harness] tracer requires Electron backend (DesktopApp.evaluateMain).');
  }

  // Main-process tap: attaches CDP debugger to all current + future webContents
  // and buffers events on a globalThis array. We can't import fs here
  // (evaluateMain has no import callback registered), so we periodically
  // drain via evaluateMain from the test side — see startPeriodicDrain below.
  await opts.app.evaluateMain(async ({ app, webContents, session }: any, args: any) => {
    const g: any = globalThis as any;
    if (g.__peekHarnessBuffer) return; // already attached this run
    const buf: any[] = [];
    g.__peekHarnessBuffer = buf;
    const pushAndStream = (obj: any) => buf.push(obj);

    // Tap main-process stdout/stderr — captures console.log/error from
    // backend/electron/* including our [peek:runtime-external:main] logs,
    // which tell us which BG-dispatch error path is being hit.
    const _origStdoutWrite = process.stdout.write.bind(process.stdout);
    const _origStderrWrite = process.stderr.write.bind(process.stderr);
    (process.stdout as any).write = (chunk: any, ...rest: any[]) => {
      try {
        const s = typeof chunk === 'string' ? chunk : chunk?.toString?.() ?? String(chunk);
        pushAndStream({ t: Date.now(), wcId: -1, kind: 'main-stdout', text: s });
      } catch {}
      return _origStdoutWrite(chunk, ...rest);
    };
    (process.stderr as any).write = (chunk: any, ...rest: any[]) => {
      try {
        const s = typeof chunk === 'string' ? chunk : chunk?.toString?.() ?? String(chunk);
        pushAndStream({ t: Date.now(), wcId: -1, kind: 'main-stderr', text: s });
      } catch {}
      return _origStderrWrite(chunk, ...rest);
    };

    const pendingStatuses = new Map<number, Map<string, number>>();
    function statusMap(wcId: number): Map<string, number> {
      let m = pendingStatuses.get(wcId);
      if (!m) { m = new Map(); pendingStatuses.set(wcId, m); }
      return m;
    }

    function attach(wc: any) {
      if (wc.isDestroyed()) return;
      if (wc.__peekHarnessAttached) return;
      wc.__peekHarnessAttached = true;
      try {
        if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      } catch (e: any) {
        pushAndStream({ t: Date.now(), wcId: wc.id, kind: 'attach-error', error: String(e?.message || e) });
        return;
      }
      const info = { id: wc.id, type: wc.getType(), url: wc.getURL() };
      pushAndStream({ t: Date.now(), wcId: wc.id, kind: 'attached', info });

      wc.debugger.sendCommand('Network.enable').catch(() => {});
      wc.debugger.sendCommand('Page.enable').catch(() => {});
      wc.debugger.sendCommand('Runtime.enable').catch(() => {});
      wc.debugger.sendCommand('Log.enable').catch(() => {});

      wc.debugger.on('message', async (_event: any, method: string, params: any) => {
        pushAndStream({ t: Date.now(), wcId: wc.id, kind: 'cdp', method, params });
        if (method === 'Network.responseReceived') {
          if (params?.response?.status != null) statusMap(wc.id).set(params.requestId, params.response.status);
        }
        if (method === 'Network.loadingFinished') {
          const reqId = params.requestId;
          const status = statusMap(wc.id).get(reqId);
          if (status != null && status >= 400) {
            try {
              const body = await wc.debugger.sendCommand('Network.getResponseBody', { requestId: reqId });
              pushAndStream({ t: Date.now(), wcId: wc.id, kind: 'response-body', requestId: reqId, body: body.body, base64Encoded: body.base64Encoded });
            } catch (e: any) {
              pushAndStream({ t: Date.now(), wcId: wc.id, kind: 'response-body-error', requestId: reqId, error: String(e?.message || e) });
            }
          }
          statusMap(wc.id).delete(reqId);
        }
      });

      wc.on('did-navigate', (_e: any, url: string) => pushAndStream({ t: Date.now(), wcId: wc.id, kind: 'did-navigate', url }));
      wc.on('did-navigate-in-page', (_e: any, url: string) => pushAndStream({ t: Date.now(), wcId: wc.id, kind: 'did-navigate-in-page', url }));
      wc.on('destroyed', () => pushAndStream({ t: Date.now(), wcId: wc.id, kind: 'destroyed' }));
    }

    webContents.getAllWebContents().forEach(attach);
    app.on('web-contents-created', (_e: any, wc: any) => attach(wc));

    // Service worker console capture — SW console output doesn't go through
    // process.stdout. Peek loads extensions into a per-profile partition
    // session (`persist:<profile>`) — `session.defaultSession` doesn't see
    // them. Hook the profile partition explicitly.
    const sessionsToHook = [session.defaultSession];
    if (args?.profile) {
      try { sessionsToHook.push(session.fromPartition(`persist:${args.profile}`)); } catch {}
    }
    const seenSessions = new Set<any>();
    function attachSwConsole(s: any, label: string) {
      if (!s || seenSessions.has(s)) return;
      seenSessions.add(s);
      pushAndStream({ t: Date.now(), wcId: -2, kind: 'sw-session-attached', label });
      try {
        s.serviceWorkers?.on?.('console-message', (_e: any, details: any) => {
          pushAndStream({
            t: Date.now(), wcId: -2, kind: 'sw-console',
            level: details?.level, message: details?.message,
            sourceUrl: details?.sourceUrl, lineNumber: details?.lineNumber,
            versionId: details?.versionId, sessionLabel: label,
          });
        });
        s.serviceWorkers?.on?.('registration-completed', (_e: any, details: any) => {
          pushAndStream({
            t: Date.now(), wcId: -2, kind: 'sw-registration',
            label, scope: details?.scope, scriptUrl: details?.scriptUrl,
          });
        });
        s.serviceWorkers?.on?.('running-status-changed', (details: any) => {
          pushAndStream({
            t: Date.now(), wcId: -2, kind: 'sw-status',
            label, versionId: details?.versionId, runningStatus: details?.runningStatus,
          });
          // When an SW comes online, attach its swMain.ipc listeners so we
          // can capture debug heartbeats from the BG runtime-external shim.
          if (details?.runningStatus === 'running' && details?.versionId != null) {
            try {
              const swMain = s.serviceWorkers?.getWorkerFromVersionID?.(details.versionId);
              if (swMain && swMain.ipc?.on) {
                swMain.ipc.on('peek:bg-heartbeat', (_e: any, payload: any) => {
                  pushAndStream({
                    t: Date.now(), wcId: -2, kind: 'sw-heartbeat',
                    label, versionId: details.versionId, payload,
                  });
                });
              }
            } catch {}
          }
        });
      } catch (e: any) {
        pushAndStream({ t: Date.now(), wcId: -2, kind: 'sw-session-attach-error', label, error: String(e?.message || e) });
      }
    }
    sessionsToHook.forEach((s, i) => attachSwConsole(s, i === 0 ? 'default' : `partition:${args?.profile}`));
    app.on('session-created', (s: any) => attachSwConsole(s, 'session-created'));
  }, { profile: opts.profile });

  // Periodic drain: every 500ms, pull whatever's in __peekHarnessBuffer and
  // append to the JSONL on disk. Survives app shutdown — most we lose is
  // ~500ms of trailing events. Stopped in dump().
  const drainTimer: NodeJS.Timeout | null = setInterval(async () => {
    try {
      const drained = await opts.app.evaluateMain!(() => {
        const g: any = globalThis as any;
        const out = (g.__peekHarnessBuffer || []).slice();
        if (g.__peekHarnessBuffer) g.__peekHarnessBuffer.length = 0;
        return out;
      }) as RawCdpLine[];
      if (drained.length === 0) return;
      const lines = drained.map((e) => JSON.stringify(e)).join('\n') + '\n';
      try { fs.appendFileSync(jsonlPath, lines); } catch {}
    } catch { /* app may be shutting down — that's fine, we have what we have */ }
  }, 500);

  // ---- Tracer object ----
  const tracer: Tracer = {
    attachToPage(page: Page, sourceLabel: string) {
      page.on('console', (msg) => {
        record('console', sourceLabel, { level: msg.type(), text: msg.text(), location: msg.location() });
      });
      page.on('pageerror', (err) => {
        record('pageerror', sourceLabel, { message: err.message, stack: err.stack });
      });
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) {
          record('navigation', sourceLabel, { url: frame.url(), source: 'playwright-page' });
        }
      });
    },

    async snapshotRuntime(page: Page, sourceLabel: string, snapOpts) {
      const introspector = `(function() {
        const c = (globalThis).chrome;
        const b = (globalThis).browser;
        const r = c && c.runtime;
        return {
          hasChrome: !!c,
          hasBrowser: !!b,
          id: r ? (r.id || null) : null,
          sendMessage: r ? (typeof r.sendMessage) : 'undefined',
          getURL: r ? (typeof r.getURL) : 'undefined',
          getManifest: r ? (typeof r.getManifest) : 'undefined',
          onMessageExternal: r ? (typeof r.onMessageExternal) : 'undefined',
          keys: r ? Object.keys(r) : []
        };
      })()`;

      let snapshot: RuntimeSnapshot;
      if (snapOpts?.fromWebview) {
        // Drive a webview element inside the host page.
        snapshot = await page.evaluate(async ({ selector, src }) => {
          const wv = document.querySelector(selector) as any;
          if (!wv || typeof wv.executeJavaScript !== 'function') {
            return null;
          }
          return await wv.executeJavaScript(src);
        }, { selector: snapOpts.fromWebview, src: introspector }) as RuntimeSnapshot;
      } else {
        snapshot = await page.evaluate(introspector) as RuntimeSnapshot;
      }
      record('runtime', sourceLabel, snapshot);
    },

    record,

    async dump(result) {
      const endedAt = Date.now();
      const endedAtIso = new Date(endedAt).toISOString();

      // Stop the periodic drain.
      if (drainTimer) clearInterval(drainTimer);

      // Final flush: pull any straggling events from main-process buffer.
      // Best-effort — if the app is shutting down, we already have most of
      // the data via the periodic drain.
      try {
        const drained = await opts.app.evaluateMain!(({ webContents }: any) => {
          const g: any = globalThis as any;
          const out = (g.__peekHarnessBuffer || []).slice();
          if (g.__peekHarnessBuffer) g.__peekHarnessBuffer.length = 0;
          for (const wc of webContents.getAllWebContents()) {
            try { if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach(); } catch {}
          }
          return out;
        }) as RawCdpLine[];
        if (drained.length > 0) {
          const lines = drained.map((e) => JSON.stringify(e)).join('\n') + '\n';
          try { fs.appendFileSync(jsonlPath, lines); } catch {}
        }
      } catch { /* app may already be closing */ }

      // Source of truth: the streamed JSONL file. Survives even if the dump's
      // evaluateMain failed (e.g. app shutting down after auth window close).
      let mainEvents: RawCdpLine[] = [];
      try {
        const raw = fs.readFileSync(jsonlPath, 'utf-8');
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          try { mainEvents.push(JSON.parse(line)); } catch {}
        }
      } catch {}

      // Build wcId → label map from "attached" events; subsequent events use it.
      for (const evt of mainEvents) {
        if (evt.kind === 'attached' && evt.info) {
          const label = `${evt.info.type}#${evt.info.id}${evt.info.url ? ` ${truncateUrl(evt.info.url)}` : ''}`;
          wcLabels.set(evt.wcId, label);
        }
      }

      // Translate CDP lines to canonical TraceEvents and merge.
      const cdpEvents: TraceEvent[] = [];
      for (const evt of mainEvents) {
        const t = evt.t - startedAt;
        const source = wcLabels.get(evt.wcId) || `wc#${evt.wcId}`;
        const tx = translateCdpLine(evt, t, source);
        if (tx) cdpEvents.push(...tx);
      }

      const events = [...inMemory, ...cdpEvents].sort((a, b) => a.t - b.t);

      const trace: HarnessTrace = {
        scenario: opts.scenarioName,
        startedAt: startedAtIso,
        endedAt: endedAtIso,
        result,
        env: { profile: opts.profile, backend: opts.backend, redactedEnvKeys: opts.redactedEnvKeys },
        events,
      };

      fs.writeFileSync(jsonPath, JSON.stringify(trace, null, 2));
      fs.writeFileSync(logPath, renderLogLines(trace));

      return { jsonPath, logPath };
    },
  };

  return tracer;
}

function truncateUrl(url: string): string {
  if (url.length <= 80) return url;
  return url.slice(0, 77) + '...';
}

function translateCdpLine(evt: RawCdpLine, t: number, source: string): TraceEvent[] | null {
  if (evt.kind === 'attached') {
    return [{ t, kind: 'note', source, data: { msg: 'cdp-attached', info: evt.info } }];
  }
  if (evt.kind === 'attach-error') {
    return [{ t, kind: 'note', source, data: { msg: 'cdp-attach-error', error: evt.error } }];
  }
  if (evt.kind === 'destroyed') {
    return [{ t, kind: 'note', source, data: { msg: 'webcontents-destroyed' } }];
  }
  if (evt.kind === 'did-navigate' || evt.kind === 'did-navigate-in-page') {
    return [{ t, kind: 'navigation', source, data: { url: evt.url, source: evt.kind } }];
  }
  if (evt.kind === 'response-body') {
    return [{ t, kind: 'response-body', source, data: { requestId: evt.requestId, body: evt.body, base64Encoded: evt.base64Encoded } }];
  }
  if (evt.kind === 'response-body-error') {
    return [{ t, kind: 'note', source, data: { msg: 'response-body-error', requestId: evt.requestId, error: evt.error } }];
  }
  if (evt.kind === 'main-stdout' || evt.kind === 'main-stderr') {
    const text = (evt as any).text as string;
    const lines = text.split('\n').filter((l) => l.length > 0);
    return lines.map((line) => ({
      t, kind: 'console', source: evt.kind === 'main-stderr' ? 'main:stderr' : 'main:stdout',
      data: { level: evt.kind === 'main-stderr' ? 'error' : 'log', text: line },
    }));
  }
  if (evt.kind === 'sw-console') {
    const e = evt as any;
    return [{
      t, kind: 'console', source: `sw:vid=${e.versionId ?? '?'}@${e.sessionLabel ?? '?'}`,
      data: { level: e.level, text: e.message, sourceUrl: e.sourceUrl, lineNumber: e.lineNumber },
    }];
  }
  if (evt.kind === 'sw-session-attached') {
    return [{ t, kind: 'note', source: `sw:${(evt as any).label}`, data: { msg: 'sw-session-attached' } }];
  }
  if (evt.kind === 'sw-session-attach-error') {
    return [{ t, kind: 'note', source: `sw:${(evt as any).label}`, data: { msg: 'sw-session-attach-error', error: (evt as any).error } }];
  }
  if (evt.kind === 'sw-registration') {
    const e = evt as any;
    return [{ t, kind: 'note', source: `sw:${e.label}`, data: { msg: 'sw-registration', scope: e.scope, scriptUrl: e.scriptUrl } }];
  }
  if (evt.kind === 'sw-status') {
    const e = evt as any;
    return [{ t, kind: 'note', source: `sw:${e.label}`, data: { msg: 'sw-status', versionId: e.versionId, runningStatus: e.runningStatus } }];
  }
  if (evt.kind === 'sw-heartbeat') {
    const e = evt as any;
    return [{ t, kind: 'note', source: `sw:vid=${e.versionId}@${e.label}`, data: { msg: 'sw-heartbeat', payload: e.payload } }];
  }
  if (evt.kind !== 'cdp' || !evt.method) return null;

  const p = evt.params || {};
  switch (evt.method) {
    case 'Network.requestWillBeSent':
      return [{
        t, kind: 'request', source,
        data: {
          requestId: p.requestId,
          method: p.request?.method,
          url: p.request?.url,
          resourceType: p.type,
          headers: p.request?.headers,
          postData: p.request?.postData,
          documentURL: p.documentURL,
          frameId: p.frameId,
        },
      }];
    case 'Network.responseReceived':
      return [{
        t, kind: 'response', source,
        data: {
          requestId: p.requestId,
          status: p.response?.status,
          statusText: p.response?.statusText,
          url: p.response?.url,
          mimeType: p.response?.mimeType,
          headers: p.response?.headers,
          fromCache: p.response?.fromDiskCache || p.response?.fromServiceWorker,
          remoteIPAddress: p.response?.remoteIPAddress,
        },
      }];
    case 'Network.loadingFailed':
      return [{
        t, kind: 'request-failed', source,
        data: { requestId: p.requestId, errorText: p.errorText, canceled: p.canceled, type: p.type },
      }];
    case 'Page.frameNavigated':
      return [{
        t, kind: 'navigation', source,
        data: { url: p.frame?.url, frameId: p.frame?.id, source: 'cdp-page' },
      }];
    case 'Runtime.consoleAPICalled':
      return [{
        t, kind: 'console', source,
        data: { level: p.type, args: (p.args || []).map((a: any) => a.value ?? a.description ?? a.preview), stackTrace: p.stackTrace },
      }];
    case 'Runtime.exceptionThrown':
      return [{
        t, kind: 'pageerror', source,
        data: { message: p.exceptionDetails?.text, exception: p.exceptionDetails?.exception?.description, stackTrace: p.exceptionDetails?.stackTrace },
      }];
    case 'Log.entryAdded':
      return [{
        t, kind: 'console', source,
        data: { level: p.entry?.level, text: p.entry?.text, source: p.entry?.source, url: p.entry?.url },
      }];
    default:
      return null;
  }
}

function renderLogLines(trace: HarnessTrace): string {
  const out: string[] = [];
  out.push(`# harness trace: ${trace.scenario}`);
  out.push(`# started:  ${trace.startedAt}`);
  out.push(`# ended:    ${trace.endedAt}`);
  out.push(`# result:   ${JSON.stringify(trace.result)}`);
  out.push(`# profile:  ${trace.env.profile} (${trace.env.backend})`);
  out.push(`# events:   ${trace.events.length}`);
  out.push('');
  for (const evt of trace.events) {
    out.push(formatLogLine(evt));
  }
  return out.join('\n') + '\n';
}

function formatLogLine(evt: TraceEvent): string {
  const t = `[t=${String(evt.t).padStart(6, ' ')}ms]`;
  const src = evt.source.padEnd(28, ' ').slice(0, 28);
  switch (evt.kind) {
    case 'request':
      return `${t} ${src} REQUEST  ${evt.data.method || '?'} ${evt.data.url || ''}`;
    case 'response':
      return `${t} ${src} RESPONSE ${evt.data.status || '?'} ${evt.data.url || ''}`;
    case 'response-body':
      return `${t} ${src} BODY     ${evt.data.requestId} ${shortBody(evt.data)}`;
    case 'request-failed':
      return `${t} ${src} FAILED   ${evt.data.errorText || ''} (req ${evt.data.requestId})`;
    case 'navigation':
      return `${t} ${src} NAV      ${evt.data.url || ''}`;
    case 'console':
      return `${t} ${src} CONSOLE  [${evt.data.level || '?'}] ${(evt.data.text || JSON.stringify(evt.data.args || [])).slice(0, 200)}`;
    case 'pageerror':
      return `${t} ${src} ERROR    ${(evt.data.message || '').slice(0, 200)}`;
    case 'runtime':
      return `${t} ${src} RUNTIME  id=${evt.data.id || 'null'} sendMessage=${evt.data.sendMessage} keys=[${(evt.data.keys || []).join(',')}]`;
    case 'note':
      return `${t} ${src} NOTE     ${JSON.stringify(evt.data).slice(0, 200)}`;
    default:
      return `${t} ${src} ${evt.kind} ${JSON.stringify(evt.data).slice(0, 200)}`;
  }
}

function shortBody(data: any): string {
  if (!data?.body) return '<empty>';
  if (data.base64Encoded) return `<base64 ${data.body.length}b>`;
  return data.body.slice(0, 200).replace(/\s+/g, ' ');
}
