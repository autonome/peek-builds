'use strict';

// Production candidate adapter. All child output is private; never print raw
// errors/arguments (security import/store-credentials contain credentials).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const plist = require('plist');
const { SigningError, runCandidate, validateNotary } = require('./macos-signing.cjs');
const block = code => { throw new SigningError(code); };
const need = (ok, code) => { if (!ok) block(code); };
// Apple's public CA download, vendored for offline CI (DER, not a trust override).
const DEVELOPER_ID_G2_SHA256 = 'f16cd3c54c7f83cea4bf1a3e6a0819c8aaa8e4a1528fd144715f350643d2df3a';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function runner(file, args, options = {}) {
  // execFile's timeout kills only the leader. Own the POSIX group instead,
  // including descendants which outlive the leader or ignore SIGTERM.
  const { timeout = 120000, signal, cleanup: _cleanup,
    maxBuffer = 16 * 1024 * 1024, ...rest } = options;
  return new Promise(resolve => {
    let stopped = false, finishing = false, overflow = false, killTimer, timer;
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
    const posix = process.platform !== 'win32';
    const kill = sig => {
      try { if (posix && child.pid) process.kill(-child.pid, sig); else child.kill(sig); }
      catch (error) { if (error.code !== 'ESRCH') stopped = true; }
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 250);
      // Do not wait for close: descendants can retain the leader's pipes.
      void finish(1);
    };
    const child = spawn(file, args, { ...rest, detached: posix, stdio: ['ignore', 'pipe', 'pipe'] });
    async function finish(code) {
      if (finishing) return;
      finishing = true;
      const terminated = stopped;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      // Also reap an otherwise-successful tool's surviving descendants.
      stop();
      let quiescent = !posix || !child.pid;
      const deadline = Date.now() + 2500;
      while (!quiescent && Date.now() < deadline) {
        try { process.kill(-child.pid, 0); }
        catch (e) { if (e.code === 'ESRCH') { quiescent = true; break; } }
        // Orphan zombies cannot execute or access scratch. Some Linux test
        // containers do not reap them; do not confuse them with live tools.
        quiescent = await new Promise(done => execFile('/bin/ps', ['-axo', 'pgid=,stat='],
          { encoding: 'utf8', timeout: 500, maxBuffer: 4 * 1024 * 1024,
            env: cleanEnv(rest.env || process.env) }, (e, out) => {
            const rows = out?.trim().split('\n') || [];
            done(!e && rows.length > 0 && rows.every(line => /^\s*\d+\s+\S+\s*$/.test(line)) &&
              !rows.some(line => {
                const [group, state] = line.trim().split(/\s+/);
                return Number(group) === child.pid && !state.startsWith('Z');
              }));
          }));
        if (!quiescent) await new Promise(done => setTimeout(done, 25));
      }
      clearTimeout(killTimer);
      // Drain already-written output after exit; never await inherited pipes
      // indefinitely (a tool leaving its group is outside this containment).
      const drained = await Promise.race([
        Promise.all([child.stdout, child.stderr].map(stream => new Promise(done => {
          if (stream.readableEnded || stream.destroyed) done();
          else { stream.once('end', done); stream.once('close', done); }
        }))).then(() => true),
        new Promise(done => { const timer = setTimeout(() => done(false), 500); timer.unref(); }),
      ]);
      child.stdout.destroy(); child.stderr.destroy();
      resolve({ code: code || (terminated || overflow || !drained ? 1 : 0),
        stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), quiescent });
    }
    const collect = (stream, chunk) => {
      const prior = stream === 'stdout' ? stdout : stderr;
      const next = Buffer.concat([prior, chunk.subarray(0, Math.max(0, maxBuffer - prior.length))]);
      if (stream === 'stdout') stdout = next; else stderr = next;
      if (prior.length + chunk.length > maxBuffer) { overflow = true; stop(); }
    };
    child.stdout.on('data', chunk => collect('stdout', chunk));
    child.stderr.on('data', chunk => collect('stderr', chunk));
    child.on('error', () => { void finish(1); });
    child.on('exit', (code, sig) => { void finish(sig ? 1 : code); });
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    if (!finishing && timeout > 0) timer = setTimeout(stop, timeout);
  });
}
function json(text) {
  try { return JSON.parse(text); } catch { block('tool-json'); }
}
function searchList(text) {
  const lines = text.trim() ? text.trim().split('\n') : [];
  need(lines.every(l => /^\s*"[^"\r\n]+"\s*$/.test(l)), 'keychain-search-list');
  return lines.map(l => l.trim().slice(1, -1));
}
function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
// Resolve existing directory aliases (e.g. /var -> /private/var on macOS),
// retaining absent suffixes. lstat first: a dangling symlink is not an absent
// directory and must never be treated as a safe suffix. Other errors fail closed.
function canonicalDirectory(directory) {
  try { fs.lstatSync(directory); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return path.join(canonicalDirectory(path.dirname(directory)), path.basename(directory));
  }
  const real = fs.realpathSync(directory);
  need(fs.statSync(real).isDirectory(), 'output-location');
  return real;
}
function outputExists(output) {
  try { fs.lstatSync(output); return true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
}
function otoolLibraries(text) {
  const lines = text.trimEnd().split('\n');
  need(lines.length >= 1 && lines[0].endsWith(':'), 'otool-libraries');
  return lines.slice(1).map(line => {
    const m = /^\s+(.+?) \(compatibility version [^\n]+\)$/.exec(line);
    need(m, 'otool-library-line'); return m[1];
  });
}
function rpaths(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== 'cmd LC_RPATH') continue;
    const m = /^\s*path (.+) \(offset \d+\)$/.exec(lines[i + 2] || '');
    need(m, 'otool-rpath'); out.push(m[1]);
  }
  return out;
}
function roleFor(relative) {
  if (relative === 'Contents/MacOS/Peek' ||
      /^Contents\/Frameworks\/[^/]+\.app\/Contents\/MacOS\/[^/]+$/.test(relative)) return 'electron';
  if (relative === 'Contents/Resources/peek-desktop-helper') return 'standalone';
  return 'library';
}
function candidateRef(tag, sha, ref, actual) {
  need(typeof tag === 'string' && /^v[0-9][A-Za-z0-9._-]*-signing-candidate\.[1-9][0-9]*$/.exec(tag)?.[0] === tag, 'candidate-tag');
  need(/^[a-f0-9]{40}$/.exec(sha)?.[0] === sha, 'source-sha');
  need(ref === `refs/tags/${tag}` && actual === sha, 'candidate-source');
}
function cleanEnv(env) {
  // Allowlist rather than inheriting secret/debug/provider credentials.
  return Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'RUNNER_TEMP', 'LANG', 'LC_ALL',
    'CI', 'GITHUB_ACTIONS'].filter(k => env[k] !== undefined).map(k => [k, env[k]]));
}

// Values are trusted literals, never command/argument interpolation. Unknown
// tools fail closed rather than turning a path or an argv value into a label.
function toolOperation(file, args) {
  const lookup = (table, key) => Object.hasOwn(table, key) ? table[key] : 'unknown';
  const commands = {
    git: { 'rev-parse': 'git-head', status: 'git-status' },
    security: { 'list-keychains': args.includes('-s') ? 'keychain-search-set' : 'keychain-search-read',
      'create-keychain': 'keychain-create', 'set-keychain-settings': 'keychain-settings',
      'unlock-keychain': 'keychain-unlock', import: 'keychain-import',
      'set-key-partition-list': 'keychain-partitions', 'find-identity': 'keychain-identity',
      'delete-keychain': 'keychain-delete' },
    codesign: { '--verify': 'signature-verify', '--display': 'signature-display', '--force': 'dmg-sign' },
    otool: { '-L': 'dependencies', '-D': 'dylib-id', '-l': 'load-commands' },
    hdiutil: { create: 'dmg-create', verify: 'dmg-verify', attach: 'dmg-attach', detach: 'dmg-detach' },
  };
  if (file === process.execPath) return 'builder';
  if (file === 'file') return 'file-type';
  if (file === 'lipo') return 'architectures';
  if (file === 'spctl') return 'gatekeeper';
  if (file === 'ditto') return 'copy-archive';
  if (file === 'xcrun') {
    if (args[0] === '--find') return args[1] === 'notarytool' ? 'find-notarytool' :
      args[1] === 'stapler' ? 'find-stapler' : 'unknown';
    if (args[0] === 'notarytool') return lookup({ 'store-credentials': 'notary-store',
      submit: 'notary-submit', wait: 'notary-wait', log: 'notary-log', info: 'notary-info' }, args[1]);
    if (args[0] === 'stapler') return lookup({ staple: 'staple', validate: 'staple-validate' }, args[1]);
  }
  return Object.hasOwn(commands, file) && Object.hasOwn(commands[file], args[0]) ? commands[file][args[0]] : 'unknown';
}

function createAdapter({ root = path.resolve(__dirname, '..'), temp, output,
  run = runner, env = process.env, platform = process.platform, arch = process.arch } = {}) {
  need(temp && output, 'adapter-paths');
  root = fs.realpathSync(root);
  const scratchRoot = fs.realpathSync(temp);
  need(!within(root, scratchRoot), 'scratch-in-checkout');
  output = path.resolve(output);
  // Canonicalize parents only. Never follow an existing output leaf, including
  // a dangling symlink; preflight must refuse all preexisting output objects.
  output = path.join(canonicalDirectory(path.dirname(output)), path.basename(output));
  need(!within(root, output) && within(scratchRoot, output) && output !== scratchRoot, 'output-location');
  const checkOutputParent = () => {
    need(canonicalDirectory(path.dirname(output)) === path.dirname(output), 'output-location');
  };
  let ownedOutput;
  const discardOutput = () => {
    if (!ownedOutput) return;
    checkOutputParent();
    const current = fs.lstatSync(output);
    need(current.isDirectory() && current.dev === ownedOutput.dev && current.ino === ownedOutput.ino,
      'output-ownership');
    fs.rmSync(output, { recursive: true, force: true });
    ownedOutput = undefined;
  };
  let scratch, keychain, identityHash, originalList, searchChanged = false, keychainCreated = false;
  let mounted = false, mountpoint, childEnv = cleanEnv(env), app, zip, dmg;
  let interrupted = false, unsafeTree = false;
  const abort = new AbortController();
  const summaries = [];
  const inventories = [];
  let stage = 'idle';
  const call = async (file, args, opts = {}) => {
    const operation = toolOperation(file, args);
    const failed = (reason, status) => {
      // Numeric exit status only; never stringify arbitrary runner values.
      const exit = Number.isInteger(status) && status >= 0 && status <= 255 ? `; status=${status}` : '';
      console.error(`macOS candidate tool failed: stage=${stage}; operation=${operation}; reason=${reason}${exit}`);
      block(reason);
    };
    need(operation !== 'unknown', 'tool-operation');
    need(!unsafeTree, 'tool-tree-active');
    if (interrupted && !opts.cleanup) block('interrupted');
    let result;
    try { result = await run(file, args, { cwd: root, env: childEnv,
      timeout: 120000, ...(opts.cleanup ? {} : { signal: abort.signal }), ...opts }); } catch { unsafeTree = true; failed('tool-execution'); }
    if (result?.quiescent !== true) { unsafeTree = true; failed('tool-tree-active'); }
    if (result.code !== 0) failed('tool-exit', result.code);
    return result;
  };
  const text = async (file, args, opts) => (await call(file, args, opts)).stdout;
  const auth = () => ['--keychain', keychain, '--keychain-profile', 'peek-candidate'];
  const staple = async target => { await call('xcrun', ['stapler', 'staple', target]); };
  const validateStaple = async target => { await call('xcrun', ['stapler', 'validate', target]); return true; };
  const gatekeeper = async (target, type) => {
    const result = await call('spctl', ['--assess', '--type', type,
      ...(type === 'open' ? ['--context', 'context:primary-signature'] : []), '--verbose=4', target]);
    need(/^source=Notarized Developer ID\s*$/m.test(result.stderr), 'gatekeeper-source');
    return 'Notarized Developer ID';
  };
  const signature = async target => {
    const result = await call('codesign', ['--display', '--verbose=4', target]);
    return result.stdout + result.stderr;
  };
  const native = async target => {
    const stat = fs.lstatSync(target);
    const description = await text('file', ['-b', target]);
    return { name: path.basename(target), regularFile: stat.isFile(),
      executable: !!(stat.mode & 0o111), machO: /\bMach-O\b/.test(description),
      isMachExecutable: /\bexecutable\b/.test(description),
      architectures: (await text('lipo', ['-archs', target])).trim().split(/\s+/) };
  };
  async function discover(bundle) {
    const found = [];
    const seen = new Set();
    async function visit(target) {
      const real = fs.realpathSync(target);
      need(within(bundle, real), 'bundle-symlink-escape');
      if (seen.has(real)) return;
      seen.add(real);
      const stat = fs.statSync(real);
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(real).sort()) await visit(path.join(real, name));
      } else if (stat.isFile()) {
        if (/\bMach-O\b/.test(await text('file', ['-b', real]))) found.push(real);
      } else block('bundle-special-file');
    }
    await visit(bundle);
    return found.sort();
  }
  async function dependencies(target, bundle, mainRpaths) {
    const libraries = otoolLibraries(await text('otool', ['-L', target]));
    // LC_ID_DYLIB is the first -L entry for a dylib; it is not a dependency.
    const ids = (await text('otool', ['-D', target])).trimEnd().split('\n').slice(1).map(s => s.trim());
    const role = roleFor(path.relative(bundle, target).split(path.sep).join('/'));
    const executableDir = role === 'library' ? path.join(bundle, 'Contents/MacOS') : path.dirname(target);
    const expand = value => value.replace(/^@loader_path(?=\/|$)/, path.dirname(target))
      .replace(/^@executable_path(?=\/|$)/, executableDir);
    const localRpaths = rpaths(await text('otool', ['-l', target])).map(expand);
    return libraries.filter(name => !ids.includes(name)).map(installName => {
      if (installName.startsWith('/')) return installName;
      const candidates = installName.startsWith('@rpath/') ? [...localRpaths, ...mainRpaths].map(p =>
        path.resolve(expand(p), installName.slice(7))) : [path.resolve(expand(installName))];
      const resolved = [...new Set(candidates.filter(p => fs.existsSync(p)).map(p => fs.realpathSync(p)))];
      need(resolved.length === 1 && within(bundle, resolved[0]), 'dyld-resolution');
      return { installName, resolvedPath: path.relative(bundle, resolved[0]).split(path.sep).join('/') };
    });
  }
  async function verifyApp(bundle, policy) {
    bundle = fs.realpathSync(bundle);
    await call('codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle]);
    const info = plist.parse(fs.readFileSync(path.join(bundle, 'Contents/Info.plist'), 'utf8'));
    const build = json(fs.readFileSync(path.join(bundle, 'Contents/Resources/build-info.json'), 'utf8'));
    need(build.commit === policy.commit && build.dirty === false, 'build-info');
    const files = await discover(bundle);
    const mainDir = path.join(bundle, 'Contents/MacOS');
    const mainRpaths = rpaths(await text('otool', ['-l', path.join(mainDir, 'Peek')])).map(p =>
      p.replace(/^@(loader_path|executable_path)(?=\/|$)/, mainDir));
    const inventory = [];
    for (const target of files) {
      const relative = path.relative(bundle, target).split(path.sep).join('/');
      const nativeInfo = await native(target);
      const classified = roleFor(relative);
      const role = classified === 'library' && nativeInfo.isMachExecutable ? 'standalone' : classified;
      await call('codesign', ['--verify', '--strict', '--verbose=2', target]);
      const ent = await call('codesign', ['--display', '--entitlements', ':-', target]);
      // codesign sends its display chatter to stderr and XML to stdout.
      const entitlements = ent.stdout.trim() ? plist.parse(ent.stdout) : {};
      inventory.push({ path: relative, role, strict: true, ...nativeInfo,
        signature: await signature(target), entitlements,
        dependencies: await dependencies(target, bundle, mainRpaths) });
    }
    inventories.push(inventory.map(e => ({ path: e.path, role: e.role,
      architectures: e.architectures, entitlements: e.entitlements,
      signature: {
        authority: e.signature.split(/\r?\n/).find(l => l.startsWith('Authority='))?.slice(10),
        teamId: e.signature.split(/\r?\n/).find(l => l.startsWith('TeamIdentifier='))?.slice(15),
        timestamp: e.signature.split(/\r?\n/).find(l => l.startsWith('Timestamp='))?.slice(10),
        runtime: /flags=0x[\da-f]+\([^)]*\bruntime\b/i.test(e.signature),
      }, dependencies: e.dependencies })));
    return { deepStrict: true, staple: await validateStaple(bundle),
      gatekeeper: await gatekeeper(bundle, 'execute'), bundleId: info.CFBundleIdentifier,
      buildVersion: info.CFBundleVersion, commit: info.PeekBuildCommit,
      inventoryComplete: true, inventory };
  }
  async function submit(target) {
    // Submit without --wait, so the ID survives a bounded wait/timeout. Never
    // resubmit automatically. No raw notary log is uploaded.
    const initial = json(await text('xcrun', ['notarytool', 'submit', target, ...auth(), '--output-format', 'json'], { timeout: 600000 }));
    need(UUID.test(initial.id), 'notary-id');
    summaries.push({ id: initial.id, status: 'Submitted' });
    try {
      const result = json(await text('xcrun', ['notarytool', 'wait', initial.id, ...auth(),
        '--timeout', '20m', '--output-format', 'json'], { timeout: 1250000 }));
      const log = json(await text('xcrun', ['notarytool', 'log', initial.id, ...auth()]));
      need(result.id === initial.id, 'notary-wait-id');
      validateNotary(result, log);
      summaries[summaries.length - 1] = { id: result.id, status: 'Accepted', statusCode: 0, issues: [] };
      return { result, log };
    } catch (error) {
      // Diagnose once, retain only the safe ID; no blind retry or raw output.
      try { await call('xcrun', ['notarytool', 'info', initial.id, ...auth(), '--output-format', 'json']); } catch {}
      throw new SigningError(error instanceof SigningError ? error.code : 'notary-failed', initial.id);
    }
  }
  const operations = {
    async preflight(policy) {
      need(platform === 'darwin' && arch === 'arm64', 'macos-arm64-required');
      for (const [name, version] of [['electron-builder', '26.15.6'], ['@electron/osx-sign', '1.3.3'], ['@electron/notarize', '2.5.0'], ['electron', '43.0.0']]) {
        need(require(path.join(root, 'node_modules', name, 'package.json')).version === version, 'tool-version');
      }
      need((await text('git', ['rev-parse', 'HEAD'])).trim() === policy.commit, 'checkout-sha');
      need(!(await text('git', ['status', '--porcelain', '--untracked-files=normal'])).trim(), 'dirty-checkout');
      await call('xcrun', ['--find', 'notarytool']);
      await call('xcrun', ['--find', 'stapler']);
      checkOutputParent();
      need(!outputExists(output), 'output-already-exists');
      return Promise.all(['peek-desktop-helper', 'nonactivating-window.node'].map(name => native(path.join(root, 'apps/desktop/dist/native', name))));
    },
    async prepare(policy, secrets) {
      let intermediate;
      try { intermediate = fs.readFileSync(path.join(root, 'scripts/DeveloperIDG2CA.cer')); }
      catch { block('intermediate-certificate'); }
      need(crypto.createHash('sha256').update(intermediate).digest('hex') === DEVELOPER_ID_G2_SHA256,
        'intermediate-certificate-hash');
      scratch = fs.mkdtempSync(path.join(scratchRoot, 'peek-signing-'));
      fs.chmodSync(scratch, 0o700);
      keychain = path.join(scratch, 'candidate.keychain-db');
      const password = crypto.randomBytes(32).toString('hex');
      const p12 = path.join(scratch, 'identity.p12');
      need(/^[A-Za-z0-9+/\r\n]+={0,2}$/.test(secrets.MACOS_CERTIFICATE_P12_BASE64), 'p12-base64');
      fs.writeFileSync(p12, Buffer.from(secrets.MACOS_CERTIFICATE_P12_BASE64, 'base64'), { mode: 0o600 });
      originalList = searchList(await text('security', ['list-keychains', '-d', 'user']));
      // create-keychain can itself change the search list. Restore the original
      // even when import/unlock fails before our explicit list replacement.
      searchChanged = true;
      // Mark before calls: cleanup must handle partial success too.
      keychainCreated = true;
      await call('security', ['create-keychain', '-p', password, keychain]);
      await call('security', ['set-keychain-settings', '-lut', '14400', keychain]);
      await call('security', ['unlock-keychain', '-p', password, keychain]);
      await call('security', ['import', p12, '-k', keychain, '-P', secrets.MACOS_CERTIFICATE_PASSWORD, '-T', '/usr/bin/codesign']);
      // Import exactly the bytes checked above, only into our ephemeral keychain.
      const intermediatePath = path.join(scratch, 'DeveloperIDG2CA.cer');
      fs.writeFileSync(intermediatePath, intermediate, { mode: 0o600 });
      await call('security', ['import', intermediatePath, '-k', keychain]);
      await call('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain]);
      searchChanged = true;
      await call('security', ['list-keychains', '-d', 'user', '-s', keychain, ...originalList]);
      const identities = await text('security', ['find-identity', '-v', '-p', 'codesigning', keychain]);
      const matches = [...identities.matchAll(/^\s*\d+\) ([A-Fa-f0-9]{40}) "([^"\n]+)"\s*$/gm)];
      if (matches.length !== 1 || matches[0][2] !== policy.identity) {
        // Only parsed public certificate names/trust tokens may leave the private
        // child-output boundary. JSON quoting prevents multiline/log injection.
        if (matches.length === 0) {
          const all = await text('security', ['find-identity', '-p', 'codesigning', keychain]);
          const present = [...(identities + '\n' + all).matchAll(/^\s*\d+\) [A-Fa-f0-9]{40} "([^"\r\n]+)"(?:[ \t]+\(([^\r\n)]*)\))?[ \t]*$/gm)];
          console.error(present.length ? 'macOS identity diagnostic: identities present but none valid' :
            'macOS identity diagnostic: zero identities at all');
          const reported = new Set();
          for (const entry of present) {
            // Prefer reason-bearing rows if a tool version repeats a bare name.
            if (reported.has(entry[1]) || (!entry[2] && present.some(e => e[1] === entry[1] && e[2]))) continue;
            reported.add(entry[1]);
            const reason = /^CSSMERR_[A-Z0-9_]+$/.test(entry[2] || '') ? entry[2] : 'trust reason unavailable';
            console.error(`macOS identity diagnostic: name=${JSON.stringify(entry[1])}; trust=${reason}`);
          }
        } else {
          console.error('macOS identity diagnostic: valid identity name/count mismatch');
          console.error(`macOS identity diagnostic: configured=${JSON.stringify(policy.identity)}`);
          for (const entry of matches) console.error(`macOS identity diagnostic: found=${JSON.stringify(entry[2])}; equal=${entry[2] === policy.identity}`);
        }
        block('imported-identity');
      }
      identityHash = matches[0][1];
      let authArgs;
      let p8;
      if (policy.authMode === 'api') {
        p8 = path.join(scratch, 'AuthKey.p8');
        fs.writeFileSync(p8, secrets.APPLE_API_KEY_P8, { mode: 0o600 });
        authArgs = ['--key', p8, '--key-id', secrets.APPLE_API_KEY_ID, '--issuer', secrets.APPLE_API_ISSUER];
      } else authArgs = ['--apple-id', secrets.APPLE_ID, '--password', secrets.APPLE_APP_SPECIFIC_PASSWORD, '--team-id', policy.teamId];
      await call('xcrun', ['notarytool', 'store-credentials', 'peek-candidate', '--keychain', keychain, ...authArgs]);
      fs.rmSync(p12); if (p8) fs.rmSync(p8);
      childEnv = { ...childEnv, TMPDIR: scratch, CSC_KEYCHAIN: keychain, CSC_NAME: identityHash,
        APPLE_KEYCHAIN: keychain, APPLE_KEYCHAIN_PROFILE: 'peek-candidate',
        PEEK_SIGNING_CANDIDATE: '1', PEEK_BUILD_VERSION: policy.buildVersion, PEEK_BUILD_COMMIT: policy.commit };
    },
    async pack(policy) {
      // Programmatic builder config extends the unsigned base, overriding null.
      // Custom sign is the pinned osx-sign walker with a minimal per-file policy.
      // Builder performs afterPack + signing during its dir target; signApp below
      // checks that seal. Adapter owns notarization to bound waits and inspect logs.
      const config = { extends: path.join(root, 'apps/desktop/electron-builder.yml'),
        forceCodeSigning: true, buildVersion: policy.buildVersion,
        directories: { output: path.join(scratch, 'pack') },
        // Builder rejects a qualifier starting with 'Developer ID Application:'.
        // Use the preflight-verified fingerprint, not a stripped ambiguous name.
        mac: { identity: identityHash, type: 'distribution', hardenedRuntime: true,
          notarize: false, sign: path.join(root, 'scripts/macos-signing-adapter.cjs'),
          entitlements: path.join(root, 'apps/desktop/assets/entitlements.mac.plist'),
          entitlementsInherit: path.join(root, 'apps/desktop/assets/entitlements.mac.inherit.plist') } };
      const configPath = path.join(scratch, 'builder.json');
      fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
      await call(process.execPath, [path.join(root, 'node_modules/electron-builder/cli.js'),
        '--config', configPath, '--mac', 'dir', '--arm64', '--publish', 'never'], { timeout: 1200000 });
      app = path.join(scratch, 'pack/mac-arm64/Peek.app');
      need(fs.statSync(app).isDirectory(), 'packed-app');
    },
    async signApp() { await call('codesign', ['--verify', '--deep', '--strict', app]); },
    async submitApp() {
      const submission = path.join(scratch, 'notary-app.zip');
      await call('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, submission], { timeout: 300000 });
      return submit(submission);
    },
    async stapleApp() { await staple(app); },
    async verifyApp(policy) { return verifyApp(app, policy); },
    async archive(policy) {
      const staging = path.join(scratch, 'final'); fs.mkdirSync(staging);
      const name = `Peek-${policy.buildVersion}-${policy.commit.slice(0, 12)}-arm64`;
      zip = path.join(staging, name + '.zip'); dmg = path.join(staging, name + '.dmg');
      await call('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip], { timeout: 300000 });
      const image = path.join(scratch, 'image'); fs.mkdirSync(image);
      await call('ditto', [app, path.join(image, 'Peek.app')], { timeout: 300000 });
      fs.symlinkSync('/Applications', path.join(image, 'Applications'));
      await call('hdiutil', ['create', '-volname', 'Peek', '-srcfolder', image, '-format', 'UDZO', dmg], { timeout: 300000 });
    },
    async signDmg(policy) { await call('codesign', ['--force', '--sign', policy.identity, '--keychain', keychain, '--timestamp', dmg]); },
    async submitDmg() { return submit(dmg); },
    async stapleDmg() { await staple(dmg); },
    async verifyDmg() {
      await call('hdiutil', ['verify', dmg], { timeout: 300000 });
      await call('codesign', ['--verify', '--strict', dmg]);
      return { strict: true, container: true, staple: await validateStaple(dmg),
        gatekeeper: await gatekeeper(dmg, 'open'), signature: await signature(dmg) };
    },
    async verifyZip(policy) {
      const destination = path.join(scratch, 'zip-copy'); fs.mkdirSync(destination);
      await call('ditto', ['-x', '-k', zip, destination], { timeout: 300000 });
      need(fs.readdirSync(destination).filter(n => n !== '__MACOSX').join() === 'Peek.app', 'zip-contents');
      return verifyApp(path.join(destination, 'Peek.app'), policy);
    },
    async verifyDmgApp(policy) {
      mountpoint = path.join(scratch, 'mount'); fs.mkdirSync(mountpoint);
      mounted = true;
      await call('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountpoint, dmg]);
      const destination = path.join(scratch, 'dmg-copy'); fs.mkdirSync(destination);
      await call('ditto', [path.join(mountpoint, 'Peek.app'), path.join(destination, 'Peek.app')], { timeout: 300000 });
      const evidence = await verifyApp(path.join(destination, 'Peek.app'), policy);
      await call('hdiutil', ['detach', mountpoint]); mounted = false;
      return evidence;
    },
    async cleanup() {
      // Fail closed: VM disposal, not credential deletion racing a live tool.
      need(!unsafeTree, 'tool-tree-active');
      let failed = false;
      const attempt = async (file, args) => {
        try { await call(file, args, { cleanup: true }); return true; }
        catch { failed = true; return false; }
      };
      if (mounted && await attempt('hdiutil', ['detach', '-force', mountpoint])) mounted = false;
      if (searchChanged && await attempt('security', ['list-keychains', '-d', 'user', '-s', ...originalList])) searchChanged = false;
      if (keychainCreated && await attempt('security', ['delete-keychain', keychain])) keychainCreated = false;
      // Keep only verified final containers until hashFinal. Remove credentials,
      // copies and keychain even when another cleanup action failed.
      need(!unsafeTree, 'tool-tree-active');
      if (scratch) for (const name of fs.readdirSync(scratch)) {
        if (name !== 'final' && !(mounted && name === 'mount')) fs.rmSync(path.join(scratch, name), { recursive: true, force: true });
      }
      need(!failed, 'cleanup-failed');
    },
    async hashFinal() {
      need(!interrupted, 'interrupted');
      const artifacts = [dmg, zip].map(target => ({ name: path.basename(target),
        sha256: crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') }));
      // Output is created only after every verification and credential cleanup.
      checkOutputParent();
      need(!outputExists(output), 'output-already-exists');
      fs.mkdirSync(output, { mode: 0o700 });
      ownedOutput = fs.lstatSync(output);
      for (const target of [dmg, zip]) fs.copyFileSync(target, path.join(output, path.basename(target)), fs.constants.COPYFILE_EXCL);
      fs.rmSync(scratch, { recursive: true, force: true }); scratch = undefined;
      return artifacts;
    },
  };
  // Explicit allowlist: stage never comes from paths, policy, env or errors.
  for (const name of ['preflight', 'prepare', 'pack', 'signApp', 'submitApp', 'stapleApp',
    'verifyApp', 'archive', 'signDmg', 'submitDmg', 'stapleDmg', 'verifyDmg',
    'verifyZip', 'verifyDmgApp', 'cleanup', 'hashFinal']) {
    const operation = operations[name];
    operations[name] = async (...args) => {
      const previous = stage;
      stage = name;
      try { return await operation(...args); } finally { stage = previous; }
    };
  }
  return { operations, summaries, inventories, output, discardOutput, interrupt() { interrupted = true; abort.abort(); },
    async destroy() {
      try { await operations.cleanup(); } finally {
        if (scratch && !mounted && !unsafeTree) fs.rmSync(scratch, { recursive: true, force: true });
      }
    } };
}

// electron-builder's custom sign export, executed only in its isolated child.
async function sign(options) {
  need(process.env.PEEK_SIGNING_CANDIDATE === '1' && options.identity && options.keychain, 'sign-hook-context');
  const root = path.resolve(__dirname, '..');
  const { signAsync } = require('@electron/osx-sign');
  try {
    await signAsync({ ...options, platform: 'darwin', type: 'distribution',
      preAutoEntitlements: false, preEmbedProvisioningProfile: false,
      optionsForFile(target) {
        const relative = path.relative(options.app, target).split(path.sep).join('/');
        const electron = target === options.app || target.endsWith('.app') || roleFor(relative) === 'electron';
        return { hardenedRuntime: true, entitlements: path.join(root, 'apps/desktop/assets',
          electron ? (target === options.app ? 'entitlements.mac.plist' : 'entitlements.mac.inherit.plist') : 'entitlements.mac.helper.plist') };
      } });
  } catch { block('app-signing'); }
}

async function main(env = process.env) {
  need(env.GITHUB_ACTIONS === 'true', 'github-only');
  need(env.GITHUB_REF_PROTECTED === 'true', 'protected-tag-required');
  const checkedHead = await runner('git', ['rev-parse', 'HEAD'], { env: cleanEnv(env) });
  need(checkedHead.code === 0 && checkedHead.quiescent, 'source-tool');
  const head = checkedHead.stdout.trim();
  need(head === env.GITHUB_SHA, 'event-sha');
  candidateRef(env.CANDIDATE_TAG, env.EXPECTED_SOURCE_SHA, env.GITHUB_REF, head);
  const tagged = await runner('git', ['rev-parse', `refs/tags/${env.CANDIDATE_TAG}^{commit}`], { env: cleanEnv(env) });
  need(tagged.code === 0 && tagged.quiescent && tagged.stdout.trim() === head, 'tag-sha');
  const temp = env.RUNNER_TEMP;
  const adapter = createAdapter({ temp, output: path.join(temp, 'peek-verified-candidate'), env });
  const output = adapter.output;
  const interrupt = () => adapter.interrupt();
  process.on('SIGTERM', interrupt); process.on('SIGINT', interrupt);
  try {
    const receipt = await runCandidate({ mode: 'candidate', teamId: env.APPLE_TEAM_ID,
      identity: env.MACOS_SIGNING_IDENTITY, buildVersion: env.CANDIDATE_BUILD_VERSION,
      commit: head, bundleId: 'com.autonome.peek' }, env, adapter.operations);
    fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify({ ...receipt,
      tag: env.CANDIDATE_TAG, buildVersion: env.CANDIDATE_BUILD_VERSION,
      identity: env.MACOS_SIGNING_IDENTITY, teamId: env.APPLE_TEAM_ID,
      notary: adapter.summaries, inventories: adapter.inventories }, null, 2) + '\n');
    console.log('Verified candidate only; no public publication authorized.');
  } catch (error) {
    adapter.discardOutput();
    throw error;
  } finally {
    try { await adapter.destroy(); }
    catch {
      adapter.discardOutput();
      const failure = new SigningError('cleanup-failed');
      failure.submissionIds = adapter.summaries.map(s => s.id);
      throw failure;
    } finally {
      process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
    }
  }
}
if (require.main === module) main().catch(error => {
  const code = error instanceof SigningError ? error.code : 'adapter-failed';
  const ids = [...new Set([...(error.submissionIds || []), error.submissionId].filter(id => UUID.test(id || '')))];
  console.error(`macOS candidate blocked: ${code}${ids.length ? '; submission IDs: ' + ids.join(',') : ''}`);
  process.exitCode = 1;
});
module.exports = { createAdapter, runner, searchList, otoolLibraries, rpaths, roleFor, candidateRef, cleanEnv, sign, main };
