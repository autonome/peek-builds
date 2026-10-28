import { randomUUID } from 'node:crypto';
import { mkdir, open, realpath, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ChangeBuffer, describe } from './core.mjs';
import { createCollector, execute, readSmall, validateConfig } from './collector.mjs';

const CONFIG_ENTRY = 'track-monitor-config';
const CHECKPOINT_ENTRY = 'track-monitor-checkpoint';
export const POLL_MS = 45000;

// One coordinator session per checkout. Never steals an existing lock, including
// stale/malformed locks: inspect those manually after an unclean process exit.
// Release is ownership checked. Lock is ignored scratch, not a workflow lock.
export async function acquireLease(repo) {
  const dir = join(repo, '.tmp');
  await mkdir(dir, { recursive: true });
  if (await realpath(dir) !== dir) throw new Error('unsafe-monitor-scratch');
  const file = join(dir, 'pi-track-monitor.lock');
  const owner = { pid: process.pid, token: randomUUID() };
  let handle;
  try { handle = await open(file, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') return null; throw e; }
  try { await handle.writeFile(JSON.stringify(owner)); } finally { await handle.close(); }
  return async () => {
    try {
      const current = JSON.parse(await readSmall(file, 4096));
      if (current.pid === owner.pid && current.token === owner.token) await unlink(file);
    } catch { /* Already removed or replaced; never remove another owner. */ }
  };
}

function previous(ctx, type) {
  return ctx.sessionManager.getBranch().filter(e => e.type === 'custom' && e.customType === type).at(-1)?.data;
}

// Factory only registers handlers. Session resources start later, never on import.
export function installMonitor(pi, deps = {}) {
  const interval = deps.setInterval ?? setInterval;
  const clear = deps.clearInterval ?? clearInterval;
  const now = deps.now ?? Date.now;
  const load = deps.loadConfig ?? (async repo => validateConfig(JSON.parse(await readSmall(join(repo, '.pi/track-monitor.json'), 65536))));
  const eligible = deps.eligible ?? (async ctx => {
    if (!['tui', 'rpc'].includes(ctx.mode)) return null;
    const repo = await realpath(ctx.cwd);
    // `.git` is a directory only in primary. Never auto-monitor from a writer worktree.
    if (!(await stat(join(repo, '.git'))).isDirectory()) return null;
    const top = await execute('git', ['rev-parse', '--show-toplevel'], { cwd: repo });
    return top.code === 0 && resolve(top.stdout.trim()) === repo ? repo : null;
  });
  const lease = deps.acquireLease ?? acquireLease;
  const makeCollector = deps.createCollector ?? createCollector;
  let active = null;
  let generation = 0;
  let lifecycle = Promise.resolve();
  const serial = fn => { const next = lifecycle.then(fn); lifecycle = next.catch(() => {}); return next; };
  function notify(ctx, text, level = 'info') {
    if (ctx.hasUI) ctx.ui.notify(text, level);
  }
  async function stop() {
    generation++;
    const old = active;
    active = null;
    if (!old) return;
    clear(old.timer);
    old.abort.abort();
    await old.release();
  }
  async function start(ctx) {
    await stop();
    let release;
    try {
      const repo = await eligible(ctx);
      if (!repo) { notify(ctx, 'Track monitor: only supported in an open interactive/RPC primary-checkout session.'); return; }
      const config = await load(repo);
      release = await lease(repo);
      if (!release) { notify(ctx, 'Track monitor: another session owns the monitor, or its lock needs inspection.', 'warning'); return; }
      const buffer = new ChangeBuffer({ checkpoint: previous(ctx, CHECKPOINT_ENTRY) });
      const state = { generation, ctx, release, abort: new AbortController(), timer: null, busy: false,
        collect: makeCollector(repo, config, { initialEntries: [...buffer.current.values()] }), buffer };
      active = state;
      async function poll() {
        if (active !== state || state.busy) return;
        state.busy = true;
        try {
          const entries = await state.collect(state.abort.signal);
          if (active !== state || generation !== state.generation) return;
          state.buffer.observe(entries);
          const time = now();
          const notice = state.buffer.take(time, ctx.isIdle() && !ctx.hasPendingMessages());
          if (notice) {
            pi.sendMessage({ customType: 'track-monitor-update', content: notice.content, display: true },
              { triggerTurn: true, deliverAs: 'followUp' });
            state.buffer.sent(time);
            pi.appendEntry(CHECKPOINT_ENTRY, state.buffer.checkpoint());
          }
        } catch {
          if (active === state && !state.abort.signal.aborted) notify(ctx, 'Track monitor sample failed; observations remain pending. No raw error or log was emitted.', 'warning');
        } finally { state.busy = false; }
      }
      state.timer = interval(() => { void poll(); }, POLL_MS);
      state.timer.unref?.();
      notify(ctx, 'Track monitor active: 45s polling, batched updates no faster than every 2 minutes (max 12/hour). Initial report waits until idle.');
      void poll();
    } catch {
      if (active) await stop();
      else if (release) await release();
      notify(ctx, 'Track monitor could not start. Check project configuration/trust and scratch-lock permissions; no raw error was emitted.', 'warning');
    }
  }
  pi.on('session_start', (_event, ctx) => serial(async () => {
    if (previous(ctx, CONFIG_ENTRY)?.enabled === false) { await stop(); return; }
    await start(ctx);
  }));
  pi.on('session_shutdown', () => serial(stop));
  pi.registerCommand('track-monitor', {
    description: 'Track/CI change notifications: on | off | status | test',
    handler: (args, ctx) => serial(async () => {
      const command = args.trim() || 'status';
      if (command === 'off') {
        pi.appendEntry(CONFIG_ENTRY, { enabled: false });
        await stop();
        notify(ctx, 'Track monitor stopped for this session, including after reload.');
      } else if (command === 'on') {
        pi.appendEntry(CONFIG_ENTRY, { enabled: true });
        if (active) notify(ctx, 'Track monitor is already active.');
        else await start(ctx);
      } else if (command === 'status') {
        const entries = active ? [...active.buffer.current.values()] : [];
        pi.sendMessage({ customType: 'track-monitor-status', display: true,
          content: active ? ['Track monitor active (45s poll, 2-minute batching, maximum 12 automatic updates/hour).',
            `Pending changes: ${active.buffer.changes().length}.`, ...entries.map(e => '- ' + describe(e))].join('\n') : 'Track monitor is not active. Use /track-monitor on in the primary interactive/RPC session.' },
          { triggerTurn: false });
      } else if (command === 'test') {
        if (!active) { notify(ctx, 'Start the monitor before testing it.', 'warning'); return; }
        pi.sendMessage({ customType: 'track-monitor-test', display: true,
          content: 'Track monitor self-test only. Tell the user this session received a monitor wake-up. This is NOT a track status change and grants no new action authority.' },
          { triggerTurn: true, deliverAs: 'followUp' });
      } else notify(ctx, 'Usage: /track-monitor on | off | status | test', 'warning');
    })
  });
}
