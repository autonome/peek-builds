import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { normalizeEntry } from './core.mjs';

export async function execute(file, args, { cwd, signal } = {}) {
  return new Promise((accept, reject) => {
    execFile(file, args, { cwd, signal, timeout: 20000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' } }, (error, stdout) => {
      if (error && typeof error.code !== 'number') return reject(new Error('monitor-command-failed'));
      accept({ code: error?.code ?? 0, stdout });
    });
  });
}
export async function readSmall(path, max = 262144) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max) throw new Error('monitor-file-invalid');
    const bytes = Buffer.alloc(max + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > max) throw new Error('monitor-file-invalid');
    return bytes.subarray(0, length).toString('utf8');
  } finally { await handle.close(); }
}
export function validateConfig(raw) {
  if (!raw || !Array.isArray(raw.targets) || !raw.targets.length || raw.targets.length > 16) throw new Error('monitor-config-invalid');
  const names = new Set();
  const targets = raw.targets.map(t => {
    if (!t || typeof t.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(t.name) || !['manual', 'spec'].includes(t.kind) || names.has(t.name)) throw new Error('monitor-config-invalid');
    names.add(t.name);
    if (t.kind === 'spec' && !t.name.startsWith('spec-')) throw new Error('monitor-config-invalid');
    return { name: t.name, kind: t.kind };
  });
  if (typeof raw.githubRepo !== 'string' || !/^[a-zA-Z0-9][\w.-]*\/[a-zA-Z0-9][\w.-]*$/.test(raw.githubRepo) || typeof raw.workflow !== 'string' || !/^[a-zA-Z0-9][\w.-]*\.ya?ml$/.test(raw.workflow)) throw new Error('monitor-config-invalid');
  return { targets, githubRepo: raw.githubRepo, workflow: raw.workflow };
}

// Paths come only from validated target names, never status output. Nothing writes,
// fetches, pushes, reads credentials, or reads raw test/CI/session logs.
export function createCollector(repo, config, deps = {}) {
  config = validateConfig(config);
  const run = deps.run ?? execute;
  const read = deps.read ?? readSmall;
  const canonical = deps.realpath ?? realpath;
  const alive = deps.alive ?? (pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } });
  const home = deps.home ?? homedir();
  const tips = new Map((deps.initialEntries ?? []).map(normalizeEntry)
    .filter(e => e.kind === 'track' && e.tip).map(e => [e.name, e.tip]));
  const failures = new Map();
  async function must(file, args, signal) {
    const result = await run(file, args, { cwd: repo, signal });
    if (result.code !== 0) throw new Error('monitor-source-unavailable');
    return result.stdout;
  }
  async function source(name, work, entries) {
    try {
      entries.push(...await work());
      if ((failures.get(name) ?? 0) >= 3) entries.push(normalizeEntry({ kind: 'health', source: name, state: 'healthy' }));
      failures.set(name, 0);
    } catch {
      const n = (failures.get(name) ?? 0) + 1;
      failures.set(name, n);
      if (n >= 3) entries.push(normalizeEntry({ kind: 'health', source: name, state: 'unavailable' }));
    }
  }
  async function runtime(path) {
    try {
      const key = createHash('sha256').update(path).digest('hex').slice(0, 16);
      const state = JSON.parse(await read(join(home, '.local/state/spec-watch', `${key}.json`)));
      if (resolve(state.worktree ?? '') !== path) return 'untracked';
      const pid = state.writer?.pid;
      return Number.isSafeInteger(pid) && pid > 0 ? (alive(pid) ? 'running' : 'stopped') : 'untracked';
    } catch { return 'untracked'; }
  }
  return async function collect(signal) {
    const entries = [];
    let specs = null;
    // Spec status is authoritative for review/landing markers, not manual tracks.
    await source('spec-status', async () => {
      const data = JSON.parse(await must('spec-status.mjs', [], signal));
      if (resolve(data.repo ?? '') !== repo || !Array.isArray(data.specs)) throw new Error('invalid-status');
      specs = new Map(data.specs.map(s => [s.name, s]));
      return [];
    }, entries);
    await source('worktrees', async () => {
      const listing = await must('git', ['worktree', 'list', '--porcelain', '-z'], signal);
      const existing = new Set(listing.split('\0').filter(s => s.startsWith('worktree ')).map(s => resolve(s.slice(9))));
      const found = [];
      for (const target of config.targets) {
        const path = join(repo, '.worktrees', target.name);
        const spec = target.kind === 'spec' ? specs?.get(target.name.slice(5)) : null;
        // Missing authoritative status must not erase a review or fabricate a transition.
        if (target.kind === 'spec' && !spec) continue;
        if (!existing.has(path)) {
          let state = spec?.state ?? 'removed-unconfirmed';
          const tip = tips.get(target.name) ?? null;
          if (target.kind === 'manual' && tip) {
            const result = await run('git', ['merge-base', '--is-ancestor', tip, 'main'], { cwd: repo, signal });
            if (result.code === 0) state = 'landed';
            else if (result.code !== 1) throw new Error('invalid-ancestry');
          }
          found.push(normalizeEntry({ kind: 'track', name: target.name, state, tip, review: spec?.staleReview ? null : spec?.review?.verdict }));
          continue;
        }
        if (await canonical(path) !== path) throw new Error('unexpected-worktree-alias');
        const [tipRaw, aheadRaw, dirtyRaw, writer] = await Promise.all([
          must('git', ['-C', path, 'rev-parse', 'HEAD'], signal),
          must('git', ['-C', path, 'rev-list', '--count', 'main..HEAD'], signal),
          must('git', ['-C', path, 'status', '--porcelain'], signal), runtime(path)
        ]);
        const tip = tipRaw.trim();
        const ahead = Number(aheadRaw.trim());
        if (!/^[a-f0-9]{40,64}$/.test(tip) || !Number.isSafeInteger(ahead) || ahead < 0) throw new Error('invalid-git-data');
        tips.set(target.name, tip);
        let handoff = null;
        try { handoff = createHash('sha256').update(await read(join(path, 'handoff.md'))).digest('hex'); } catch { /* Not raw content. */ }
        const state = spec?.state ?? (writer === 'running' ? 'running' : dirtyRaw.trim() ? 'dirty' : ahead > 0 ? 'ready' : 'empty');
        found.push(normalizeEntry({ kind: 'track', name: target.name, state, tip, ahead, writer, handoff, review: spec?.staleReview ? null : spec?.review?.verdict }));
      }
      return found;
    }, entries);
    await source('signing-ci', async () => {
      const runs = JSON.parse(await must('gh', ['run', 'list', '--repo', config.githubRepo, '--workflow', config.workflow,
        '--limit', '3', '--json', 'databaseId,headBranch,status,conclusion'], signal));
      if (!Array.isArray(runs)) throw new Error('invalid-ci');
      if (!runs.length) return [];
      const r = runs[0];
      return [normalizeEntry({ kind: 'ci', repo: config.githubRepo, run: r.databaseId, tag: r.headBranch, state: r.status, conclusion: r.conclusion })];
    }, entries);
    return entries;
  };
}
