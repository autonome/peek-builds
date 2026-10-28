const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const script = path.resolve(__dirname, 'prepare-macos-signing-credentials.sh');
const real = spawnSync('which', ['openssl'], { encoding: 'utf8' }).stdout.trim();
const password = 'ephemeral-fixture-password'; // Test-only, never a user credential.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-preparation-test-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const secret = path.join(root, 'fixture-password'); fs.writeFileSync(secret, password, { mode: 0o600 });
  const log = path.join(root, 'argv.jsonl');
  // Only this fixture supplies test passwords via secure descriptors. The production
  // script never has a password interface; capture its original argv before injection.
  fs.writeFileSync(path.join(bin, 'openssl'), `#!/usr/bin/env node
const fs=require('node:fs'),{spawnSync}=require('node:child_process');
let a=process.argv.slice(2); fs.appendFileSync(process.env.TEST_LOG,JSON.stringify(a)+'\\n');
if(process.env.TEST_FAIL===a[0]) process.exit(1);
if(process.env.TEST_CANCEL===a[0]) { process.kill(process.ppid,'SIGTERM'); process.exit(1); }
if(a[0]==='genrsa') a.splice(1,0,'-passout','fd:3');
if(a[0]==='req') a.push('-passin','fd:3','-subj','/CN=Fixture');
if(a[0]==='pkey') a.push('-passin','fd:3');
if(a[0]==='pkcs12' && a.includes('-export')) a.push('-passin','fd:3','-passout','fd:4');
// stdin is ignored: OpenSSL 4 on macOS fails to decode keys with -passin fd: when stdin is a pipe.
const r=spawnSync(process.env.TEST_OPENSSL,a,{stdio:['ignore','inherit','inherit',fs.openSync(process.env.TEST_SECRET,'r'),fs.openSync(process.env.TEST_EMPTY || process.env.TEST_SECRET,'r')]});
process.exit(r.status ?? 1);
`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_LOG: log, TEST_SECRET: secret, TEST_OPENSSL: real };
  function run(args, extra = {}, trace = false) {
    const r = spawnSync('bash', [...(trace ? ['-xv'] : []), script, ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
    assert.ok(!(r.stdout + r.stderr).includes(password), 'no passwords in logs');
    if (fs.existsSync(log)) assert.ok(!fs.readFileSync(log, 'utf8').includes(password), 'no passwords in original argv');
    return r;
  }
  function crypto(args) {
    const fd = fs.openSync(secret, 'r');
    try { const r = spawnSync(real, args, { stdio: ['ignore', 'pipe', 'pipe', fd], encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); }
    finally { fs.closeSync(fd); }
  }
  function cert(key, name = 'Developer ID Application: Fixture (ABCDEFGHIJ)', oid = '1.2.840.113635.100.6.1.13') {
    const out = path.join(root, `cert-${Math.random()}.pem`);
    const config = path.join(root, 'extensions'); fs.writeFileSync(config, `[v3]\n${oid}=ASN1:NULL\n`);
    crypto(['req', '-new', '-x509', '-utf8', '-key', key, '-passin', 'fd:3', '-subj', `/CN=${name}/OU=ABCDEFGHIJ`, '-days', '1', '-config', config, '-extensions', 'v3', '-out', out]);
    return out;
  }
  return { root, run, crypto, cert };
}
function clean(dir) { assert.deepEqual(fs.readdirSync(dir).filter(n => n.startsWith('.prepare.')), []); }

test('help, invalid options and checkout rejection create nothing', t => {
  const f = fixture(t);
  assert.equal(f.run(['--help']).status, 0);
  for (const args of [[], ['bad'], ['generate'], ['inspect', '--cert'], ['package', '--password', 'not-secret'], ['generate', '--dir', 'relative']]) assert.notEqual(f.run(args).status, 0);
  assert.notEqual(f.run(['generate', '--dir', path.join(__dirname, 'must-not-exist')]).status, 0);
  assert.ok(!fs.existsSync(path.join(__dirname, 'must-not-exist')));
});

test('encrypted generation, PEM and DER packaging, metadata, permissions, nonoverwrite and trace safety', t => {
  const f = fixture(t), dir = path.join(f.root, 'private');
  const generated = f.run(['generate', '--dir', dir], {}, true);
  assert.equal(generated.status, 0, generated.stderr);
  const key = path.join(dir, 'developer-id-private-key.pem');
  assert.match(fs.readFileSync(key, 'utf8'), /ENCRYPTED/);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  for (const n of fs.readdirSync(dir)) assert.equal(fs.statSync(path.join(dir, n)).mode & 0o777, 0o600);
  const original = fs.readFileSync(key);
  assert.notEqual(f.run(['generate', '--dir', dir]).status, 0);
  assert.deepEqual(fs.readFileSync(key), original);
  const unicode = f.cert(key, 'Developer ID Application: Équipe (ABCDEFGHIJ)');
  const unicodeResult = f.run(['inspect', '--cert', unicode]);
  assert.equal(unicodeResult.status, 0, unicodeResult.stderr);
  assert.match(unicodeResult.stdout, /Developer ID Application: Équipe \(ABCDEFGHIJ\)/);
  const pem = f.cert(key), der = path.join(f.root, 'issued.cer');
  f.crypto(['x509', '-in', pem, '-outform', 'DER', '-out', der]);
  for (const cert of [pem, der]) {
    const inspection = f.run(['inspect', '--cert', cert]);
    assert.equal(inspection.status, 0, inspection.stderr);
    assert.match(inspection.stdout, /Signing identity \/ commonName: Developer ID Application: Fixture \(ABCDEFGHIJ\)/);
    assert.ok(!inspection.stdout.includes('PRIVATE KEY'));
    const out = path.join(f.root, path.basename(cert) + '-out'); fs.mkdirSync(out, { mode: 0o700 });
    const args = ['package', '--dir', out, '--cert', cert, '--key', key];
    const r = f.run(args, {}, true); assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.statSync(path.join(out, 'signing.p12')).mode & 0o777, 0o600);
    clean(out);
    const before = fs.readFileSync(path.join(out, 'signing.p12'));
    assert.notEqual(f.run(args).status, 0);
    assert.deepEqual(fs.readFileSync(path.join(out, 'signing.p12')), before);
  }
  clean(dir);
});

test('CSR failure preserves key; type/key mismatches, cancellation and export failures clean scratch', t => {
  const f = fixture(t), dir = path.join(f.root, 'private');
  assert.notEqual(f.run(['generate', '--dir', dir], { TEST_FAIL: 'req' }).status, 0);
  const key = path.join(dir, 'developer-id-private-key.pem'); assert.ok(fs.existsSync(key)); clean(dir);
  const pem = f.cert(key);
  const other = path.join(f.root, 'other'); assert.equal(f.run(['generate', '--dir', other]).status, 0);
  const wrongKey = path.join(other, 'developer-id-private-key.pem');
  const installer = f.cert(key, 'Developer ID Installer: Fixture (ABCDEFGHIJ)');
  const missingOid = f.cert(key, undefined, '1.2.3.4');
  const malformed = path.join(f.root, 'malformed'); fs.writeFileSync(malformed, 'not a certificate');
  assert.notEqual(f.run(['inspect', '--cert', malformed]).status, 0);
  const plaintext = path.join(f.root, 'plaintext.pem');
  f.crypto(['pkey', '-in', key, '-passin', 'fd:3', '-out', plaintext]);
  assert.notEqual(f.run(['package', '--dir', dir, '--cert', pem, '--key', plaintext]).status, 0);
  for (const [cert, k, env] of [[installer, key, {}], [missingOid, key, {}], [pem, wrongKey, {}], [pem, key, { TEST_FAIL: 'pkcs12' }], [pem, key, { TEST_CANCEL: 'pkey' }]]) {
    const r = f.run(['package', '--dir', dir, '--cert', cert, '--key', k], env);
    assert.notEqual(r.status, 0); assert.ok(!fs.existsSync(path.join(dir, 'signing.p12'))); clean(dir); assert.ok(fs.existsSync(key));
  }
  const empty = path.join(f.root, 'empty-password'); fs.writeFileSync(empty, '\n', { mode: 0o600 });
  assert.notEqual(f.run(['package', '--dir', dir, '--cert', pem, '--key', key], { TEST_EMPTY: empty }).status, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'signing.p12'))); clean(dir);
  fs.symlinkSync(path.join(f.root, 'nonexistent'), path.join(dir, 'signing.p12'));
  assert.notEqual(f.run(['package', '--dir', dir, '--cert', pem, '--key', key]).status, 0);
  assert.ok(fs.lstatSync(path.join(dir, 'signing.p12')).isSymbolicLink());
  fs.unlinkSync(path.join(dir, 'signing.p12'));
  fs.chmodSync(dir, 0o755);
  assert.notEqual(f.run(['package', '--dir', dir, '--cert', pem, '--key', key]).status, 0);
});
