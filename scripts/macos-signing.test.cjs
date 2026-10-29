'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  SigningError, validateConfig, validateNative, validateSignature,
  validateEntitlements, validateDependencies, validateApp, validateNotary,
  validateDmg, runCandidate,
} = require('./macos-signing.cjs');

const ID = '01234567-89ab-cdef-0123-456789abcdef';
const SECRET = 'dummy-secret-never-real';
function input() {
  return { mode: 'candidate', teamId: 'ABCDEFGHIJ',
    identity: 'Developer ID Application: Example Publisher (ABCDEFGHIJ)',
    buildVersion: '2026.10.27', commit: 'a'.repeat(40), bundleId: 'com.autonome.peek' };
}
function env(mode = 'api') {
  return { MACOS_CERTIFICATE_P12_BASE64: SECRET, MACOS_CERTIFICATE_PASSWORD: SECRET,
    MACOS_SIGNING_IDENTITY: input().identity, APPLE_TEAM_ID: input().teamId,
    ...(mode === 'api' ? {
      APPLE_API_KEY_ID: '0123456789', APPLE_API_ISSUER: ID,
      APPLE_API_KEY_P8: `-----BEGIN PRIVATE KEY-----\n${SECRET}\n-----END PRIVATE KEY-----`,
    } : { APPLE_ID: 'example@example.invalid', APPLE_APP_SPECIFIC_PASSWORD: SECRET }),
  };
}
function policy() { return validateConfig(input(), env()); }
function signature() {
  return [
    'Executable=/private/fixture/Peek.app/Contents/MacOS/Peek',
    'CodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=1+1 location=embedded',
    `Authority=${input().identity}`, 'Authority=Developer ID Certification Authority',
    'Authority=Apple Root CA', `TeamIdentifier=${input().teamId}`,
    'Timestamp=Oct 27, 2026 12:00:00 PM',
  ].join('\n');
}
function native() {
  return ['peek-desktop-helper', 'nonactivating-window.node'].map(name => ({
    name, regularFile: true, machO: true, architectures: ['arm64'], executable: true,
  }));
}
function app() {
  return {
    deepStrict: true, staple: true, gatekeeper: 'Notarized Developer ID',
    bundleId: input().bundleId, buildVersion: input().buildVersion, commit: input().commit,
    inventoryComplete: true,
    inventory: [
      ['Contents/MacOS/Peek', 'electron'],
      ['Contents/Frameworks/Peek Helper.app/Contents/MacOS/Peek Helper', 'electron'],
      ['Contents/Resources/peek-desktop-helper', 'standalone'],
      ['Contents/Resources/nonactivating-window.node', 'library'],
    ].map(([p, role]) => ({
      path: p, role, strict: true, machO: true, architectures: ['arm64'],
      signature: signature(), dependencies: ['/usr/lib/libSystem.B.dylib'],
      entitlements: role === 'electron' ? { 'com.apple.security.cs.allow-jit': true } : {},
    })),
  };
}
function notary() {
  return { result: JSON.stringify({ id: ID, status: 'Accepted' }),
    log: JSON.stringify({ jobId: ID, status: 'Accepted', statusCode: 0, issues: null }) };
}
function dmg() {
  return { strict: true, container: true, staple: true,
    gatekeeper: 'Notarized Developer ID', signature: signature() };
}
function adapter() {
  const calls = [];
  const data = {
    preflight: native(), verifyApp: app(), verifyZip: app(), verifyDmgApp: app(),
    submitApp: notary(), submitDmg: notary(), verifyDmg: dmg(),
    hashFinal: ['zip', 'dmg'].map(ext => ({ name: `Peek-2026-arm64.${ext}`, sha256: 'b'.repeat(64) })),
  };
  const ops = {};
  for (const name of ['preflight', 'prepare', 'pack', 'signApp', 'submitApp', 'stapleApp',
    'verifyApp', 'archive', 'signDmg', 'submitDmg', 'stapleDmg', 'verifyDmg',
    'verifyZip', 'verifyDmgApp', 'cleanup', 'hashFinal']) {
    ops[name] = async () => { calls.push(name); return data[name]; };
  }
  return { calls, data, ops };
}
function blocked(fn, code) {
  assert.throws(fn, e => e instanceof SigningError && e.code === code && !e.message.includes(SECRET));
}

test('inventory diagnostics identify universal code and redact private evidence', () => {
  const lines = [];
  const original = console.error;
  console.error = line => lines.push(line);
  try {
    for (const [patch, code] of [
      [{ architectures: ['x86_64', 'arm64'] }, 'inventory-code'],
      [{ strict: false }, 'inventory-code'],
      [{ signature: SECRET }, 'signature-authority'],
      [{ entitlements: { [SECRET]: SECRET } }, 'electron-entitlements'],
      [{ dependencies: [SECRET] }, 'external-dependency'],
      [{ role: SECRET }, 'inventory-role'],
    ]) {
      const evidence = app();
      Object.assign(evidence.inventory[0], patch);
      lines.length = 0;
      blocked(() => validateApp(evidence, policy()), code);
      assert.equal(lines.length, 1);
      assert.ok(lines[0].includes('path="Contents/MacOS/Peek"'));
      assert.ok(lines[0].includes(`code=${code}`));
      assert.ok(lines[0].includes('role='));
      if (patch.architectures) assert.ok(lines[0].includes('architectures=["x86_64","arm64"]'));
      assert.ok(!lines[0].includes(SECRET));
    }
    for (const [name, relative] of [
      ['main', 'Contents/MacOS/Peek'],
      ['helper', 'Contents/Resources/peek-desktop-helper'],
      ['addon', 'Contents/Resources/nonactivating-window.node'],
    ]) {
      const evidence = app();
      evidence.inventory = evidence.inventory.filter(e => e.path !== relative);
      lines.length = 0;
      blocked(() => validateApp(evidence, policy()), 'packaged-native-missing');
      assert.ok(lines.join('\n').includes(`native=${name}; count=0`));
      assert.ok(lines.join('\n').includes(relative));
    }
  } finally { console.error = original; }
});

test('unsigned mode never reads credentials or invokes an adapter', async () => {
  const poison = new Proxy({}, { get() { throw new Error('unexpected credential read'); } });
  assert.deepEqual(validateConfig({ mode: 'unsigned' }, poison), { mode: 'unsigned' });
  assert.deepEqual(await runCandidate({ mode: 'unsigned' }, poison, poison), { mode: 'unsigned' });
  blocked(() => validateConfig({ mode: 'auto' }), 'mode');
});

test('candidate requires explicit identity, team, bundle and canonical numeric version', () => {
  assert.equal(policy().forceCodeSigning, true);
  assert.equal(policy().hardenedRuntime, true);
  assert.equal(policy().signDmg, true);
  for (const identity of [null, '-', 'Developer ID Installer: Example (ABCDEFGHIJ)',
    'Developer ID Application: Example (0123456789)', `${input().identity}\n`]) {
    blocked(() => validateConfig({ ...input(), identity }, env()), 'identity');
  }
  blocked(() => validateConfig({ ...input(), teamId: 'bad' }, env()), 'team');
  blocked(() => validateConfig({ ...input(), bundleId: 'other.id' }, env()), 'bundle-id');
  blocked(() => validateConfig({ ...input(), commit: 'abc1234' }, env()), 'commit');
  for (const buildVersion of ['', 'a123bc', '1', '0.0.0', '01.0.0', '10000.0.0', '1.100.0', '1.0.100', '1.2.3beta', '1.2.3\n']) {
    blocked(() => validateConfig({ ...input(), buildVersion }, env()), 'build-version');
  }
});

test('one complete credential mode only, with explicit metadata and no ambient fallback/debug', () => {
  assert.equal(validateConfig(input(), env('password')).authMode, 'password');
  assert.equal(policy().authMode, 'api');
  assert.ok(!JSON.stringify(policy()).includes(SECRET));
  for (const key of ['MACOS_CERTIFICATE_P12_BASE64', 'MACOS_CERTIFICATE_PASSWORD']) {
    blocked(() => validateConfig(input(), { ...env(), [key]: '' }), 'certificate');
  }
  for (const key of ['APPLE_API_KEY_P8', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) {
    const e = env(); delete e[key];
    blocked(() => validateConfig(input(), e), 'auth-incomplete');
  }
  const e = env();
  delete e.APPLE_API_KEY_P8; delete e.APPLE_API_KEY_ID; delete e.APPLE_API_ISSUER;
  blocked(() => validateConfig(input(), e), 'auth-mode');
  for (const key of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD']) {
    blocked(() => validateConfig(input(), { ...env(), [key]: '' }), 'auth-mode');
  }
  for (const key of ['APPLE_API_KEY', 'APPLE_KEYCHAIN', 'APPLE_KEYCHAIN_PROFILE', 'CSC_LINK',
    'CSC_KEY_PASSWORD', 'CSC_NAME', 'CSC_KEYCHAIN', 'CSC_IDENTITY_AUTO_DISCOVERY', 'DEBUG', 'GH_DEBUG', 'NODE_OPTIONS']) {
    blocked(() => validateConfig(input(), { ...env(), [key]: SECRET }), 'ambient-auth-or-debug');
  }
  blocked(() => validateConfig(input(), { ...env(), APPLE_API_KEY_ID: SECRET }), 'api-key-id');
  blocked(() => validateConfig(input(), { ...env(), APPLE_API_ISSUER: SECRET }), 'api-issuer');
  blocked(() => validateConfig(input(), { ...env(), APPLE_API_KEY_P8: SECRET }), 'api-key-shape');
  blocked(() => validateConfig(input(), { ...env(), APPLE_TEAM_ID: '0123456789' }), 'auth-team');
  blocked(() => validateConfig(input(), { ...env(), MACOS_SIGNING_IDENTITY: '-' }), 'auth-identity');
});

test('both native resources must exist once as regular arm64 Mach-O files', () => {
  validateNative(native());
  blocked(() => validateNative([]), 'native-missing-or-duplicate');
  blocked(() => validateNative([...native(), native()[0]]), 'native-missing-or-duplicate');
  for (const patch of [{ regularFile: false }, { machO: false }, { architectures: ['x86_64'] },
    { architectures: ['arm64', 'x86_64'] }]) {
    blocked(() => validateNative(native().map(e => ({ ...e, ...patch }))), 'native-architecture');
  }
  blocked(() => validateNative(native().map(e => ({ ...e, executable: false }))), 'native-executable');
});

test('signature authority/team/runtime/timestamp are assertions, not display-only output', () => {
  validateSignature(signature(), policy());
  for (const [from, to, code] of [
    [input().identity, '-', 'signature-authority'],
    ['Authority=Apple Root CA', '', 'signature-chain'],
    ['TeamIdentifier=ABCDEFGHIJ', 'TeamIdentifier=0123456789', 'signature-team'],
    ['flags=0x10000(runtime)', 'flags=0x0(none)', 'signature-runtime'],
    ['Timestamp=Oct 27, 2026 12:00:00 PM', '', 'signature-timestamp'],
    ['Timestamp=Oct 27, 2026 12:00:00 PM', 'Timestamp=none', 'signature-timestamp'],
    ['Timestamp=Oct 27, 2026 12:00:00 PM', 'Timestamp=not-a-timestamp', 'signature-timestamp'],
  ]) blocked(() => validateSignature(signature().replace(from, to), policy()), code);
  blocked(() => validateSignature(`${signature()}\nSignature=adhoc`, policy()), 'signature-adhoc');
  blocked(() => validateSignature(`${signature()}\nTeamIdentifier=ABCDEFGHIJ`, policy()), 'signature-team');
});

test('entitlement policy requires JIT only on Electron, empty on helper/library', () => {
  validateEntitlements({ 'com.apple.security.cs.allow-jit': true }, 'electron');
  validateEntitlements({}, 'standalone');
  for (const key of ['com.apple.security.get-task-allow', 'com.apple.security.app-sandbox',
    'com.apple.security.cs.allow-unsigned-executable-memory', 'com.apple.security.cs.disable-library-validation']) {
    blocked(() => validateEntitlements({ 'com.apple.security.cs.allow-jit': true, [key]: true }, 'electron'), 'electron-entitlements');
  }
  blocked(() => validateEntitlements({}, 'electron'), 'electron-entitlements');
  blocked(() => validateEntitlements({ 'com.apple.security.cs.allow-jit': false }, 'electron'), 'electron-entitlements');
  for (const role of ['standalone', 'library']) {
    blocked(() => validateEntitlements({ 'com.apple.security.cs.allow-jit': true }, role), 'minimal-entitlements');
  }
});

test('dependencies require system paths or actual in-bundle dynamic-path resolution', () => {
  validateDependencies(['/System/Library/Frameworks/AppKit.framework/AppKit',
    { installName: '@rpath/Electron Framework.framework/Electron Framework',
      resolvedPath: 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework' },
    { installName: '@executable_path/../Frameworks/libfoo.dylib', resolvedPath: 'Contents/Frameworks/libfoo.dylib' }]);
  for (const p of ['/opt/homebrew/lib/foo.dylib', '/Users/build/lib/foo.dylib', 'libfoo.dylib', '@rpath/../foo',
    { installName: '@loader_path/../libfoo.dylib', resolvedPath: '../libfoo.dylib' },
    { installName: '@rpath/libfoo.dylib', resolvedPath: '/usr/local/lib/libfoo.dylib' }]) {
    blocked(() => validateDependencies([p]), 'external-dependency');
  }
});

test('app policy validates entire supplied inventory and build identity', () => {
  validateApp(app(), policy());
  for (const patch of [{ deepStrict: false }, { staple: false }, { gatekeeper: 'Developer ID' }]) {
    blocked(() => validateApp({ ...app(), ...patch }, policy()), 'app-verification');
  }
  for (const patch of [{ commit: 'b'.repeat(40) }, { buildVersion: '1.0.0' }, { bundleId: 'other' }]) {
    blocked(() => validateApp({ ...app(), ...patch }, policy()), 'app-build-identity');
  }
  blocked(() => validateApp({ ...app(), inventoryComplete: false }, policy()), 'app-inventory');
  for (const p of ['../evil', '/tmp/evil', 'Contents/../evil', 'Contents\\evil']) {
    const a = app(); a.inventory[1].path = p;
    blocked(() => validateApp(a, policy()), 'inventory-path');
  }
  const duplicate = app(); duplicate.inventory.push(duplicate.inventory[0]);
  blocked(() => validateApp(duplicate, policy()), 'inventory-path');
  const missing = app(); missing.inventory.pop();
  blocked(() => validateApp(missing, policy()), 'packaged-native-missing');
  const extra = app(); extra.inventory.push({ ...extra.inventory[3], path: 'Contents/Resources/surprise.node', strict: false });
  blocked(() => validateApp(extra, policy()), 'inventory-code');
  const broad = app(); broad.inventory[2].entitlements = { 'com.apple.security.cs.allow-jit': true };
  blocked(() => validateApp(broad, policy()), 'minimal-entitlements');
});

test('notary Accepted plus matching clean log required; diagnostic ID survives rejection', () => {
  assert.equal(validateNotary(notary().result, notary().log), ID);
  for (const result of ['', '{', 'null', '[]', undefined]) {
    blocked(() => validateNotary(result, notary().log), 'notary-json');
  }
  blocked(() => validateNotary({ status: 'Accepted' }, notary().log), 'notary-id');
  for (const status of ['Invalid', 'In Progress', undefined, 'accepted', 'Timed Out']) {
    assert.throws(() => validateNotary({ id: ID, status }, notary().log), e => e.code === 'notary-not-accepted' && e.submissionId === ID);
  }
  assert.throws(() => validateNotary(notary().result, '{'), e => e.code === 'notary-log-json' && e.submissionId === ID);
  for (const patch of [{ jobId: 'other' }, { status: 'Invalid' }, { statusCode: 4000 },
    { issues: [{ severity: 'warning', message: SECRET }] }, { issues: undefined }]) {
    blocked(() => validateNotary(notary().result, { ...JSON.parse(notary().log), ...patch }), 'notary-log-rejected');
  }
});

test('DMG checks include signed identity, container, staple and Gatekeeper', () => {
  validateDmg(dmg(), policy());
  for (const patch of [{ strict: false }, { container: false }, { staple: false }, { gatekeeper: 'rejected' }]) {
    blocked(() => validateDmg({ ...dmg(), ...patch }, policy()), 'dmg-verification');
  }
  blocked(() => validateDmg({ ...dmg(), signature: '' }, policy()), 'signature-authority');
});

test('orchestration orders signing, both notarizations, container verification, cleanup then final hashing', async () => {
  const { calls, ops } = adapter();
  const result = await runCandidate(input(), env(), ops);
  assert.deepEqual(calls, ['preflight', 'prepare', 'pack', 'signApp', 'submitApp', 'stapleApp',
    'verifyApp', 'archive', 'signDmg', 'submitDmg', 'stapleDmg', 'verifyDmg',
    'verifyZip', 'verifyDmgApp', 'cleanup', 'hashFinal']);
  assert.equal(result.mode, 'candidate');
  assert.deepEqual(result.submissionIds, [ID, ID]);
  assert.ok(Object.isFrozen(result.artifacts[0]));
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.ok(!('publish' in ops));
});

test('every injected operation failure blocks a receipt; cleanup attempted even on partial prepare', async () => {
  for (const stage of Object.keys(adapter().ops)) {
    const { calls, ops } = adapter();
    ops[stage] = async () => { calls.push(stage); throw new Error(SECRET); };
    await assert.rejects(runCandidate(input(), env(), ops), e => {
      assert.ok(e instanceof SigningError);
      assert.ok(!e.message.includes(SECRET));
      assert.ok(!e.cause);
      return true;
    });
    assert.equal(calls.filter(c => c === 'cleanup').length, 1, stage);
    if (stage !== 'hashFinal') assert.ok(!calls.includes('hashFinal'), stage);
  }
});

test('invalid app, ZIP, DMG or copied DMG app evidence blocks final hashing/receipt', async () => {
  for (const stage of ['verifyApp', 'verifyZip', 'verifyDmgApp', 'verifyDmg']) {
    for (const field of ['staple', 'signature']) {
      const { calls, data, ops } = adapter();
      if (field === 'staple') data[stage].staple = false;
      else if (stage === 'verifyDmg') data[stage].signature = '';
      else data[stage].inventory[0].signature = '';
      await assert.rejects(runCandidate(input(), env(), ops), SigningError);
      assert.ok(!calls.includes('hashFinal'));
      assert.equal(calls.at(-1), 'cleanup');
    }
  }
});

test('notary rejection/timeout/malformed data at either submission blocks staple and receipt', async () => {
  for (const stage of ['submitApp', 'submitDmg']) {
    for (const result of [{ id: ID, status: 'Invalid' }, { id: ID, status: 'In Progress' }, '{']) {
      const { calls, data, ops } = adapter();
      data[stage].result = result;
      await assert.rejects(runCandidate(input(), env(), ops), SigningError);
      assert.ok(!calls.includes(stage === 'submitApp' ? 'stapleApp' : 'stapleDmg'));
      assert.ok(!calls.includes('hashFinal'));
      assert.equal(calls.at(-1), 'cleanup');
    }
  }
});

test('timeouts preserve only validated submission IDs, never tool output', async () => {
  const { ops } = adapter();
  ops.submitDmg = async () => {
    const error = new Error(`tool stderr: ${SECRET}`);
    error.submissionId = ID;
    throw error;
  };
  await assert.rejects(runCandidate(input(), env(), ops), e => {
    assert.equal(e.code, 'adapter-failed');
    assert.equal(e.submissionId, ID);
    assert.deepEqual(e.submissionIds, [ID]);
    assert.ok(!JSON.stringify(e).includes(SECRET));
    return true;
  });
  ops.submitDmg = async () => { throw Object.assign(new Error(SECRET), { submissionId: SECRET }); };
  await assert.rejects(runCandidate(input(), env(), ops), e => {
    assert.equal(e.submissionId, undefined);
    assert.ok(!JSON.stringify(e).includes(SECRET));
    return true;
  });
});

test('cleanup failure overrides success or earlier failure and still retains diagnostic IDs', async () => {
  for (const rejectDmg of [false, true]) {
    const { ops, data, calls } = adapter();
    if (rejectDmg) data.submitDmg.result = { id: ID, status: 'Invalid' };
    ops.cleanup = async () => { calls.push('cleanup'); throw new Error(SECRET); };
    await assert.rejects(runCandidate(input(), env(), ops), e => {
      assert.equal(e.code, 'cleanup-failed');
      assert.deepEqual(e.submissionIds, [ID]);
      assert.ok(!e.message.includes(SECRET));
      return true;
    });
    assert.ok(!calls.includes('hashFinal'));
  }
});

test('invalid auth/adapter fail before operations; bad native inventory never reaches credentials', async () => {
  const { calls, ops, data } = adapter();
  await assert.rejects(runCandidate(input(), {}, ops), SigningError);
  await assert.rejects(runCandidate(input(), env(), {}), SigningError);
  assert.deepEqual(calls, []);
  data.preflight = [];
  await assert.rejects(runCandidate(input(), env(), ops), SigningError);
  assert.deepEqual(calls, ['preflight', 'cleanup']);
});

test('artifact manifest admits exactly one final ZIP and DMG, with final SHA-256 only', async () => {
  for (const bad of [[], [adapter().data.hashFinal[0]],
    [{ name: '../Peek-arm64.zip', sha256: 'b'.repeat(64) }, adapter().data.hashFinal[1]],
    [{ name: 'Peek-arm64.zip', sha256: SECRET }, adapter().data.hashFinal[1]],
    [{ name: 'Peek-arm64.zip', sha256: `${'b'.repeat(64)}\n` }, adapter().data.hashFinal[1]],
    [adapter().data.hashFinal[0], adapter().data.hashFinal[0]],
    [adapter().data.hashFinal[0], { name: 'Peek-second.zip', sha256: 'b'.repeat(64) }]]) {
    const { ops, data } = adapter(); data.hashFinal = bad;
    await assert.rejects(runCandidate(input(), env(), ops), SigningError);
  }
});
