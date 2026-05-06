/**
 * Locate the bundled `peek-cli.mjs` helper across all packaging contexts.
 *
 * Source build: lives in `<repo>/scripts/peek-cli.mjs` next to package.json.
 *
 * Packaged build (.deb / .rpm): electron-builder honours `asarUnpack`
 * for the helper, landing it at `${process.resourcesPath}/app.asar.unpacked/scripts/peek-cli.mjs`.
 * That path is stable across launches.
 *
 * AppImage: the runner mounts the squashfs at `/tmp/.mount_PeekXXXXXX/`
 * with a fresh suffix per launch — the path the daemon sees is *not*
 * stable across restarts, so we can't tell the user "bind your shortcut
 * to this path." Instead, on daemon startup we shadow-copy the helper
 * to `~/.local/share/peek/peek-cli.mjs` (a stable user-writable
 * location) and report that path. The shadow is refreshed every launch
 * so AppImage upgrades pick up the new helper.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { app } from 'electron';

const APPIMAGE_SHADOW_PATH = path.join(
  os.homedir(), '.local', 'share', 'peek', 'peek-cli.mjs'
);

const isAppImage = (): boolean => Boolean(process.env.APPIMAGE);

const packagedHelperPath = (): string =>
  path.join(process.resourcesPath, 'app.asar.unpacked', 'scripts', 'peek-cli.mjs');

const sourceHelperPath = (): string =>
  path.join(app.getAppPath(), 'scripts', 'peek-cli.mjs');

/**
 * Return the absolute path users should bind to in their DE keyboard
 * settings. Stable across launches in every supported packaging.
 */
export function resolveCliHelperPath(): string {
  if (isAppImage()) return APPIMAGE_SHADOW_PATH;
  if (app.isPackaged) return packagedHelperPath();
  return sourceHelperPath();
}

/**
 * Resolve the executor (the binary that runs the helper script) and the
 * helper script path together. The executor is the Electron binary,
 * invoked in Node mode via ELECTRON_RUN_AS_NODE=1 — we don't assume the
 * user has system Node installed (a non-dev wouldn't), but we always
 * have Electron because Peek is an Electron app.
 *
 * AppImage: executor is the AppImage itself (stable user-visible path).
 * The AppImage runtime mounts and execs the inner peek binary, which
 * respects ELECTRON_RUN_AS_NODE.
 *
 * Packaged (deb/rpm): executor is the renamed Electron binary at
 * ${appBundle}/peek (process.execPath in packaged Electron).
 *
 * Source build: executor is node_modules/electron/dist/electron, again
 * what process.execPath points at.
 */
export function resolveCliExecutor(): { electron: string; helper: string } {
  if (isAppImage()) {
    return {
      electron: process.env.APPIMAGE!,
      helper: APPIMAGE_SHADOW_PATH,
    };
  }
  return {
    electron: process.execPath,
    helper: app.isPackaged ? packagedHelperPath() : sourceHelperPath(),
  };
}

/**
 * Build the full shell-ready command string that users paste into
 * GNOME (or KDE / Hyprland) keyboard shortcut settings.
 *
 * Wraps the env-var prefix + executor + helper + verb in `sh -c '…'`
 * because GNOME's custom-shortcut runner doesn't expand env-var
 * prefixes natively. Inner paths get double-quoted so paths with spaces
 * survive sh tokenisation.
 */
export function formatCliCommand(verb: string, args: string[] = []): string {
  const { electron, helper } = resolveCliExecutor();
  // Inner: ELECTRON_RUN_AS_NODE=1 "<electron>" "<helper>" verb arg arg…
  // Double-quote paths so embedded spaces work; escape $ ` " \ inside.
  const dq = (s: string) => `"${s.replace(/[$`"\\]/g, '\\$&')}"`;
  const tail = args.length ? ' ' + args.join(' ') : '';
  const inner = `ELECTRON_RUN_AS_NODE=1 ${dq(electron)} ${dq(helper)} ${verb}${tail}`;
  // Wrap with sh -c '…' for GNOME. Single-quote escape any ' in inner.
  return `sh -c '${inner.replace(/'/g, `'\\''`)}'`;
}

/**
 * On AppImage, copy the helper from the (ephemeral) mount path to the
 * stable shadow path under `~/.local/share/peek/`. Idempotent — runs
 * every daemon startup so version upgrades replace the shadow with the
 * new helper. No-op on every other packaging.
 */
export async function ensureCliHelperShadow(): Promise<void> {
  if (!isAppImage()) return;
  const src = packagedHelperPath();
  const dst = APPIMAGE_SHADOW_PATH;
  try {
    await fs.promises.mkdir(path.dirname(dst), { recursive: true });
    await fs.promises.copyFile(src, dst);
    await fs.promises.chmod(dst, 0o755);
    console.log(`[cli-helper] AppImage shadow refreshed at ${dst}`);
  } catch (err) {
    console.error(`[cli-helper] failed to refresh AppImage shadow at ${dst}:`, err);
  }
}
