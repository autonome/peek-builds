/**
 * Build identity: the record of which source a packaged Peek was built from.
 *
 * Pure logic only — no Electron import at module top level, so the
 * electron-builder `afterPack` hook (plain node, no Electron runtime) can
 * import the compiled `dist/main/build-info.js` and reuse `resolveBuildInfo`.
 * The hook runs the git commands; this module only shapes their output.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Raw git/packaging outputs the hook collects, before any interpretation. */
export interface BuildInfoInputs {
  /** `git rev-parse HEAD` */
  commit: string;
  /** `git log -1 --format=%cI` — ISO-8601 commit timestamp */
  commitTime: string;
  /** `git status --porcelain` — empty means a clean tree */
  porcelain: string;
  /** `git rev-parse --abbrev-ref HEAD` — literally `HEAD` when detached */
  branch: string;
  /** `git rev-parse --show-toplevel` */
  toplevel: string;
  /** ISO-8601 time the package was built */
  buildTime: string;
  /** `version` from the root package.json */
  version: string;
}

export interface BuildInfo {
  commit: string;
  shortCommit: string;
  commitTime: string;
  buildTime: string;
  dirty: boolean;
  /** null when HEAD is detached. */
  branch: string | null;
  /** `main` for the primary checkout, `worktree:<name>` for a worktree. */
  checkout: string;
  version: string;
}

/** Length of the abbreviated commit id used in the log line and CFBundleVersion. */
const SHORT_COMMIT_LENGTH = 12;

/**
 * Worktrees live at `<repo>/.worktrees/<name>` by project convention, so the
 * toplevel path is the only thing that distinguishes a worktree build from a
 * primary-checkout one.
 */
function resolveCheckout(toplevel: string): string {
  const match = /\/\.worktrees\/([^/]+)/.exec(toplevel);
  return match ? `worktree:${match[1]}` : 'main';
}

export function resolveBuildInfo(inputs: BuildInfoInputs): BuildInfo {
  const commit = inputs.commit.trim();
  const branch = inputs.branch.trim();
  return {
    commit,
    shortCommit: commit.slice(0, SHORT_COMMIT_LENGTH),
    commitTime: inputs.commitTime.trim(),
    buildTime: inputs.buildTime.trim(),
    dirty: inputs.porcelain.trim().length > 0,
    branch: branch === 'HEAD' || branch === '' ? null : branch,
    checkout: resolveCheckout(inputs.toplevel.trim()),
    version: inputs.version.trim(),
  };
}

export function formatBuildInfoLogLine(info: BuildInfo): string {
  return `[build] commit=${info.shortCommit} dirty=${info.dirty} checkout=${info.checkout}`;
}

/** The line logged when a packaged build carries no readable stamp. */
export const UNIDENTIFIED_BUILD_LOG_LINE = '[build] unidentified build (no build-info.json)';

/**
 * Reads `build-info.json` out of a packaged app's resources directory.
 *
 * Returns null when the file is missing or unreadable, which is the normal
 * case for a source run — only `afterPack` writes the file.
 */
export function readBuildInfo(resourcesDir: string): BuildInfo | null {
  try {
    const raw = fs.readFileSync(path.join(resourcesDir, 'build-info.json'), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const info = parsed as Partial<BuildInfo>;
    if (typeof info.commit !== 'string' || typeof info.shortCommit !== 'string') return null;
    return info as BuildInfo;
  } catch {
    return null;
  }
}
