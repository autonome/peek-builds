/**
 * Linux desktop integration for AppImage builds.
 *
 * Why: `app.setAsDefaultProtocolClient('http')` on Linux ultimately runs
 * `xdg-mime default <desktop-file> x-scheme-handler/http`. xdg-mime resolves
 * the desktop file by name, which means it must exist on disk under
 * `~/.local/share/applications/` (user) or `/usr/share/applications/`
 * (system). AppImage runs from an ephemeral squashfs mount and never
 * installs anything system-wide, so without this shim the protocol-client
 * call writes a `mimeapps.list` entry pointing at a desktop file that
 * doesn't exist anywhere — settings shows "default browser set" but
 * `xdg-open https://example.com` does nothing.
 *
 * What: on every AppImage launch, refresh:
 *   - `~/.local/share/applications/peek.desktop`
 *   - `~/.local/share/icons/hicolor/<size>/apps/peek.png` (each size we ship)
 *   - `~/.local/bin/peek` symlink → the AppImage, so users can run
 *     `peek https://example.com` from a shell (cold-start or
 *     forward-to-running via single-instance, handled by main.ts).
 *
 * The `Exec=` line points at `process.env.APPIMAGE` (the actual on-disk
 * file path), so a moved/renamed AppImage corrects itself on next launch.
 * The `MimeType=` line registers Peek as a candidate for http/https/html
 * so the user can pick it in the system "Default Applications" UI in
 * addition to clicking our own settings button.
 *
 * No-op for source builds, deb/rpm packages (which install to
 * /usr/share/applications + /usr/bin via the package manager), and
 * non-Linux platforms.
 *
 * Pairs with `cli-helper.ts`'s `ensureCliHelperShadow()` — same
 * shadow-on-launch model, just for desktop integration instead of CLI.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const isAppImage = (): boolean => Boolean(process.env.APPIMAGE);

// Honor $XDG_DATA_HOME (XDG base-directory spec) when set; only a small
// fraction of users redirect it, but skipping it means an isolated test
// harness can't point us at a temp dir without trampling the user's real
// `~/.local/share/applications/`. Falling back to the spec default keeps
// behavior identical for everyone else.
const xdgDataHome = (): string =>
  process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');

const userApplicationsDir = (): string => path.join(xdgDataHome(), 'applications');
const userIconsBase = (): string => path.join(xdgDataHome(), 'icons', 'hicolor');
const DESKTOP_FILE_NAME = 'peek.desktop';

// `~/.local/bin` is in the default PATH on systemd-user-session distros
// (Fedora, Debian/Ubuntu since 2019, Arch with systemd). Honor
// PEEK_CLI_ALIAS_DIR as an escape hatch for tests and for advanced users
// who keep their PATH dirs elsewhere.
const userBinDir = (): string =>
  process.env.PEEK_CLI_ALIAS_DIR || path.join(os.homedir(), '.local', 'bin');

const CLI_ALIAS_NAME = 'peek';

/**
 * MIME types Peek registers as a candidate for. Includes http/https for
 * default-browser flow and text/html so file managers offer Peek when
 * opening local .html files.
 */
const MIME_TYPES = [
  'x-scheme-handler/http',
  'x-scheme-handler/https',
  'x-scheme-handler/about',
  'x-scheme-handler/unknown',
  'text/html',
  'application/xhtml+xml',
];

// Sizes we ship icons for in the AppImage.
// (See `out/squashfs-root/usr/share/icons/hicolor/<size>/apps/peek.png`.
// JSDoc avoided because the literal asterisk-slash inside the path
// would close the comment block.)
const ICON_SIZES = ['16x16', '32x32', '48x48', '64x64', '128x128', '256x256', '512x512', '1024x1024'];

function buildDesktopFile(execPath: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Peek',
    'Comment=Peek is a web user agent for working with the web in a more agent-ish fashion than a browser.',
    'Categories=Network;WebBrowser;',
    'Icon=peek',
    'StartupWMClass=Peek',
    `Exec=${execPath} %U`,
    'Terminal=false',
    `MimeType=${MIME_TYPES.join(';')};`,
    'X-AppImage-Version=installed-by-peek',
    '',
  ].join('\n');
}

/**
 * Find the AppImage's mount root from any path inside it.
 * `process.env.APPDIR` is set by the AppImage runtime; fall back to
 * walking up from `process.resourcesPath` if it isn't.
 */
function findAppImageMountRoot(): string | null {
  if (process.env.APPDIR) return process.env.APPDIR;
  // process.resourcesPath = <mount>/resources — its parent is the mount root.
  if (process.resourcesPath) {
    const candidate = path.dirname(process.resourcesPath);
    if (fs.existsSync(path.join(candidate, 'AppRun'))) return candidate;
  }
  return null;
}

async function copyIcons(mountRoot: string): Promise<void> {
  const srcBase = path.join(mountRoot, 'usr', 'share', 'icons', 'hicolor');
  for (const size of ICON_SIZES) {
    const src = path.join(srcBase, size, 'apps', 'peek.png');
    if (!fs.existsSync(src)) continue;
    const dstDir = path.join(userIconsBase(), size, 'apps');
    const dst = path.join(dstDir, 'peek.png');
    try {
      await fs.promises.mkdir(dstDir, { recursive: true });
      await fs.promises.copyFile(src, dst);
    } catch (err) {
      console.warn(`[desktop-installer] failed to copy icon ${size}:`, err);
    }
  }
}

/**
 * Install or refresh the user-level Peek desktop integration.
 *
 * Idempotent — safe to call on every launch. Source builds and packaged
 * builds outside of AppImage skip out immediately.
 */
export async function ensureLinuxDesktopInstall(): Promise<void> {
  if (process.platform !== 'linux') return;
  if (!isAppImage()) return;

  const appimage = process.env.APPIMAGE!;
  const mountRoot = findAppImageMountRoot();

  // Install desktop file
  const desktopContent = buildDesktopFile(appimage);
  const applicationsDir = userApplicationsDir();
  const dstDesktop = path.join(applicationsDir, DESKTOP_FILE_NAME);
  try {
    await fs.promises.mkdir(applicationsDir, { recursive: true });
    await fs.promises.writeFile(dstDesktop, desktopContent, { mode: 0o644 });
    console.log(`[desktop-installer] installed ${dstDesktop} (Exec=${appimage})`);
  } catch (err) {
    console.error(`[desktop-installer] failed to install ${dstDesktop}:`, err);
    return;
  }

  // Copy icons (best-effort — installed desktop file still works if icons
  // can't be copied; just shows a generic icon).
  if (mountRoot) {
    await copyIcons(mountRoot);
  }

  // Refresh xdg's desktop-entry cache so the new MimeType registration is
  // visible to xdg-mime queries. Best-effort — most distros work without
  // this, but GNOME's older xdg-utils did require it.
  try {
    const { spawn } = await import('node:child_process');
    spawn('update-desktop-database', [applicationsDir], { stdio: 'ignore' })
      .on('error', () => { /* binary may not exist; safe to ignore */ });
  } catch { /* ignore */ }
}

/**
 * Install or refresh a `peek` symlink in `~/.local/bin/` pointing at the
 * running AppImage. After this runs, users can `peek https://example.com`
 * from a shell — main.ts's handleCliUrl (cold start) or the second-instance
 * handler (forward to running daemon) takes the URL from argv.
 *
 * Refuses to clobber a non-symlink at that path (a user might already have
 * their own `peek` script there). If a stale symlink points at a removed
 * or relocated AppImage, refresh it to the current APPIMAGE.
 *
 * Idempotent — safe to call on every launch. No-op for non-Linux and for
 * non-AppImage builds (deb/rpm install /usr/bin/peek themselves).
 */
export async function ensureLinuxCliAlias(): Promise<void> {
  if (process.platform !== 'linux') return;
  if (!isAppImage()) return;

  const appimage = process.env.APPIMAGE!;
  const binDir = userBinDir();
  const aliasPath = path.join(binDir, CLI_ALIAS_NAME);

  let existing: import('node:fs').Stats | null = null;
  try {
    existing = await fs.promises.lstat(aliasPath);
  } catch {
    // doesn't exist — fall through to create
  }

  if (existing && !existing.isSymbolicLink()) {
    // Don't trample a user-owned `peek` (script, alternative tool, etc.).
    // Log loud so they notice if they wanted ours instead.
    console.warn(
      `[cli-alias] ${aliasPath} exists and is not a symlink — leaving alone. ` +
      `Remove it manually if you want \`peek\` to point at Peek.`
    );
    return;
  }

  if (existing) {
    try {
      const currentTarget = await fs.promises.readlink(aliasPath);
      if (currentTarget === appimage) return; // already correct
    } catch {
      // readlink failed — fall through and rewrite
    }
  }

  try {
    await fs.promises.mkdir(binDir, { recursive: true });
    if (existing) await fs.promises.unlink(aliasPath);
    await fs.promises.symlink(appimage, aliasPath);
    console.log(`[cli-alias] installed ${aliasPath} -> ${appimage}`);
  } catch (err) {
    console.error(`[cli-alias] failed to install ${aliasPath}:`, err);
    return;
  }

  // PATH hint — only when we just created/updated the link. Most modern
  // distros put ~/.local/bin in PATH by default; this nudge is for users
  // on older setups so they know what's needed to actually use the alias.
  const pathParts = (process.env.PATH ?? '').split(path.delimiter);
  if (!pathParts.includes(binDir)) {
    console.warn(
      `[cli-alias] note: ${binDir} is not on your PATH. ` +
      `Add 'export PATH="$HOME/.local/bin:$PATH"' to your shell rc to use \`peek <url>\`.`
    );
  }
}

/**
 * Test seam — exposes the desktop-file generator so unit tests can assert
 * the MimeType line and Exec= path without touching the filesystem.
 */
export const _internal = { buildDesktopFile, MIME_TYPES };

// Re-export for callers that want the destination paths (none today, but
// keeps the surface honest for future settings UI that might want to
// say "installed at ~/.local/share/applications/peek.desktop").
export const userDesktopFilePath = (): string =>
  path.join(userApplicationsDir(), DESKTOP_FILE_NAME);

export const userCliAliasPath = (): string =>
  path.join(userBinDir(), CLI_ALIAS_NAME);
