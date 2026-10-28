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
const token = 'github_pat_TESTFIXTURE0000';
function run(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-signing-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // TMPDIR can be inside this type:module repository. The extensionless gh
  // fixture is CommonJS regardless of the enclosing checkout's package type.
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}\n');
  const p12 = path.join(dir, 'certificate.p12');
  const p8 = path.join(dir, 'AuthKey.p8');
  fs.writeFileSync(p12, options.big ? 'x'.repeat(37000) : p12Value);
  fs.writeFileSync(p8, p8Value);
  fs.writeFileSync(path.join(dir, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--fixture-self-test') process.exit(0);
const input = args[0] === 'secret' && args[1] === 'set' ? fs.readFileSync(0, 'utf8') : '';
const record = { args, input, debug: process.env.GH_DEBUG, tokenSeen: process.env.GH_TOKEN === process.env.FAKE_TOKEN, cfgDir: process.env.GH_CONFIG_DIR, cfgEntries: process.env.GH_CONFIG_DIR && fs.existsSync(process.env.GH_CONFIG_DIR) ? fs.readdirSync(process.env.GH_CONFIG_DIR) : null, leaked: ['password','certificate','private_key','app_password'].filter(k => process.env[k]) };
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(record) + '\\n');
if (args[0] === 'secret' && args[1] === 'list') console.log(process.env.FAKE_NAMES || '');
if (args[0] === 'secret' && args[1] === 'set' && args[2] === process.env.FAKE_FAIL) { console.error(input); process.exit(1); }
if (args[0] === 'api' && process.env.FAKE_BAD_TOKEN && args[1].split('/').length === 3 && args[1].startsWith('repos/')) { console.error('GH-BODY-LEAK Resource not accessible'); process.exit(1); }
if (args[0] === 'api' && process.env.FAKE_NO_ENV && args.some(a => a.includes('/environments/'))) process.exit(1);
if (args[0] === process.env.FAKE_FAIL_COMMAND) process.exit(1);
if (args[0] === 'api') {
  // Minimal stateful model of the environment API; the state file lives next to this fixture.
  const stateFile = require('node:path').join(__dirname, 'state.json');
  const st = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { reviewers: [], custom: false, policies: [] };
  const flag = (name, prefix) => args.flatMap((a, i) => a === name && args[i + 1].startsWith(prefix) ? [args[i + 1].slice(prefix.length)] : []);
  const method = args.includes('-X') ? args[args.indexOf('-X') + 1] : 'GET';
  const route = args[args.indexOf('-X') >= 0 ? args.indexOf('-X') + 2 : 1];
  const jq = args.includes('--jq') ? args[args.indexOf('--jq') + 1] : '';
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(st));
  if (process.env.FAKE_FAIL_PUT && method === 'PUT') process.exit(1);
  if (route.startsWith('users/')) console.log(process.env.FAKE_REVIEWER_ID || '4242');
  else if (route.endsWith('/deployment-branch-policies')) {
    if (method === 'POST') { st.policies.push(flag('-f', 'type=')[0] + ' ' + flag('-f', 'name=')[0]); save(); }
    else for (const p of st.policies) console.log(p);
  } else if (method === 'PUT') {
    if (!process.env.FAKE_NO_REVIEWERS) st.reviewers = flag('-F', 'reviewers[][id]=');
    st.custom = !process.env.FAKE_NO_CUSTOM; save();
  } else if (jq.includes('required_reviewers')) console.log(st.reviewers.join(','));
  else if (jq.includes('custom_branch_policies')) console.log(String(st.custom));
}
`, { mode: 0o700 });
  // A broken executable fixture must not masquerade as a production auth error.
  const fixtureCheck = spawnSync(path.join(dir, 'gh'), ['--fixture-self-test'], { encoding: 'utf8' });
  assert.equal(fixtureCheck.status, 0, fixtureCheck.error?.message || fixtureCheck.stderr);
  const mode = options.mode || 'api';
  const metadata = [identity, team, ...(mode === 'api' ? ['123456789A', issuer] : ['test@example.invalid'])];
  const inputs = [...metadata, ...(options.noToken ? [] : [token]), password, ...(mode === 'password' ? [appPassword] : []), `${options.repo || 'autonome/peek-builds'}/${options.env || 'macos-release-signing'} ${mode}`];
  const configFile = path.join(dir, 'signing.env');
  const hasConfig = options.config !== null;
  const baseConfig = 'REVIEWER_LOGIN=release-reviewer\nREF_PATTERN=candidate-*\nREF_TYPE=tag\n';
  if (hasConfig) fs.writeFileSync(configFile, typeof options.config === 'function' ? options.config({ p12, p8, base: baseConfig }) : options.config ?? baseConfig);
  if (options.state) fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(options.state));
  const args = [...(hasConfig ? ['--config', configFile] : []), ...(options.pathsFromConfig ? ['--mode', mode] : ['--p12', p12, '--mode', mode, ...(mode === 'api' ? ['--p8', p8] : [])]), ...(options.args || [])];
  const cleanEnv = { ...process.env };
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete cleanEnv[k];
  const result = spawnSync('/bin/bash', [...(options.trace ? ['-xv'] : []), script, ...args], {
    input: options.input === undefined ? inputs.join('\n') + '\n' : options.input,
    encoding: 'utf8', env: { ...cleanEnv, FAKE_TOKEN: token, PATH: `${dir}:${process.env.PATH}`, TMPDIR: dir,
      FAKE_LOG: path.join(dir, 'log'), GH_DEBUG: 'api', password: 'inherited',
      ...(options.trace ? { SHELLOPTS: 'braceexpand:hashall:interactive-comments:verbose:xtrace' } : {}),
      ...(options.fake || {}) }
  });
  const records = fs.existsSync(path.join(dir, 'log')) ? fs.readFileSync(path.join(dir, 'log'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  const output = result.stdout + result.stderr;
  for (const secret of [token, password, appPassword, p12Value, Buffer.from(p12Value).toString('base64'), 'FAKE-PRIVATE-MATERIAL']) {
    assert.ok(!output.includes(secret), `secret in output: ${output}`);
    assert.ok(!JSON.stringify(records.map(r => r.args)).includes(secret), 'secret in argv');
  }
  for (const record of records) { assert.equal(record.debug, ''); assert.deepEqual(record.leaked, []); }
  const tmpLeft = fs.readdirSync(dir).filter(f => f.startsWith('peek-gh-config.'));
  assert.deepEqual(tmpLeft, [], 'temporary gh config dir not removed');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['AuthKey.p8', 'certificate.p12', 'gh', 'package.json', ...(hasConfig ? ['signing.env'] : []), ...(fs.existsSync(path.join(dir, 'state.json')) ? ['state.json'] : []), ...(records.length ? ['log'] : [])].sort(), 'unexpected temporary file');
  const apiCalls = records.filter(r => r.args[0] === 'api').map(r => r.args.join(' '));
  return { ...result, output, records, apiCalls, uploads: records.filter(r => r.args[1] === 'set') };
}
test('help and dry-run never call gh or request passwords', t => {
  assert.ok(fs.statSync(script).mode & 0o111, 'setup script must be executable');
  const help = run(t, { args: ['--help'], input: '' });
  assert.equal(help.status, 0); assert.match(help.output, /Usage:/); assert.equal(help.records.length, 0);
  const dry = run(t, { args: ['--dry-run'], input: [identity, team, '123456789A', issuer].join('\n') + '\n' });
  assert.equal(dry.status, 0); assert.match(dry.output, /Remote prerequisites NOT checked/); assert.match(dry.output, /token will be requested/); assert.match(dry.output, /Administration: read and write/); assert.equal(dry.records.length, 0);
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
    { input: [identity, team, '123456789A', issuer, 'ghp_classictoken'].join('\n') + '\n' },
    { input: [identity, team, '123456789A', 'bad'].join('\n') + '\n' },
    { input: [identity, team, '123456789A', issuer, token, password, 'no'].join('\n') + '\n' },
  ]) {
    const r = run(t, options); assert.notEqual(r.status, 0, r.output); assert.equal(r.uploads.length, 0);
  }
});
test('existing opposite-mode names refused in either mode; environment required', t => {
  for (const options of [
    { fake: { FAKE_NAMES: 'OTHER\nAPPLE_ID' } },
    { mode: 'password', fake: { FAKE_NAMES: 'APPLE_API_KEY_P8' } },
    { fake: { FAKE_NO_ENV: '1' } },
        { fake: { FAKE_FAIL_COMMAND: 'secret' } },
  ]) { const r = run(t, options); assert.notEqual(r.status, 0); assert.equal(r.uploads.length, 0); }
});
test('partial failure stops immediately, hides gh error payload and explains retry', t => {
  const r = run(t, { fake: { FAKE_FAIL: 'MACOS_CERTIFICATE_PASSWORD' } });
  assert.notEqual(r.status, 0); assert.equal(r.uploads.length, 2);
  assert.match(r.output, /after 1 successful uploads/); assert.match(r.output, /SAME mode\/destination/);
});
const confirmLine = 'autonome/peek-builds/macos-release-signing api';
const fullConfig = ({ p12, p8, base }) => `# comment\n\n${base}P12_PATH=${p12}\nP8_PATH=${p8}\nSIGNING_IDENTITY=${identity}\nTEAM_ID=${team}\nAPI_KEY_ID=123456789A\nAPI_ISSUER=${issuer}\n`;
test('config file supplies paths and metadata; only the password and confirmation are prompted', t => {
  const r = run(t, { config: fullConfig, pathsFromConfig: true, input: [token, password, confirmLine].join('\n') + '\n' });
  assert.equal(r.status, 0, r.output); assert.equal(r.uploads.length, 7);
  const values = Object.fromEntries(r.uploads.map(u => [u.args[2], u.input]));
  assert.equal(values.MACOS_SIGNING_IDENTITY, identity); assert.equal(values.APPLE_API_KEY_ID, '123456789A');
  assert.equal(values.MACOS_CERTIFICATE_PASSWORD, password);
});
test('config values still go through validation; command-line options override the file', t => {
  const bad = run(t, { config: ({ base }) => base + 'TEAM_ID=lowercase\nSIGNING_IDENTITY=' + identity + '\n', input: '' });
  assert.notEqual(bad.status, 0); assert.equal(bad.records.length, 0);
  const override = run(t, { config: ({ base }) => base + 'REPO=other/repo\n', args: ['--repo', 'autonome/peek-builds'] });
  assert.equal(override.status, 0, override.output);
  assert.ok(override.apiCalls.every(c => !c.includes('other/repo')));
});
test('config parser is a strict allowlist and never evaluates content', t => {
  const marker = path.join(os.tmpdir(), `peek-signing-injection-${process.pid}`);
  for (const text of [
    'UNKNOWN_KEY=1\n', 'P12_PASSWORD=x\n', 'MACOS_CERTIFICATE_PASSWORD=x\n', 'APPLE_APP_SPECIFIC_PASSWORD=x\n',
    'export REPO=a/b\n', 'REPO = a/b\n', 'REPO=a/b\nREPO=c/d\n', 'not a line\n', 'repo=a/b\n',
    `REPO=$(touch ${marker})\n`, `ENVIRONMENT=\`touch ${marker}\`\n`,
  ]) {
    const r = run(t, { config: ({ base }) => base + text, input: '' });
    assert.notEqual(r.status, 0, text); assert.equal(r.records.length, 0, text);
  }
  assert.ok(!fs.existsSync(marker), 'config content was evaluated');
  const missing = run(t, { config: null, args: ['--config', '/nonexistent/signing.env'], input: '' });
  assert.notEqual(missing.status, 0);
});
test('environment is created with reviewer and ref policy, read back, then secrets upload', t => {
  const r = run(t);
  assert.equal(r.status, 0, r.output); assert.equal(r.uploads.length, 7);
  const put = r.apiCalls.find(c => c.includes('-X PUT'));
  assert.match(put, /repos\/autonome\/peek-builds\/environments\/macos-release-signing/);
  assert.match(put, /reviewers\[\]\[id\]=4242/); assert.match(put, /custom_branch_policies\]=true/);
  assert.ok(r.apiCalls.includes('api users/release-reviewer --jq .id'));
  assert.equal(r.apiCalls.filter(c => c.includes('-X POST')).length, 1);
  assert.match(r.apiCalls.find(c => c.includes('-X POST')), /-f name=candidate-\* -f type=tag/);
  const lastApi = r.records.map(x => x.args).reduce((a, x, i) => x[0] === 'api' ? i : a, -1);
  assert.ok(lastApi < r.records.findIndex(x => x.args[1] === 'set'), 'verification precedes uploads');
});
test('environment setup is idempotent: existing matching policy is not duplicated', t => {
  const r = run(t, { state: { reviewers: ['4242'], custom: true, policies: ['tag candidate-*'] } });
  assert.equal(r.status, 0, r.output);
  assert.equal(r.apiCalls.filter(c => c.includes('-X POST')).length, 0);
  assert.equal(r.apiCalls.filter(c => c.includes('-X PUT')).length, 1);
  const other = run(t, { state: { reviewers: ['1'], custom: false, policies: ['branch main'] } });
  assert.equal(other.status, 0, other.output);
  assert.equal(other.apiCalls.filter(c => c.includes('-X POST')).length, 1);
});
test('refuses to upload when protections are not in effect', t => {
  for (const fake of [{ FAKE_NO_REVIEWERS: '1' }, { FAKE_NO_CUSTOM: '1' }, { FAKE_FAIL_PUT: '1' }]) {
    const r = run(t, { fake });
    assert.notEqual(r.status, 0, JSON.stringify(fake)); assert.equal(r.uploads.length, 0);
  }
  const plan = run(t, { fake: { FAKE_NO_REVIEWERS: '1' } });
  assert.match(plan.output, /reviewer .* NOT in effect/);
  const missingSettings = run(t, { config: '', input: '' });
  assert.notEqual(missingSettings.status, 0); assert.match(missingSettings.output, /REVIEWER_LOGIN and REF_PATTERN/);
  assert.equal(missingSettings.records.length, 0);
  for (const line of ['REVIEWER_LOGIN=-bad', 'REF_TYPE=other', 'REF_PATTERN=a b']) {
    const r = run(t, { config: ({ base }) => base + line + '\n', input: '' });
    assert.notEqual(r.status, 0, line);
  }
});
test('--allow-unprotected skips protection setup, warns, and only checks the environment exists', t => {
  const r = run(t, { config: null, args: ['--allow-unprotected'] });
  assert.equal(r.status, 0, r.output); assert.equal(r.uploads.length, 7);
  assert.match(r.output, /WARNING: --allow-unprotected/);
  assert.ok(r.apiCalls.every(c => !c.includes('PUT') && !c.includes('POST')));
});
test('dry-run prints planned gh api calls and contacts nothing', t => {
  const r = run(t, { args: ['--dry-run'], input: [identity, team, '123456789A', issuer].join('\n') + '\n' });
  assert.equal(r.status, 0, r.output); assert.equal(r.records.length, 0);
  assert.match(r.output, /gh api -X PUT repos\/autonome\/peek-builds\/environments\/macos-release-signing/);
  assert.match(r.output, /-f name=candidate-\* -f type=tag/); assert.match(r.output, /release-reviewer/);
});
test('token comes from the hidden prompt, reaches gh, and the gh config dir is empty and removed', t => {
  const r = run(t);
  assert.equal(r.status, 0, r.output);
  assert.ok(r.records.length > 0 && r.records.every(x => x.tokenSeen), 'gh did not see the token');
  const dirs = new Set(r.records.map(x => x.cfgDir)); assert.equal(dirs.size, 1);
  const [cfg] = dirs; assert.ok(cfg && path.basename(cfg).startsWith('peek-gh-config.'));
  assert.ok(r.records.every(x => Array.isArray(x.cfgEntries) && x.cfgEntries.length === 0), 'config dir not empty');
  assert.ok(!fs.existsSync(cfg), 'config dir remains');
  assert.equal(r.records[0].args.join(' '), 'api repos/autonome/peek-builds --silent', 'token check comes first');
  assert.ok(!r.records.some(x => x.args[0] === 'auth'), 'gh auth must not be used');
});
test('ambient token variables are refused before anything runs', t => {
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN']) {
    const r = run(t, { fake: { [name]: 'github_pat_AMBIENT' }, args: ['--dry-run'] });
    assert.notEqual(r.status, 0, name); assert.match(r.output, new RegExp(name + ' is set')); assert.equal(r.records.length, 0);
  }
});
test('a rejected token stops before any write, names the permissions, and hides gh output', t => {
  const r = run(t, { fake: { FAKE_BAD_TOKEN: '1' } });
  assert.notEqual(r.status, 0); assert.equal(r.records.length, 1); assert.equal(r.uploads.length, 0);
  assert.match(r.output, /Administration: read and write/); assert.match(r.output, /Environments: read and write/);
  assert.ok(!r.output.includes('GH-BODY-LEAK'));
});
test('a token that is not fine-grained is refused without calling gh', t => {
  const r = run(t, { input: [identity, team, '123456789A', issuer, 'ghp_classictoken', password].join('\n') + '\n' });
  assert.notEqual(r.status, 0); assert.equal(r.records.length, 0); assert.match(r.output, /fine-grained/);
});
