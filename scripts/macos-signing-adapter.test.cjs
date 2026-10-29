'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const plist = require('plist');
const { createAdapter, searchList, otoolLibraries, otoolIds, rpaths, roleFor, candidateRef, cleanEnv, runner } = require('./macos-signing-adapter.cjs');
const { runCandidate } = require('./macos-signing.cjs');
const SHA = 'a'.repeat(40);
const ID = '12345678-1234-1234-1234-123456789abc';
const IDENTITY = 'Developer ID Application: Fixture Owner (ABCDEFGHIJ)';
const input = { mode: 'candidate', commit: SHA, identity: IDENTITY,
  teamId: 'ABCDEFGHIJ', buildVersion: '1.2.3', bundleId: 'com.autonome.peek' };
const secrets = { MACOS_CERTIFICATE_P12_BASE64: Buffer.from('DUMMY P12').toString('base64'),
  MACOS_CERTIFICATE_PASSWORD: 'dummy-password-NEVER-LOG', MACOS_SIGNING_IDENTITY: IDENTITY,
  APPLE_TEAM_ID: 'ABCDEFGHIJ', APPLE_API_KEY_P8: '-----BEGIN PRIVATE KEY-----\nDUMMY\n-----END PRIVATE KEY-----\n',
  APPLE_API_KEY_ID: '1234567890', APPLE_API_ISSUER: ID };
const NATIVE = ['Contents/MacOS/Peek', 'Contents/Resources/peek-desktop-helper',
  'Contents/Resources/nonactivating-window.node'];
function fixture(t, mutation = {}) {
  // External scratch is deliberate even when the harness TMPDIR is the checkout.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'signing-fixture-'));
  const root = path.join(base, 'repo'), temp = path.join(base, 'runner');
  fs.mkdirSync(root); fs.mkdirSync(temp);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const write = (target, value) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value); };
  for (const [name, version] of [['electron-builder', '26.15.6'], ['@electron/osx-sign', '1.3.3'], ['@electron/notarize', '2.5.0'], ['electron', '43.0.0']]) {
    write(path.join(root, 'node_modules', name, 'package.json'), JSON.stringify({ version }));
  }
  for (const name of NATIVE.slice(1)) {
    const target = path.join(root, 'apps/desktop/dist/native', path.basename(name));
    write(target, 'MACHO'); fs.chmodSync(target, 0o755);
  }
  write(path.join(root, 'scripts/DeveloperIDG2CA.cer'), mutation.badIntermediate ? 'tampered' :
    fs.readFileSync(path.join(__dirname, 'DeveloperIDG2CA.cer')));
  const calls = [];
  let app, zipApp, imageApp;
  function makeApp(target) {
    for (const name of NATIVE) { write(path.join(target, name), 'MACHO'); fs.chmodSync(path.join(target, name), 0o755); }
    write(path.join(target, 'Contents/Info.plist'), plist.build({ CFBundleIdentifier: input.bundleId,
      CFBundleVersion: input.buildVersion, PeekBuildCommit: SHA }));
    write(path.join(target, 'Contents/Resources/build-info.json'), JSON.stringify({ commit: SHA, dirty: false }));
    // Framework aliases must not duplicate inventory or recurse forever.
    const framework = path.join(target, 'Contents/Frameworks/Example.framework');
    write(path.join(framework, 'Versions/A/Example'), 'MACHO');
    fs.symlinkSync('A', path.join(framework, 'Versions/Current'));
    fs.symlinkSync('Versions/Current/Example', path.join(framework, 'Example'));
    if (mutation.gpu) {
      const helper = path.join(target, 'Contents/Frameworks/Peek Helper (GPU).app/Contents/MacOS/Peek Helper (GPU)');
      write(helper, 'MACHO'); fs.chmodSync(helper, 0o755);
    }
    if (mutation.escape) fs.symlinkSync(root, path.join(target, 'Contents/escape'));
  }
  const ok = (stdout = '', stderr = '') => ({ code: 0, stdout, stderr, quiescent: true });
  const fakeRun = async (file, args, options) => {
    calls.push({ file, args, options });
    const operand = args.at(-1);
    const target = file === 'otool' ? fs.realpathSync(path.resolve(options.cwd, operand)) : operand;
    if (file === 'otool') mutation.inspectOtool?.(args, options, target);
    // Failure selection uses the real target; inspectOtool sees the actual argv.
    const failureArgs = file === 'otool' ? [...args.slice(0, -1), target] : args;
    if (mutation.active?.(file, args)) return { ...ok(), quiescent: false };
    if (mutation.fail?.(file, failureArgs, calls)) {
      // Simulate every private channel a child/error could populate.
      args.push('SEEDED-PRIVATE-ARGV');
      if (mutation.failureMode === 'throw') throw new Error('SEEDED-PRIVATE-ERROR ' + target);
      return { code: mutation.failureMode === 'status' ? 'SEEDED-PRIVATE-STATUS' : 73,
        stdout: typeof mutation.stdout === 'function' ? mutation.stdout(target) : mutation.stdout ?? secrets.APPLE_API_KEY_ID, stderr: typeof mutation.stderr === 'function' ? mutation.stderr(target) :
          mutation.stderr ?? secrets.MACOS_CERTIFICATE_PASSWORD,
        quiescent: mutation.failureMode !== 'active' };
    }
    if (file === 'git') return ok(args[0] === 'status' ? '' : SHA + '\n');
    if (file === 'file') return ok(fs.readFileSync(target, 'utf8') === 'MACHO' ?
      (target.endsWith('.node') ? 'Mach-O 64-bit bundle arm64\n' :
        target.includes('.framework/') ? 'Mach-O 64-bit dynamically linked shared library arm64\n' : 'Mach-O 64-bit executable arm64\n') : 'ASCII text\n');
    if (file === 'lipo') return ok(mutation.architecture || 'arm64\n');
    if (file === 'security') {
      if (args[0] === 'list-keychains' && !args.includes('-s')) return ok('    "/Users/runner/Library/Keychains/login.keychain-db"\n');
      if (args[0] === 'create-keychain') write(target, 'DUMMY KEYCHAIN');
      if (args[0] === 'find-identity' && mutation.identities) return ok(args.includes('-v') ? mutation.identities.valid : mutation.identities.all);
      if (args[0] === 'find-identity') return ok(`  1) ${'B'.repeat(40)} "${mutation.identity || IDENTITY}"\n     1 valid identities found\n`);
      return ok();
    }
    if (file === process.execPath) {
      const config = JSON.parse(fs.readFileSync(args[2], 'utf8'));
      assert.equal(config.forceCodeSigning, true);
      assert.equal(config.buildVersion, input.buildVersion);
      assert.equal(config.mac.identity, 'B'.repeat(40));
      assert.equal(config.mac.hardenedRuntime, true);
      assert.equal(config.mac.notarize, false); // explicitly managed with bounded log checks
      if (mutation.validateConfig) {
        const { doMergeConfigs, validateConfiguration } = require('app-builder-lib/out/util/config/config.js');
        const baseConfig = require('js-yaml').load(fs.readFileSync(path.join(__dirname, '../apps/desktop/electron-builder.yml'), 'utf8'));
        assert.equal(baseConfig.mac.identity, null);
        const merged = doMergeConfigs([baseConfig, config]);
        assert.equal(merged.mac.identity, 'B'.repeat(40));
        assert.equal(merged.afterPack, 'scripts/electron-after-pack.cjs');
        await validateConfiguration(merged);
      }
      assert.equal(options.env.MACOS_CERTIFICATE_PASSWORD, undefined);
      assert.equal(options.env.APPLE_API_KEY_P8, undefined);
      app = path.join(config.directories.output, 'mac-arm64/Peek.app'); makeApp(app);
      return ok();
    }
    if (file === 'xcrun') {
      if (args[1] === 'validate' && args.includes('-v') && mutation.verboseOutput) return ok(mutation.verboseOutput);
      if (args[0] === 'notarytool') {
        if (args[1] === 'submit') return ok(mutation.invalidJSON ? 'garbage' : JSON.stringify({ id: ID }));
        if (args[1] === 'wait') return ok(JSON.stringify({ id: ID, status: mutation.notaryStatus || 'Accepted' }));
        if (args[1] === 'log') return ok(JSON.stringify({ jobId: ID, status: 'Accepted', statusCode: 0, issues: mutation.issues || null }));
      }
      return ok();
    }
    if (file === 'codesign') {
      if (args.includes('--entitlements')) return ok(plist.build(mutation.entitlements || (roleFor(path.relative(target.split('/Peek.app')[0] + '/Peek.app', target)) === 'electron' ? { 'com.apple.security.cs.allow-jit': true } : {})));
      if (args.includes('--display')) return ok('', `Executable=${target}\nAuthority=${mutation.authority || IDENTITY}\nAuthority=Developer ID Certification Authority\nAuthority=Apple Root CA\nTeamIdentifier=${mutation.team || 'ABCDEFGHIJ'}\nCodeDirectory v=20500 size=42 flags=0x10000(runtime) hashes=10+7 location=embedded\nTimestamp=Oct 27, 2026 at 10:30:00 AM\n`);
      return ok();
    }
    if (file === 'spctl') return ok('', `${target}: accepted\nsource=${mutation.gatekeeper || 'Notarized Developer ID'}\n`);
    if (file === 'otool') {
      const override = mutation.otoolOutput?.(args[0], target);
      if (override !== undefined) return ok(override);
      if (args[0] === '-L') return ok(`${operand}:\n${mutation.dylibId ? `\t${mutation.dylibId} (compatibility version 1.0.0, current version 1.0.0)\n` : ''}\t${mutation.dependency || '/usr/lib/libSystem.B.dylib'} (compatibility version 1.0.0, current version 1336.0.0)\n`);
      if (args[0] === '-D') return ok(`${operand}:\n${mutation.dylibId || ''}\n`);
      return ok('');
    }
    if (file === 'ditto') {
      if (args[0] === '-c') { write(target, 'FINAL ZIP'); zipApp = app; }
      else if (args[0] === '-x') fs.cpSync(zipApp, path.join(target, 'Peek.app'), { recursive: true, verbatimSymlinks: true });
      else fs.cpSync(args[0], target, { recursive: true, verbatimSymlinks: true });
      return ok();
    }
    if (file === 'hdiutil') {
      if (args[0] === 'create') { imageApp = path.join(args[args.indexOf('-srcfolder') + 1], 'Peek.app'); write(target, 'FINAL DMG'); }
      if (args[0] === 'attach') fs.cpSync(imageApp, path.join(args[args.indexOf('-mountpoint') + 1], 'Peek.app'), { recursive: true, verbatimSymlinks: true });
      return ok();
    }
    throw new Error('Unexpected fixture tool');
  };
  const output = mutation.paths?.({ base, root, temp }) || path.join(temp, 'verified');
  const adapter = createAdapter({ root, temp, output, run: fakeRun,
    env: { PATH: '/usr/bin', TMPDIR: temp, ...secrets }, platform: 'darwin', arch: 'arm64' });
  return { adapter, calls, root, temp, output,
    async execute() { try { return await runCandidate(input, secrets, adapter.operations); }
      finally { await adapter.destroy(); } } };
}

for (const failureFlag of [undefined, '-L', '-D', '-l']) {
  test(`otool aliases parenthesized helpers and cleans up after ${failureFlag || 'success'}`, async t => {
    const directories = [];
    const logs = [];
    t.mock.method(console, 'error', line => logs.push(line));
    const relative = 'Contents/Frameworks/Peek Helper (GPU).app/Contents/MacOS/Peek Helper (GPU)';
    const f = fixture(t, {
      gpu: true, dylibId: '@rpath/fixture-self-id',
      inspectOtool(args, options, target) {
        // Model LLVM's archive-member operand interpretation before resolving it.
        if (/\(.*\)$/.test(args.at(-1))) throw new Error('archive member operand');
        assert.equal(args.at(-1), 'target');
        assert.ok(fs.lstatSync(path.join(options.cwd, 'target')).isSymbolicLink());
        assert.equal(fs.realpathSync(path.join(options.cwd, 'target')), target);
        assert.equal(fs.statSync(options.cwd).mode & 0o777, 0o700);
        for (const directory of directories) assert.equal(fs.existsSync(directory), false);
        directories.push(options.cwd);
      },
      fail: (file, args) => file === 'otool' && args[0] === failureFlag && args.at(-1).endsWith('/' + relative),
    });
    if (failureFlag) {
      await assert.rejects(f.execute(), { code: 'tool-exit' });
      assert.ok(logs.includes(`macOS candidate tool target: "${relative}"`));
    } else {
      await f.execute();
      // The alias header is ignored and -D still removes the self ID from -L.
      assert.ok(f.calls.filter(c => c.file === 'otool').length > 12);
    }
    assert.ok(directories.length > 0);
    for (const directory of directories) assert.equal(fs.existsSync(directory), false);
  });
}

test('fat llvm-otool output returns unions without architecture headers', async t => {
  const library = name => `\t${name} (compatibility version 1.0.0, current version 1.0.0)\n`;
  const fat = (x86, arm) => `target (architecture x86_64):\n${x86}target (architecture arm64):\n${arm}`;
  const self = '@rpath/fixture-self-id';
  const system = '/usr/lib/libSystem.B.dylib';
  const extra = '/usr/lib/libobjc.A.dylib';
  const libraries = fat(library(self) + library(system), library(self) + library(system) + library(extra));
  const ids = fat(self + '\n', self + '\n');
  const loadCommands = fat('Load command 0\n          cmd LC_RPATH\n      cmdsize 32\n         path @loader_path (offset 12)\n',
    'Load command 0\n          cmd LC_RPATH\n      cmdsize 48\n         path @executable_path/../Frameworks (offset 12)\n');
  assert.deepEqual(otoolLibraries(libraries), [self, system, extra]);
  assert.deepEqual(otoolIds(ids), [self]);
  assert.deepEqual(otoolLibraries(fat('', '')), []);
  assert.deepEqual(otoolIds(fat('', '')), []);
  assert.deepEqual(rpaths(loadCommands), ['@loader_path', '@executable_path/../Frameworks']);
  const f = fixture(t, { otoolOutput: flag => ({ '-L': libraries, '-D': ids, '-l': loadCommands })[flag] });
  await f.execute(); // A leaked header or self ID would fail dyld resolution.
});

for (const [flag, output, reason, offending] of [
  ['-L', 'not a header\n', 'otool-libraries', 'not a header'],
  ['-L', 'target:\n bad dependency /private/keychains/private.keychain-db\n', 'otool-library-line', 'bad dependency NAME'],
  ['-L', 'target:\n\t@rpath/Example.framework/Example (weird suffix)\n', 'otool-library-line', 'NAME (weird suffix)'],
  ['-l', 'target:\n cmd LC_RPATH\n cmdsize 32\n bad path /private/keychains/private.keychain-db\n', 'otool-rpath', 'bad path NAME'],
  ['-L', `target:\n ${secrets.MACOS_CERTIFICATE_PASSWORD}\n`, 'otool-library-line', null],
  ['-L', `target:\n ${'x'.repeat(241)}\n`, 'otool-library-line', null],
]) {
  test(`parse failure ${reason} reports bounded sanitized context (${offending || 'redacted'})`, async t => {
    const logs = [];
    t.mock.method(console, 'error', line => logs.push(line));
    const relative = flag === '-l' ? 'Contents/MacOS/Peek' : 'Contents/Frameworks/Example.framework/Versions/A/Example';
    const f = fixture(t, { otoolOutput: (operation, target) =>
      operation === flag && target.endsWith('/' + relative) ? output : undefined });
    await assert.rejects(f.execute(), { code: reason });
    assert.ok(logs.includes(`macOS candidate tool target: ${JSON.stringify(relative)}; line=${offending ? JSON.stringify(offending) : '<redacted>'}`));
    assert.ok(logs.includes(`macOS candidate tool parse failed: reason=${reason}; flag=${flag}`));
    assert.ok(!logs.join('\n').includes('/private/keychains'));
    for (const value of Object.values(secrets)) assert.ok(!logs.join('\n').includes(value));
  });
}

test('pinned intermediate is imported only into the ephemeral keychain before identity lookup', async t => {
  const f = fixture(t);
  await f.execute();
  const imports = f.calls.filter(c => c.file === 'security' && c.args[0] === 'import');
  assert.equal(imports.length, 2);
  assert.equal(path.basename(imports[1].args[1]), 'DeveloperIDG2CA.cer');
  assert.equal(imports[1].args[3], imports[0].args[3]);
  assert.ok(imports[1].args[3].startsWith(fs.realpathSync(f.temp) + path.sep));
  assert.ok(f.calls.indexOf(imports[1]) < f.calls.findIndex(c => c.args[0] === 'find-identity'));
});

test('intermediate hash mismatch refuses before any security operation', async t => {
  const f = fixture(t, { badIntermediate: true });
  await assert.rejects(f.execute(), { code: 'intermediate-certificate-hash' });
  assert.equal(f.calls.some(c => c.file === 'security'), false);
});

for (const scenario of [
  { name: 'zero identities at all', valid: '0 valid identities found', all: '0 identities found' },
  { name: 'identities present but none valid', valid: '0 valid identities found',
    all: `  1) ${'B'.repeat(40)} "${IDENTITY}" (CSSMERR_TP_NOT_TRUSTED)\n`, reason: 'CSSMERR_TP_NOT_TRUSTED' },
  { name: 'identities present but none valid (reason in valid-only query)',
    valid: `  1) ${'B'.repeat(40)} "${IDENTITY}" (CSSMERR_TP_CERT_EXPIRED)\n`,
    all: `  1) ${'B'.repeat(40)} "${IDENTITY}"\n`, reason: 'CSSMERR_TP_CERT_EXPIRED' },
  { name: 'valid identity name/count mismatch', valid: `  1) ${'B'.repeat(40)} "Another Owner"\n`, all: '', reason: 'Another Owner' },
]) {
  test(`identity failure explains ${scenario.name} without private output`, async t => {
    const f = fixture(t, { identities: scenario });
    const lines = [];
    const original = console.error;
    console.error = line => lines.push(line);
    try { await assert.rejects(f.execute(), { code: 'imported-identity' }); }
    finally { console.error = original; }
    const log = lines.join('\n');
    assert.ok(log.includes(scenario.name.split(' (')[0]));
    if (scenario.reason) assert.ok(log.includes(scenario.reason));
    if (scenario.name.startsWith('valid')) assert.ok(log.includes(IDENTITY));
    assert.ok(!log.includes(secrets.MACOS_CERTIFICATE_PASSWORD));
    assert.ok(!log.includes(secrets.APPLE_API_KEY_P8));
    const lookups = f.calls.filter(c => c.args[0] === 'find-identity');
    assert.equal(lookups.length, scenario.name.startsWith('valid') ? 1 : 2);
    assert.ok(lookups.every(c => c.args.at(-1).startsWith(fs.realpathSync(f.temp) + path.sep)));
  });
}

test('output through a portable temp-root alias uses canonical paths throughout publication and cleanup', async t => {
  const f = fixture(t, { paths({ base, temp }) {
    const alias = path.join(base, 'temp-alias');
    fs.symlinkSync(temp, alias);
    return path.join(alias, 'verified');
  } });
  assert.equal(f.adapter.output, path.join(fs.realpathSync(f.temp), 'verified'));
  await f.execute();
  assert.equal(fs.readdirSync(f.output).length, 2);
  await f.adapter.discardOutput();
  assert.deepEqual(fs.readdirSync(f.temp), []);
});

test('an internal directory alias publishes only beneath its canonical scratch directory', async t => {
  const f = fixture(t, { paths({ temp }) {
    const parent = path.join(temp, 'actual'); fs.mkdirSync(parent);
    fs.symlinkSync(parent, path.join(temp, 'alias'));
    return path.join(temp, 'alias/verified');
  } });
  assert.equal(f.adapter.output, path.join(fs.realpathSync(f.temp), 'actual/verified'));
  await f.execute();
  assert.equal(fs.readdirSync(f.output).length, 2);
  f.adapter.discardOutput();
  assert.deepEqual(fs.readdirSync(path.dirname(f.output)), []);
});

for (const createParent of [false, true]) {
  test(`absent output ancestors remain bounded; parent created before publication: ${createParent}`, async t => {
    const f = fixture(t, { paths({ temp }) { return path.join(temp, 'new/nested/verified'); },
      fail(file, args) {
        if (createParent && file === 'security' && args[0] === 'delete-keychain') {
          fs.mkdirSync(path.dirname(f.output), { recursive: true });
        }
        return false;
      } });
    assert.equal(f.adapter.output, path.join(fs.realpathSync(f.temp), 'new/nested/verified'));
    if (createParent) {
      await f.execute();
      assert.equal(fs.readdirSync(f.output).length, 2);
    } else {
      await assert.rejects(f.execute(), { code: 'hash-failed' });
      assert.equal(fs.existsSync(path.dirname(f.output)), false);
    }
    f.adapter.discardOutput();
    assert.equal(fs.existsSync(f.output), false);
  });
}

test('output boundary resolves existing ancestors without following the output leaf', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'signing-paths-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo'), temp = path.join(base, 'runner');
  fs.mkdirSync(root); fs.mkdirSync(temp);
  const alias = path.join(base, 'alias'); fs.symlinkSync(temp, alias);
  const checkout = path.join(temp, 'checkout'); fs.symlinkSync(root, checkout);
  const outside = path.join(base, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(temp, 'escape'));
  fs.symlinkSync(path.join(base, 'missing'), path.join(temp, 'dangling-parent'));
  fs.writeFileSync(path.join(temp, 'file-parent'), 'KEEP');
  fs.symlinkSync('loop', path.join(temp, 'loop'));
  const make = output => createAdapter({ root, temp: alias, output });
  const a = make(path.join(alias, 'new-parent/verified'));
  assert.equal(a.output, path.join(fs.realpathSync(temp), 'new-parent/verified'));
  await a.destroy();
  for (const output of [path.join(temp, 'escape/verified'), path.join(checkout, 'verified'),
    path.join(base, 'runner-sibling/verified'), temp, path.join(temp, 'file-parent/verified')]) {
    assert.throws(() => make(output), { code: 'output-location' });
  }
  assert.throws(() => make(path.join(temp, 'dangling-parent/verified')));
  assert.throws(() => make(path.join(temp, 'loop/verified')));
  assert.throws(() => createAdapter({ root, temp: checkout, output: path.join(checkout, 'verified') }),
    { code: 'scratch-in-checkout' });
});

for (const kind of ['directory', 'file', 'symlink', 'dangling-symlink']) {
  test(`preexisting output ${kind} is refused and never cleaned up`, async t => {
    let existing;
    const f = fixture(t, { paths({ base, temp }) {
      existing = path.join(temp, 'verified');
      if (kind === 'directory') fs.mkdirSync(existing);
      else if (kind === 'file') fs.writeFileSync(existing, 'KEEP');
      else {
        const target = path.join(base, 'user-data');
        if (kind === 'symlink') fs.writeFileSync(target, 'KEEP');
        fs.symlinkSync(target, existing);
      }
      return existing;
    } });
    await assert.rejects(f.execute(), { code: 'output-already-exists' });
    await f.adapter.discardOutput();
    assert.ok(fs.lstatSync(existing));
    if (kind === 'file' || kind === 'symlink') assert.equal(fs.readFileSync(existing, 'utf8'), 'KEEP');
    assert.ok(!f.calls.some(c => c.file === 'security'), 'preflight refuses before credentials');
  });
}

test('output appearing after preflight is not overwritten or cleaned up', async t => {
  const f = fixture(t, { fail(file, args) {
    if (file === 'security' && args[0] === 'delete-keychain') {
      fs.mkdirSync(f.output);
      fs.writeFileSync(path.join(f.output, 'keep'), 'KEEP');
    }
    return false;
  } });
  await assert.rejects(f.execute(), { code: 'hash-failed' });
  f.adapter.discardOutput();
  assert.equal(fs.readFileSync(path.join(f.output, 'keep'), 'utf8'), 'KEEP');
});

test('a newly created output ancestor cannot redirect publication outside scratch', async t => {
  let outside;
  const f = fixture(t, { paths({ base, temp }) {
    outside = path.join(base, 'outside'); fs.mkdirSync(outside);
    return path.join(temp, 'new-parent/verified');
  }, fail(file, args) {
    if (file === 'security' && args[0] === 'delete-keychain') {
      fs.symlinkSync(outside, path.dirname(f.output));
    }
    return false;
  } });
  await assert.rejects(f.execute(), { code: 'hash-failed' });
  f.adapter.discardOutput();
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('partial publication cleanup removes only adapter-created output', async t => {
  const f = fixture(t);
  const copy = fs.copyFileSync;
  t.mock.method(fs, 'copyFileSync', (source, destination, flags) => {
    if (path.dirname(destination) === f.adapter.output && destination.endsWith('.zip')) {
      throw new Error('fixture copy failure');
    }
    return copy(source, destination, flags);
  });
  await assert.rejects(f.execute(), { code: 'hash-failed' });
  assert.equal(fs.readdirSync(f.output).length, 1);
  f.adapter.discardOutput();
  f.adapter.discardOutput(); // idempotent after successful removal
  assert.equal(fs.existsSync(f.output), false);
});

test('owned-output cleanup refuses a replacement leaf and leaves its target untouched', async t => {
  const f = fixture(t);
  await f.execute();
  const saved = f.output + '-saved';
  fs.renameSync(f.output, saved);
  fs.symlinkSync(saved, f.output);
  assert.throws(() => f.adapter.discardOutput(), { code: 'output-ownership' });
  assert.equal(fs.readdirSync(saved).length, 2);
  assert.ok(fs.lstatSync(f.output).isSymbolicLink());
});

test('owned-output cleanup refuses a redirected parent without touching either directory', async t => {
  const f = fixture(t, { paths({ temp }) {
    const parent = path.join(temp, 'parent'); fs.mkdirSync(parent);
    return path.join(parent, 'verified');
  } });
  await f.execute();
  const parent = path.dirname(f.output), saved = parent + '-saved';
  fs.renameSync(parent, saved);
  const replacement = path.join(f.temp, 'replacement'); fs.mkdirSync(replacement);
  fs.mkdirSync(path.join(replacement, 'verified'));
  fs.writeFileSync(path.join(replacement, 'verified/keep'), 'KEEP');
  fs.symlinkSync(replacement, parent);
  assert.throws(() => f.adapter.discardOutput(), { code: 'output-location' });
  assert.equal(fs.readdirSync(path.join(saved, 'verified')).length, 2);
  assert.equal(fs.readFileSync(path.join(replacement, 'verified/keep'), 'utf8'), 'KEEP');
});

test('real adapter parses tools, verifies staging and two copies, restores search list before hash/output', async t => {
  const f = fixture(t, { validateConfig: true });
  const receipt = await f.execute();
  assert.equal(receipt.artifacts.length, 2);
  assert.equal(f.adapter.inventories.length, 3);
  assert.equal(f.adapter.inventories[0].length, 4); // one canonical framework file
  assert.deepEqual(fs.readdirSync(f.output).sort(), receipt.artifacts.map(a => a.name).sort());
  assert.deepEqual(fs.readdirSync(f.temp), ['verified']);
  const calls = f.calls;
  const at = predicate => calls.findIndex(predicate);
  const appStaple = at(c => c.file === 'xcrun' && c.args[0] === 'stapler' && c.args[1] === 'staple');
  const image = at(c => c.file === 'hdiutil' && c.args[0] === 'create');
  assert.ok(appStaple > 0 && image > appStaple);
  const restored = calls.findLast(c => c.file === 'security' && c.args.includes('-s') && c.args[0] === 'list-keychains');
  assert.deepEqual(restored.args, ['list-keychains', '-d', 'user', '-s', '/Users/runner/Library/Keychains/login.keychain-db']);
  assert.ok(calls.some(c => c.file === 'security' && c.args[0] === 'delete-keychain'));
  assert.ok(!JSON.stringify(receipt).includes('dummy-password'));
  assert.ok(!JSON.stringify(f.adapter.inventories).includes(f.temp));
  assert.equal(f.adapter.inventories[0][0].signature.authority, IDENTITY);
});

for (const [name, mutation, expected] of [
  ['wrong architecture', { architecture: 'x86_64' }, 'native-architecture'],
  ['wrong imported identity', { identity: 'wrong' }, 'imported-identity'],
  ['wrong authority', { authority: 'Developer ID Application: Wrong (ABCDEFGHIJ)' }, 'signature-authority'],
  ['wrong team', { team: 'ZZZZZZZZZZ' }, 'signature-team'],
  ['broad entitlements', { entitlements: { 'com.apple.security.cs.disable-library-validation': true } }, 'minimal-entitlements'],
  ['external dylib', { dependency: '/opt/homebrew/lib/libbad.dylib' }, 'external-dependency'],
  ['notary Invalid', { notaryStatus: 'Invalid' }, 'notary-not-accepted'],
  ['notary In Progress', { notaryStatus: 'In Progress' }, 'notary-not-accepted'],
  ['notary warning', { issues: [{ severity: 'warning' }] }, 'notary-log-rejected'],
  ['notary malformed JSON', { invalidJSON: true }, 'tool-json'],
  ['Gatekeeper wrong source', { gatekeeper: 'Unnotarized Developer ID' }, 'gatekeeper-source'],
  ['symlink outside bundle', { escape: true }, 'bundle-symlink-escape'],
  ['partial prepare failure', { fail: (file, args) => file === 'security' && args[0] === 'import' }, 'tool-exit'],
  ['notary wait timeout', { fail: (file, args) => file === 'xcrun' && args[1] === 'wait' }, 'tool-exit'],
  ['staple validation failure', { fail: (file, args) => file === 'xcrun' && args[0] === 'stapler' && args[1] === 'validate' }, 'tool-exit'],
  ['ZIP copy invalid', { fail: (file, args) => file === 'codesign' && args.at(-1).includes('zip-copy') }, 'tool-exit'],
  ['DMG copy invalid', { fail: (file, args) => file === 'codesign' && args.at(-1).includes('dmg-copy') }, 'tool-exit'],
]) test(`${name} blocks both outputs and removes private scratch`, async t => {
  const f = fixture(t, mutation);
  await assert.rejects(f.execute(), error => {
    assert.equal(error.code, expected);
    assert.ok(!error.message.includes(secrets.MACOS_CERTIFICATE_PASSWORD));
    if (name === 'notary wait timeout') assert.ok(error.submissionIds.includes(ID));
    return true;
  });
  assert.equal(fs.existsSync(f.output), false);
  assert.deepEqual(fs.readdirSync(f.temp), []);
  if (name === 'notary wait timeout') assert.ok(f.calls.some(c => c.file === 'xcrun' && c.args[1] === 'info'));
});

for (const stderr of ['truncated load command\nSECOND LINE', '/private/secret: invalid',
  'bad $TOKEN', 'bad\u001b[31m', 'bad C:\\private\\secret', secrets.MACOS_CERTIFICATE_PASSWORD]) {
  test(`nested dependency failure has bounded inventory evidence: ${JSON.stringify(stderr)}`, async t => {
    const logs = [];
    t.mock.method(console, 'error', line => logs.push(line));
    const f = fixture(t, { stderr, fail: (file, args) => file === 'otool' && args[0] === '-L' &&
      args.at(-1).endsWith('/Contents/Frameworks/Example.framework/Versions/A/Example') });
    await assert.rejects(f.execute(), { code: 'tool-exit' });
    const index = logs.findIndex(line => line.startsWith('macOS candidate tool target:'));
    assert.ok(index >= 0);
    assert.equal(logs[index], 'macOS candidate tool target: "Contents/Frameworks/Example.framework/Versions/A/Example"' +
      (stderr.startsWith('truncated') ? '; stderr="truncated load command"' :
        stderr.startsWith('/private/') ? '; stderr="<path>: invalid"' : ''));
    assert.equal(logs[index + 1], 'macOS candidate tool failed: stage=verifyApp; operation=dependencies; reason=tool-exit; status=73; flag=-L');
    assert.equal(fs.existsSync(f.output), false);
    assert.deepEqual(fs.readdirSync(f.temp), []);
  });
}

for (const kind of ['canonical', 'var alias', 'repeated', 'other path', 'adjacent path', 'secret', 'long']) {
  test(`bundle-path stderr is redacted before filtering: ${kind}`, async t => {
    const logs = [];
    t.mock.method(console, 'error', line => logs.push(line));
    const relative = 'Contents/Frameworks/Example.framework/Versions/A/Example';
    const f = fixture(t, {
      fail: (file, args) => file === 'otool' && args[0] === '-L' && args.at(-1).endsWith('/' + relative),
      stderr(target) {
        assert.equal(target, fs.realpathSync(target), 'tool receives canonical target even with aliased TMPDIR');
        const operand = kind === 'var alias' && target.startsWith('/private/var/') ? target.slice('/private'.length) : target;
        if (kind === 'repeated') return `otool: "${operand}" and '${operand}': invalid`;
        const extra = { 'other path': ' /private/secret', 'adjacent path': ':/private/secret',
          secret: ' ' + secrets.MACOS_CERTIFICATE_PASSWORD, long: ' ' + 'x'.repeat(241) }[kind] || '';
        return `otool: "${operand}": invalid${extra}\nPRIVATE SECOND LINE`;
      },
    });
    await assert.rejects(f.execute(), { code: 'tool-exit' });
    const detail = kind === 'repeated' ? `otool: "<bundle>/${relative}" and '<bundle>/${relative}': invalid` :
      `otool: "<bundle>/${relative}": invalid`;
    const suppressed = ['secret', 'long'].includes(kind);
    const extra = { 'other path': ' <path>', 'adjacent path': ':<path>' }[kind] || '';
    assert.equal(logs.find(line => line.startsWith('macOS candidate tool target:')),
      `macOS candidate tool target: "${relative}"` + (suppressed ? '' : `; stderr=${JSON.stringify(detail + extra)}`));
    assert.equal(fs.existsSync(f.output), false);
    assert.deepEqual(fs.readdirSync(f.temp), []);
  });
}

for (const flag of ['-L', '-D', '-l']) {
  for (const channel of ['stderr', 'stdout', 'secret stderr', 'secret stdout']) {
    test(`otool ${flag} diagnoses ${channel} without tool paths or credentials`, async t => {
      const logs = [];
      t.mock.method(console, 'error', line => logs.push(line));
      const relative = 'Contents/Frameworks/Peek Helper (GPU).app/Contents/MacOS/Peek Helper (GPU)';
      const line = target => `/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/otool-classic: can't open file: ${target} (No such file or directory)\nPRIVATE SECOND LINE`;
      const secret = channel.startsWith('secret');
      const stdout = channel.endsWith('stdout');
      const diagnostic = target => secret ? `can't open file ${secrets.MACOS_CERTIFICATE_PASSWORD}` : line(target);
      const f = fixture(t, {
        gpu: true,
        fail: (file, args) => file === 'otool' && args[0] === flag && args.at(-1).endsWith('/' + relative),
        stderr: stdout ? '' : diagnostic, stdout: stdout ? diagnostic : 'UNUSED STDOUT',
      });
      await assert.rejects(f.execute(), { code: 'tool-exit' });
      const target = `macOS candidate tool target: "${relative}"`;
      const detail = `<path>: can't open file: <bundle>/${relative} (No such file or directory)`;
      assert.equal(logs.find(value => value.startsWith('macOS candidate tool target:')),
        target + (stdout ? '; stderr=<empty>' : '') +
        (secret ? '' : `; ${stdout ? 'stdout' : 'stderr'}=${JSON.stringify(detail)}`));
      assert.ok(logs.some(value => value.endsWith(`; flag=${flag}`)));
      const log = logs.join('\n');
      for (const value of [f.temp, '/Applications/', ...Object.values(secrets)]) {
        assert.ok(!log.includes(value));
      }
      assert.equal(fs.existsSync(f.output), false);
      assert.deepEqual(fs.readdirSync(f.temp), []);
    });
  }
}

test('every reachable tool failure emits only fixed stage/operation/reason and bounded numeric status', async t => {
  const logs = [];
  t.mock.method(console, 'error', (...args) => {
    assert.equal(args.length, 1, 'no hidden error/command objects in extra console arguments');
    logs.push(args[0]);
  });
  const baseline = fixture(t);
  await baseline.execute();
  const count = baseline.calls.length;
  assert.ok(count > 100, 'covers staging, ZIP and mounted DMG verification plus cleanup');
  for (const mode of ['exit', 'throw', 'active', 'status']) {
    for (let index = 1; index <= count; index++) {
      logs.length = 0;
      const f = fixture(t, { failureMode: mode, fail: (_file, _args, calls) => calls.length === index });
      await assert.rejects(f.execute());
      assert.equal(fs.existsSync(f.output), false);
      assert.ok(logs.length >= 1, `${mode} call ${index} is diagnosed`);
      for (const line of logs) {
        if (line.startsWith('macOS candidate tool target:')) {
          const target = JSON.parse(line.slice('macOS candidate tool target: '.length));
          assert.ok(target === '.' || target.startsWith('Contents/'));
          assert.ok(!target.includes('..'));
          continue;
        }
        if (line.startsWith('macOS candidate tool output:')) {
          assert.match(line, /; (?:stdout|stderr)\[[1-8]\]=<redacted>$/);
          continue;
        }
        assert.match(line, /^macOS candidate tool failed: stage=(?:preflight|prepare|pack|signApp|submitApp|stapleApp|verifyApp|archive|signDmg|submitDmg|stapleDmg|verifyDmg|verifyZip|verifyDmgApp|cleanup); operation=[a-z-]+; reason=tool-(?:exit|execution|tree-active)(?:; status=73)?(?:; flag=-(?:L|D|l))?$/);
        assert.doesNotMatch(line, /unknown|SEEDED|SECRET-TOOL-OUTPUT|dummy-password|PRIVATE KEY/);
        for (const value of [f.root, f.temp, ...Object.values(secrets)]) assert.ok(!line.includes(value));
        assert.equal(line.includes('status='), mode === 'exit');
      }
      // Avoid retaining hundreds of fixture trees until this test completes.
      fs.rmSync(path.dirname(f.root), { recursive: true, force: true });
    }
  }
});

for (const verbose of ['success', 'exit', 'throw', 'active']) {
  test(`staple diagnostics are bounded, redacted and cannot override failure (${verbose})`, async t => {
    const logs = [];
    t.mock.method(console, 'error', line => logs.push(line));
    const f = fixture(t, {
      fail(file, args) {
        if (file !== 'xcrun' || args[1] !== 'validate') return false;
        if (args.includes('-v')) {
          if (verbose === 'throw') throw new Error('private diagnostic error');
          return verbose === 'exit';
        }
        return true;
      },
      active: (file, args) => verbose === 'active' && file === 'xcrun' && args.includes('-v'),
      stdout: target => `Processing: ${target}\nChecking ticket\n${target} does not have a ticket stapled to it.\n${secrets.MACOS_CERTIFICATE_PASSWORD}\n${secrets.APPLE_API_KEY_ID}\n/private/keychain.keychain-db\n${'x'.repeat(241)}\nLast allowed line\nNinth hidden line`,
      stderr: 'First stderr line\n' + secrets.APPLE_API_ISSUER,
    });
    const unsafe = verbose === 'throw' || verbose === 'active';
    await assert.rejects(f.execute(), { code: unsafe ? 'tool-tree-active' : 'tool-exit' });
    const calls = f.calls.filter(c => c.file === 'xcrun' && c.args[1] === 'validate');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].args.slice(0, 3), ['stapler', 'validate', '-v']);
    assert.equal(calls[0].options.timeout, 120000);
    assert.equal(calls[1].options.timeout, 120000);
    assert.equal(calls[0].options.signal, calls[1].options.signal);
    const log = logs.join('\n');
    assert.match(log, /stdout\[1\]="Processing: <bundle>"/);
    assert.match(log, /stdout\[3\]="<bundle> does not have a ticket stapled to it\."/);
    assert.match(log, /stdout\[8\]="Last allowed line"/);
    assert.doesNotMatch(log, /Ninth hidden line|private diagnostic error/);
    for (const value of [f.temp, ...Object.values(secrets)]) assert.ok(!log.includes(value));
    if (verbose === 'exit') assert.match(log, /diagnostic=verbose; stdout\[3\]=/);
    if (verbose === 'active') assert.match(log, /reason=tool-tree-active/);
    assert.equal(fs.existsSync(f.output), false);
    if (!unsafe) assert.deepEqual(fs.readdirSync(f.temp), []);
  });
}

test('successful verbose validation prints evidence without changing the failed verdict', async t => {
  const logs = [];
  t.mock.method(console, 'error', line => logs.push(line));
  const f = fixture(t, { verboseOutput: 'Verbose ticket details\n' + secrets.MACOS_CERTIFICATE_PASSWORD,
    fail: (file, args) => file === 'xcrun' && args[1] === 'validate' && !args.includes('-v') });
  await assert.rejects(f.execute(), { code: 'tool-exit' });
  assert.equal(f.calls.filter(c => c.file === 'xcrun' && c.args.includes('-v') && c.args[1] === 'validate').length, 1);
  assert.ok(logs.some(line => line.endsWith('diagnostic=verbose; stdout[1]="Verbose ticket details"')));
  assert.ok(logs.some(line => line.endsWith('diagnostic=verbose; stdout[2]=<redacted>')));
});

test('prepare and cleanup diagnostics distinguish import, restore and delete without argv', async t => {
  const logs = [];
  t.mock.method(console, 'error', line => logs.push(line));
  const f = fixture(t, { fail: (file, args) => file === 'security' &&
    (args[0] === 'import' || args[0] === 'delete-keychain' || (args[0] === 'list-keychains' && args.includes('-s'))) });
  await assert.rejects(f.execute());
  assert.ok(logs.some(l => l.includes('stage=prepare; operation=keychain-import; reason=tool-exit; status=73')));
  assert.ok(logs.some(l => l.includes('stage=cleanup; operation=keychain-search-set; reason=tool-exit; status=73')));
  assert.ok(logs.some(l => l.includes('stage=cleanup; operation=keychain-delete; reason=tool-exit; status=73')));
});

test('cleanup failure never creates output', async t => {
  const f = fixture(t, { fail: (file, args) => file === 'security' && args[0] === 'delete-keychain' });
  await assert.rejects(f.execute(), { code: 'cleanup-failed' });
  assert.equal(fs.existsSync(f.output), false);
});
for (const phase of ['import', 'list-keychains']) test(`unverified tool quiescence preserves scratch and stops cleanup: ${phase}`, async t => {
  let armed = phase === 'import';
  const f = fixture(t, { active: (file, args) => armed && file === 'security' && args[0] === phase });
  if (phase === 'import') {
    await assert.rejects(f.adapter.operations.prepare({ ...input, authMode: 'api' }, secrets), { code: 'tool-tree-active' });
  } else {
    await f.adapter.operations.prepare({ ...input, authMode: 'api' }, secrets);
    armed = true;
    await assert.rejects(f.adapter.operations.cleanup(), { code: 'tool-tree-active' });
  }
  const count = f.calls.length;
  await assert.rejects(f.adapter.destroy(), { code: 'tool-tree-active' });
  assert.equal(f.calls.length, count, 'no further tool or credential cleanup after unsafe result');
  assert.ok(fs.readdirSync(f.temp).length > 0, 'scratch retained for VM disposal');
  assert.equal(fs.existsSync(f.output), false);
});
test('cancellation interrupts operations but permits credential cleanup', async t => {
  const f = fixture(t);
  await f.adapter.operations.prepare({ ...input, authMode: 'api' }, secrets);
  f.adapter.interrupt();
  await assert.rejects(f.adapter.operations.signApp(), { code: 'interrupted' });
  await f.adapter.destroy();
  assert.deepEqual(fs.readdirSync(f.temp), []);
  assert.ok(f.calls.some(c => c.file === 'security' && c.args[0] === 'delete-keychain'));
});
test('ref selection rejects branches, mutable-ref mismatch, malformed tags and SHA', () => {
  const tag = 'v0.0.1-signing-candidate.1';
  candidateRef(tag, SHA, `refs/tags/${tag}`, SHA);
  for (const args of [[tag, SHA, 'refs/heads/main', SHA], [tag, SHA, `refs/tags/${tag}`, 'b'.repeat(40)],
    ['v1.0', SHA, 'refs/tags/v1.0', SHA], [tag + '\n', SHA, `refs/tags/${tag}`, SHA], [tag, 'abc', `refs/tags/${tag}`, SHA]]) {
    assert.throws(() => candidateRef(...args));
  }
});
test('representative parsers fail closed and child environment has no private values', () => {
  assert.deepEqual(searchList('    "/a/login.keychain-db"\n  "/b/keychain-db"\n'), ['/a/login.keychain-db', '/b/keychain-db']);
  assert.throws(() => searchList('unquoted'));
  assert.deepEqual(otoolLibraries('/a:\n\t@rpath/Electron Framework.framework/Electron Framework (compatibility version 1.0.0, current version 1.0.0)\n'), ['@rpath/Electron Framework.framework/Electron Framework']);
  assert.throws(() => otoolLibraries('/a:\n garbage'));
  assert.deepEqual(rpaths('Load command 3\n          cmd LC_RPATH\n      cmdsize 48\n         path @executable_path/../Frameworks (offset 12)\n'), ['@executable_path/../Frameworks']);
  assert.deepEqual(cleanEnv({ PATH: '/bin', ...secrets, DEBUG: '*', NODE_OPTIONS: '--inspect' }), { PATH: '/bin' });
});
test('actual process runner bounds subprocess and keeps errors private', async () => {
  const result = await runner(process.execPath, ['-e', 'setTimeout(()=>{}, 10000)'], { timeout: 20 });
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, '');
});
for (const mode of ['timeout', 'abort', 'leader-exit', 'inherited-pipes', 'overflow']) test(`runner quiesces SIGTERM-resistant tree: ${mode}`, { skip: process.platform === 'win32' }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-tool-tree-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const heartbeat = path.join(dir, 'heartbeat');
  const grandchild = `const fs=require('node:fs'); process.on('SIGTERM',()=>{}); setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),10);`;
  const tool = `process.on('SIGTERM',()=>{}); require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:${mode === 'inherited-pipes' ? "'inherit'" : "'ignore'"}}); ${['leader-exit', 'inherited-pipes'].includes(mode) ? 'setTimeout(()=>process.exit(0),300)' : mode === 'overflow' ? "setTimeout(()=>process.stdout.write('x'.repeat(10000)),300); setInterval(()=>{},1000)" : 'setInterval(()=>{},1000)'};`;
  const controller = new AbortController();
  const start = Date.now();
  const pending = runner(process.execPath, ['-e', tool, 'dummy-secret-argument'], { timeout: mode === 'overflow' ? 10000 : 1500, signal: controller.signal, maxBuffer: 100 });
  if (mode === 'abort') {
    while (!fs.existsSync(heartbeat) && Date.now() - start < 1200) await new Promise(r => setTimeout(r, 10));
    controller.abort();
  }
  const result = await pending;
  assert.equal(result.quiescent, true);
  assert.ok(Date.now() - start < 4000);
  assert.ok(fs.existsSync(heartbeat), 'grandchild actually started');
  const before = fs.readFileSync(heartbeat, 'utf8');
  await new Promise(r => setTimeout(r, 100));
  assert.equal(fs.readFileSync(heartbeat, 'utf8'), before, 'no descendant can access scratch after return');
  assert.equal(result.code === 0, ['leader-exit', 'inherited-pipes'].includes(mode));
  assert.ok(!JSON.stringify(result).includes('dummy-secret-argument'));
});
test('runner drains successful output and sanitizes spawn errors', async () => {
  const output = 'x'.repeat(200000);
  const result = await runner(process.execPath, ['-e', `process.stdout.write('x'.repeat(${output.length}))`]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, output);
  assert.equal(result.quiescent, true);
  const failed = await runner('/nonexistent/peek-test-tool', ['dummy-secret-argument']);
  assert.notEqual(failed.code, 0);
  assert.equal(failed.quiescent, true);
  assert.ok(!JSON.stringify(failed).includes('dummy-secret-argument'));
});
test('runner bounds output without exposing secret argv in errors', async () => {
  const result = await runner(process.execPath, ['-e', "process.stdout.write('x'.repeat(10000))", 'dummy-secret-argument'], { maxBuffer: 100 });
  assert.notEqual(result.code, 0);
  assert.ok(result.stdout.length <= 100);
  assert.ok(!JSON.stringify(result).includes('dummy-secret-argument'));
});
test('candidate workflow has pinned actions, protected environment, nonpersisted checkout and success-only exact upload', () => {
  const yaml = require('js-yaml');
  const workflow = yaml.load(fs.readFileSync(path.join(__dirname, '../.github/workflows/macos-signing-candidate.yml'), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  const job = workflow.jobs.candidate;
  assert.equal(job.environment, 'macos-release-signing');
  assert.match(job.if, /github.ref_protected == true/);
  for (const step of job.steps.filter(s => s.uses)) assert.match(step.uses, /@[a-f0-9]{40}$/);
  const checkout = job.steps.find(s => s.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with['persist-credentials'], false);
  const signing = job.steps.find(s => s.id === 'verified');
  assert.equal(signing.run, 'node scripts/macos-signing-adapter.cjs');
  const upload = job.steps.at(-1);
  assert.match(upload.if, /success\(\).*steps.verified.outcome == 'success'/);
  assert.equal(upload.with.path.trim().split('\n').length, 3);
  assert.equal(job.steps.filter(s => s.env?.APPLE_API_KEY_P8).length, 1);
  const unsigned = yaml.load(fs.readFileSync(path.join(__dirname, '../.github/workflows/macos.yml'), 'utf8'));
  assert.deepEqual(unsigned.on.push.tags, ['v*', '!v*-signing-candidate.*']);
  assert.match(unsigned.jobs.build.if, /signing-candidate/);
  assert.doesNotMatch(JSON.stringify(workflow), /R2_|TANGLED_|publish-release|releases\/|contents:write/);
});

test('afterPack preserves unsigned stamping and enforces numeric signed build identity', t => {
  const vm = require('node:vm');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-fixture-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const target = path.join(base, 'Peek.app/Contents/Info.plist');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const context = { electronPlatformName: 'darwin', appOutDir: base,
    packager: { appInfo: { productFilename: 'Peek' } } };
  const info = { commit: SHA, shortCommit: SHA.slice(0, 7), dirty: false };
  const env = {};
  const sandbox = { require, __dirname, module: { exports: {} }, process: { env } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'electron-after-pack.cjs'), 'utf8') +
    '\nmodule.exports.stamp = stampInfoPlist;', sandbox);
  const stamp = sandbox.module.exports.stamp;
  fs.writeFileSync(target, plist.build({ CFBundleIdentifier: input.bundleId }));
  stamp(context, info);
  assert.equal(plist.parse(fs.readFileSync(target, 'utf8')).CFBundleVersion, info.shortCommit);
  Object.assign(env, { PEEK_SIGNING_CANDIDATE: '1', PEEK_BUILD_VERSION: '1.2.3', PEEK_BUILD_COMMIT: SHA });
  stamp(context, info);
  const parsed = plist.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(parsed.CFBundleVersion, '1.2.3');
  assert.equal(parsed.PeekBuildCommit, SHA);
  for (const version of ['', 'abc1234', '1.2', '01.2.3', '1.100.3', '1.2.3\n']) {
    env.PEEK_BUILD_VERSION = version;
    assert.throws(() => stamp(context, info));
  }
  env.PEEK_BUILD_VERSION = '1.2.3';
  assert.throws(() => stamp(context, { ...info, dirty: true }));
  assert.throws(() => stamp(context, { ...info, commit: 'b'.repeat(40) }));
});

for (const operation of ['builder', 'keychain-import', 'notary-store']) {
  test(`${operation} failure prints only twenty sanitized trailing lines per stream`, async t => {
    const logs = [];
    t.mock.method(console, 'error', line => logs.push(line));
    const f = fixture(t, {
      fail: (file, args) => operation === 'builder' ? file === process.execPath :
        operation === 'keychain-import' ? file === 'security' && args[0] === 'import' :
          file === 'xcrun' && args[1] === 'store-credentials',
      stderr: () => [
        'Omitted first line', 'Omitted second line',
        ...Array.from({ length: 12 }, () => 'Dependency collection failed'),
        'Cannot copy "/Users/runner/build folder/private.js": missing',
        "Cannot open '/private/keychain folder/candidate.keychain-db': denied",
        secrets.MACOS_CERTIFICATE_PASSWORD,
        secrets.APPLE_API_KEY_P8.split('\n')[1],
        f.calls.find(c => c.file === 'security' && c.args[0] === 'create-keychain').args[2],
        'x'.repeat(241), 'bad\u001b[31m', 'Final builder failure',
      ].join('\n') + '\n',
      stdout: ['Omitted stdout', ...Array.from({ length: 20 }, () => 'Build stopped')].join('\r\n') + '\r\n',
    });
    await assert.rejects(f.execute(), { code: 'tool-exit' });
    const output = logs.filter(line => line.startsWith('macOS candidate tool output:'));
    assert.equal(output.length, 40);
    const prefix = `macOS candidate tool output: stage=${operation === 'builder' ? 'pack' : 'prepare'}; operation=${operation}; `;
    assert.equal(output[0], prefix + 'stderr[1]="Dependency collection failed"');
    assert.equal(output[12], prefix + 'stderr[13]="Cannot copy <path>: missing"');
    assert.equal(output[13], prefix + 'stderr[14]="Cannot open <path>: denied"');
    for (let i = 14; i < 19; i++) assert.equal(output[i], prefix + `stderr[${i + 1}]=<redacted>`);
    assert.equal(output[19], prefix + 'stderr[20]="Final builder failure"');
    assert.equal(output[39], prefix + 'stdout[20]="Build stopped"');
    const log = logs.join('\n');
    assert.doesNotMatch(log, /Omitted|\/Users\/|\/private\/|\u001b/);
    for (const value of Object.values(secrets)) assert.ok(!log.includes(value));
    assert.equal(fs.existsSync(f.output), false);
    assert.deepEqual(fs.readdirSync(f.temp), []);
  });
}

test('packaging excludes build-only universal and x86_64 prebuilds at source', () => {
  const root = path.resolve(__dirname, '..');
  const config = require('js-yaml').load(fs.readFileSync(path.join(root, 'apps/desktop/electron-builder.yml'), 'utf8'));
  const { FileMatcher } = require('app-builder-lib/out/fileMatcher.js');
  const filter = new FileMatcher(root, root, value => value, config.files).createFilter();
  const stat = { isDirectory: () => false };
  for (const relative of [
    'node_modules/@electron-internal/extract-zip/index.darwin-universal.node',
    'node_modules/node-notifier/vendor/mac.noindex/terminal-notifier.app/Contents/MacOS/terminal-notifier',
    'node_modules/nested/node_modules/@electron-internal/extract-zip/index.darwin-universal.node',
    'node_modules/nested/node_modules/node-notifier/vendor/mac.noindex/terminal-notifier.app/Contents/MacOS/terminal-notifier',
  ]) assert.equal(filter(path.join(root, relative), stat), false, relative);
  // Keep traversal and metadata intact; a file-only glob test misses pruned
  // package directories and therefore cannot exercise dependency collection.
  for (const name of ['@electron-internal/extract-zip', 'node-notifier']) {
    const directory = path.join(root, 'node_modules', name);
    assert.equal(filter(directory, { isDirectory: () => true }), true, name);
    assert.equal(filter(path.join(directory, 'package.json'), stat), true, name);
    assert.equal(filter(path.join(directory, 'index.js'), stat), true, name);
  }
  assert.equal(filter(path.join(root, 'apps/desktop/dist/main/entry.js'), stat), true);
  assert.equal(config.extraResources.some(e => e.to === 'peek-desktop-helper'), true);
  assert.equal(config.extraResources.some(e => e.to === 'nonactivating-window.node'), true);
});

test('builder loads named custom signing export and per-file JIT is not inherited by Swift/addon/frameworks', async () => {
  const vm = require('node:vm');
  let options;
  const sandbox = { require(name) {
    if (name === '@electron/osx-sign') return { signAsync: async supplied => { options = supplied; } };
    return require(name);
  }, __dirname, module: { exports: {} }, process: { env: { PEEK_SIGNING_CANDIDATE: '1' } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'macos-signing-adapter.cjs'), 'utf8'), sandbox);
  await sandbox.module.exports.sign({ app: '/tmp/Peek.app', identity: 'B'.repeat(40), keychain: '/tmp/fixture.keychain-db' });
  assert.equal(options.preAutoEntitlements, false);
  assert.equal(options.preEmbedProvisioningProfile, false);
  for (const [target, jit] of [
    ['/tmp/Peek.app', true], ['/tmp/Peek.app/Contents/MacOS/Peek', true],
    ['/tmp/Peek.app/Contents/Frameworks/Peek Helper.app', true],
    ['/tmp/Peek.app/Contents/Frameworks/Peek Helper.app/Contents/MacOS/Peek Helper', true],
    ['/tmp/Peek.app/Contents/Resources/peek-desktop-helper', false],
    ['/tmp/Peek.app/Contents/Resources/nonactivating-window.node', false],
    ['/tmp/Peek.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework', false],
  ]) {
    const policy = options.optionsForFile(target);
    assert.equal(policy.hardenedRuntime, true);
    assert.deepEqual(plist.parse(fs.readFileSync(policy.entitlements, 'utf8')), jit ? { 'com.apple.security.cs.allow-jit': true } : {});
  }
  const { resolveFunction } = require('app-builder-lib/out/util/resolve.js');
  const loaded = await resolveFunction('module', path.join(__dirname, 'macos-signing-adapter.cjs'), 'sign', path.resolve(__dirname, '..'));
  assert.equal(loaded, require('./macos-signing-adapter.cjs').sign);
});
