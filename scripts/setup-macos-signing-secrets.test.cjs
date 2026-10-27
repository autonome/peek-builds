const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const script = path.resolve(__dirname, 'setup-macos-signing-secrets.sh');
const team = 'ABCDEFGHIJ';
const identity = `Developer ID Application: Test Fixture (${team})`;
const issuer = '12345678-1234-1234-1234-123456789abc';
const p12Value = 'dummy-certificate-not-a-real-key';
const p8Value = '-----BEGIN PRIVATE KEY-----\nFAKE-PRIVATE-MATERIAL\n-----END PRIVATE KEY-----';
const password = 'test-only-p12-password';
const appPassword = 'abcd-efgh-ijkl-mnop';
function run(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-signing-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p12 = path.join(dir, 'certificate.p12');
  const p8 = path.join(dir, 'AuthKey.p8');
  fs.writeFileSync(p12, options.big ? 'x'.repeat(37000) : p12Value);
  fs.writeFileSync(p8, p8Value);
  fs.writeFileSync(path.join(dir, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = args[0] === 'secret' && args[1] === 'set' ? fs.readFileSync(0, 'utf8') : '';
const record = { args, input, debug: process.env.GH_DEBUG, leaked: ['password','certificate','private_key','app_password'].filter(k => process.env[k]) };
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(record) + '\\n');
if (args[0] === 'secret' && args[1] === 'list') console.log(process.env.FAKE_NAMES || '');
if (args[0] === 'secret' && args[1] === 'set' && args[2] === process.env.FAKE_FAIL) { console.error(input); process.exit(1); }
if (args[0] === 'api' && process.env.FAKE_NO_ENV) process.exit(1);
if (args[0] === process.env.FAKE_FAIL_COMMAND) process.exit(1);
`, { mode: 0o700 });
  const mode = options.mode || 'api';
  const metadata = [identity, team, ...(mode === 'api' ? ['123456789A', issuer] : ['test@example.invalid'])];
  const inputs = [...metadata, password, ...(mode === 'password' ? [appPassword] : []), `${options.repo || 'autonome/peek-builds'}/${options.env || 'macos-release-signing'} ${mode}`];
  const args = ['--p12', p12, '--mode', mode, ...(mode === 'api' ? ['--p8', p8] : []), ...(options.args || [])];
  const result = spawnSync('/bin/bash', [...(options.trace ? ['-xv'] : []), script, ...args], {
    input: options.input === undefined ? inputs.join('\n') + '\n' : options.input,
    encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TMPDIR: dir,
      FAKE_LOG: path.join(dir, 'log'), GH_DEBUG: 'api', password: 'inherited',
      ...(options.trace ? { SHELLOPTS: 'braceexpand:hashall:interactive-comments:verbose:xtrace' } : {}),
      ...(options.fake || {}) }
  });
  const records = fs.existsSync(path.join(dir, 'log')) ? fs.readFileSync(path.join(dir, 'log'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  const output = result.stdout + result.stderr;
  for (const secret of [password, appPassword, p12Value, Buffer.from(p12Value).toString('base64'), 'FAKE-PRIVATE-MATERIAL']) {
    assert.ok(!output.includes(secret), `secret in output: ${output}`);
    assert.ok(!JSON.stringify(records.map(r => r.args)).includes(secret), 'secret in argv');
  }
  for (const record of records) { assert.equal(record.debug, ''); assert.deepEqual(record.leaked, []); }
  assert.deepEqual(fs.readdirSync(dir).sort(), ['AuthKey.p8', 'certificate.p12', 'gh', ...(records.length ? ['log'] : [])].sort(), 'unexpected temporary file');
  return { ...result, output, records, uploads: records.filter(r => r.args[1] === 'set') };
}
test('help and dry-run never call gh or request passwords', t => {
  assert.ok(fs.statSync(script).mode & 0o111, 'setup script must be executable');
  const help = run(t, { args: ['--help'], input: '' });
  assert.equal(help.status, 0); assert.match(help.output, /Usage:/); assert.equal(help.records.length, 0);
  const dry = run(t, { args: ['--dry-run'], input: [identity, team, '123456789A', issuer].join('\n') + '\n' });
  assert.equal(dry.status, 0); assert.match(dry.output, /Remote prerequisites NOT checked/); assert.equal(dry.records.length, 0);
});
test('API mode stdin uploads, tracing/debug disabled, no temp credentials', t => {
  const r = run(t, { trace: true }); assert.equal(r.status, 0, r.output); assert.equal(r.uploads.length, 7);
  const values = Object.fromEntries(r.uploads.map(r => [r.args[2], r.input]));
  assert.equal(values.MACOS_CERTIFICATE_P12_BASE64, Buffer.from(p12Value).toString('base64'));
  assert.equal(values.APPLE_API_KEY_P8, p8Value); assert.equal(values.MACOS_CERTIFICATE_PASSWORD, password);
  for (const upload of r.uploads) assert.deepEqual(upload.args.slice(3), ['--repo', 'autonome/peek-builds', '--env', 'macos-release-signing']);
});
test('password mode and destination overrides', t => {
  const r = run(t, { mode: 'password', repo: 'owner/builds', env: 'candidate', args: ['--repo', 'owner/builds', '--env', 'candidate'] });
  assert.equal(r.status, 0, r.output); assert.equal(r.uploads.length, 6);
  assert.equal(r.uploads.at(-1).input, appPassword);
  assert.ok(!r.uploads.some(r => r.args[2].startsWith('APPLE_API_')));
});
test('preflight rejects invalid, incomplete and mutually exclusive input before uploads', t => {
  for (const options of [
    { input: '' }, { args: ['--repo', '../bad'] }, { args: ['--env', '../bad'] },
    { args: ['--mode', 'other'] }, { args: ['--p12', '/nonexistent'] },
    { args: ['--mode', 'password'] }, { args: ['--p8', '/nonexistent'] },
    { input: `${identity}\nWRONG\n` }, { big: true },
    { input: [identity, team, 'bad'].join('\n') + '\n' },
    { input: [identity, team, '123456789A', 'bad'].join('\n') + '\n' },
    { input: [identity, team, '123456789A', issuer, password, 'no'].join('\n') + '\n' },
  ]) {
    const r = run(t, options); assert.notEqual(r.status, 0, r.output); assert.equal(r.uploads.length, 0);
  }
});
test('existing opposite-mode names refused in either mode; environment required', t => {
  for (const options of [
    { fake: { FAKE_NAMES: 'OTHER\nAPPLE_ID' } },
    { mode: 'password', fake: { FAKE_NAMES: 'APPLE_API_KEY_P8' } },
    { fake: { FAKE_NO_ENV: '1' } },
    { fake: { FAKE_FAIL_COMMAND: 'auth' } },
    { fake: { FAKE_FAIL_COMMAND: 'secret' } },
  ]) { const r = run(t, options); assert.notEqual(r.status, 0); assert.equal(r.uploads.length, 0); }
});
test('partial failure stops immediately, hides gh error payload and explains retry', t => {
  const r = run(t, { fake: { FAKE_FAIL: 'MACOS_CERTIFICATE_PASSWORD' } });
  assert.notEqual(r.status, 0); assert.equal(r.uploads.length, 2);
  assert.match(r.output, /after 1 successful uploads/); assert.match(r.output, /SAME mode\/destination/);
});
