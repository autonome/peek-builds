'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const plist = require('plist');
const { createAdapter, searchList, otoolLibraries, rpaths, roleFor, candidateRef, cleanEnv, runner } = require('./macos-signing-adapter.cjs');
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
    if (mutation.escape) fs.symlinkSync(root, path.join(target, 'Contents/escape'));
  }
  const ok = (stdout = '', stderr = '') => ({ code: 0, stdout, stderr, quiescent: true });
  const fakeRun = async (file, args, options) => {
    calls.push({ file, args, options });
    const target = args.at(-1);
    if (mutation.active?.(file, args)) return { ...ok(), quiescent: false };
    if (mutation.fail?.(file, args, calls)) {
      // Simulate every private channel a child/error could populate.
      args.push('SEEDED-PRIVATE-ARGV');
      if (mutation.failureMode === 'throw') throw new Error('SEEDED-PRIVATE-ERROR ' + target);
      return { code: mutation.failureMode === 'status' ? 'SEEDED-PRIVATE-STATUS' : 73,
        stdout: 'SECRET-TOOL-OUTPUT', stderr: secrets.MACOS_CERTIFICATE_PASSWORD,
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
      if (args[0] === '-L') return ok(`${target}:\n\t${mutation.dependency || '/usr/lib/libSystem.B.dylib'} (compatibility version 1.0.0, current version 1336.0.0)\n`);
      if (args[0] === '-D') return ok(`${target}:\n`);
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
    env: { PATH: '/usr/bin', ...secrets }, platform: 'darwin', arch: 'arm64' });
  return { adapter, calls, root, temp, output,
    async execute() { try { return await runCandidate(input, secrets, adapter.operations); }
      finally { await adapter.destroy(); } } };
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
        assert.match(line, /^macOS candidate tool failed: stage=(?:preflight|prepare|pack|signApp|submitApp|stapleApp|verifyApp|archive|signDmg|submitDmg|stapleDmg|verifyDmg|verifyZip|verifyDmgApp|cleanup); operation=[a-z-]+; reason=tool-(?:exit|execution|tree-active)(?:; status=73)?$/);
        assert.doesNotMatch(line, /unknown|SEEDED|SECRET-TOOL-OUTPUT|dummy-password|PRIVATE KEY/);
        for (const value of [f.root, f.temp, ...Object.values(secrets)]) assert.ok(!line.includes(value));
        assert.equal(line.includes('status='), mode === 'exit');
      }
      // Avoid retaining hundreds of fixture trees until this test completes.
      fs.rmSync(path.dirname(f.root), { recursive: true, force: true });
    }
  }
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
