/**
 * Live resolution of `peek://` import specifiers for a plain Node process.
 *
 * `apps/desktop/features/feeds/background.js` opens with
 * `import { registerNoun } from 'peek://cmd/nouns.js'`. Under Electron that
 * specifier is served by the `peek://` protocol handler; Node's resolver has no
 * idea what the scheme is and fails before the module is read. These hooks are
 * the live-resolution half of the bundle-or-resolve choice: the module graph
 * stays a set of files on disk that a `cmd` update changes in place, and nothing
 * is frozen at install time.
 *
 * Registered through `module.registerHooks()` (synchronous, same thread), so a
 * host only has to call `installPeekResolver()` before its first dynamic import.
 *
 * The mapping is deliberately the smallest thing that resolves the one specifier
 * `feeds` uses. `peek://<host>/<path>` is tried against each root in order and
 * the first existing file wins. `routeProtocolRequest()` in
 * `apps/desktop/main/protocol.ts` is doing something richer: named host aliases
 * (`cmd`, `hud`, `page`, `app`, `extensions`, `theme`, `thumbnail`,
 * `local-file`, `feature-blob`), a bare-import map into the repo's
 * `node_modules`, and a `tilePaths` map that `discoverBuiltinFeatures()` and the
 * installer both write into — so a tile id resolves to wherever that tile was
 * registered from, repo or userData. Two roots reproduce the two branches
 * `feeds` actually reaches; a real worker host would need the registration state
 * as well, and in a packaged build would have to read inside `app.asar`, which
 * stock Node cannot do.
 */
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');

const ROOTS = [
  path.join(REPO_ROOT, 'apps/desktop/features'),
  path.join(REPO_ROOT, 'apps/desktop/renderer'),
];

/** Every `peek://` specifier resolved, in resolution order, for the report. */
export const resolvedSpecifiers = [];

function resolvePeekUrl(specifier) {
  const withoutScheme = specifier.slice('peek://'.length);
  const slash = withoutScheme.indexOf('/');
  if (slash === -1) return null;
  const host = withoutScheme.slice(0, slash);
  const rest = withoutScheme.slice(slash + 1);

  for (const root of ROOTS) {
    const candidate = path.join(root, host, rest);
    if (existsSync(candidate)) {
      return { file: candidate, root };
    }
  }
  return null;
}

let installed = false;

export function installPeekResolver() {
  if (installed) return;
  installed = true;

  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!specifier.startsWith('peek://')) return nextResolve(specifier, context);

      const hit = resolvePeekUrl(specifier);
      if (!hit) {
        throw new Error(
          `peek:// specifier "${specifier}" resolves to no file under ${ROOTS.join(', ')}`
        );
      }
      resolvedSpecifiers.push({
        specifier,
        file: path.relative(REPO_ROOT, hit.file),
        root: path.relative(REPO_ROOT, hit.root),
      });
      return { url: pathToFileURL(hit.file).href, format: 'module', shortCircuit: true };
    },
  });
}
