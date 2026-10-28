'use strict';

/**
 * Candidate signing policy and adapter-driven orchestration.
 *
 * Deliberately NOT a CLI or a production macOS adapter. No subprocesses, secret
 * writes, network, uploads or public publisher are reachable from this module.
 * A future macOS adapter must supply the operations below and parse actual tool
 * output into the evidence contract. Fake evidence is not Apple acceptance.
 */
const path = require('node:path');

class SigningError extends Error {
  constructor(code, submissionId) {
    // Never include a tool error, credential, raw output or path in diagnostics.
    super(`macOS candidate blocked: ${code}`);
    this.name = 'SigningError';
    this.code = code;
    if (isSubmissionId(submissionId)) this.submissionId = submissionId;
  }
}
function fail(code, id) { throw new SigningError(code, id); }
function check(value, code) { if (!value) fail(code); }
function nonempty(value) { return typeof value === 'string' && value.trim().length > 0; }
function matches(value, pattern) {
  // JS `$` also matches before a final newline: insist on a full match.
  return typeof value === 'string' && pattern.exec(value)?.[0] === value;
}
function isSubmissionId(value) {
  return matches(value, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
}
const API = ['APPLE_API_KEY_P8', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
const PASSWORD = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD'];
const AMBIENT = [
  'APPLE_API_KEY', 'APPLE_KEYCHAIN', 'APPLE_KEYCHAIN_PROFILE',
  'CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'CSC_KEYCHAIN',
  'CSC_IDENTITY_AUTO_DISCOVERY', 'DEBUG', 'GH_DEBUG', 'NODE_OPTIONS',
];

function validateConfig(input, env = {}) {
  check(input && ['unsigned', 'candidate'].includes(input.mode), 'mode');
  // Explicit unsigned mode has no signing side effects or credential reads.
  if (input.mode === 'unsigned') return Object.freeze({ mode: 'unsigned' });
  check(matches(input.teamId, /^[A-Z0-9]{10}$/), 'team');
  check(typeof input.identity === 'string' &&
    /^Developer ID Application: [^\r\n]+ \([A-Z0-9]{10}\)$/.test(input.identity) &&
    input.identity.endsWith(` (${input.teamId})`), 'identity');
  // Proposed policy only: canonical Apple numeric major.minor.patch bounds.
  check(matches(input.buildVersion, /^[1-9]\d{0,3}\.(?:0|[1-9]\d?)\.(?:0|[1-9]\d?)$/), 'build-version');
  check(matches(input.commit, /^[a-f0-9]{40}$/), 'commit');
  check(input.bundleId === 'com.autonome.peek', 'bundle-id');
  check(nonempty(env.MACOS_CERTIFICATE_P12_BASE64) &&
    nonempty(env.MACOS_CERTIFICATE_PASSWORD), 'certificate');
  check(!AMBIENT.some(k => env[k] !== undefined && env[k] !== ''), 'ambient-auth-or-debug');
  // Presence, including an empty value, selects a mode; empty conflicting names
  // must not accidentally allow fallback to an inherited second credential set.
  const apiPresent = API.some(k => env[k] !== undefined);
  const passwordPresent = PASSWORD.some(k => env[k] !== undefined);
  check(apiPresent !== passwordPresent, 'auth-mode');
  const authMode = apiPresent ? 'api' : 'password';
  check((apiPresent ? API : PASSWORD).every(k => nonempty(env[k])), 'auth-incomplete');
  if (apiPresent) {
    check(matches(env.APPLE_API_KEY_ID, /^[A-Z0-9]{10}$/), 'api-key-id');
    check(isSubmissionId(env.APPLE_API_ISSUER), 'api-issuer');
    check(/^-----BEGIN PRIVATE KEY-----\r?\n[\s\S]+\r?\n-----END PRIVATE KEY-----\s*$/.test(env.APPLE_API_KEY_P8), 'api-key-shape');
  }
  check(env.APPLE_TEAM_ID === input.teamId, 'auth-team');
  check(env.MACOS_SIGNING_IDENTITY === input.identity, 'auth-identity');
  // Never return credentials in configuration, receipts or errors.
  return Object.freeze({
    mode: 'candidate', authMode, teamId: input.teamId, identity: input.identity,
    buildVersion: input.buildVersion, commit: input.commit, bundleId: input.bundleId,
    forceCodeSigning: true, hardenedRuntime: true, signDmg: true,
  });
}

function validateNative(entries) {
  check(Array.isArray(entries), 'native-inventory');
  for (const name of ['peek-desktop-helper', 'nonactivating-window.node']) {
    const matches = entries.filter(e => e && e.name === name);
    check(matches.length === 1, 'native-missing-or-duplicate');
    const e = matches[0];
    check(e.regularFile === true && e.machO === true &&
      Array.isArray(e.architectures) && e.architectures.length === 1 &&
      e.architectures[0] === 'arm64', 'native-architecture');
    check(e.name !== 'peek-desktop-helper' || e.executable === true, 'native-executable');
  }
}

function validateEntitlements(entitlements, role) {
  check(entitlements && typeof entitlements === 'object' && !Array.isArray(entitlements), 'entitlements');
  const keys = Object.keys(entitlements);
  if (role === 'electron') {
    check(keys.length === 1 && keys[0] === 'com.apple.security.cs.allow-jit' &&
      entitlements[keys[0]] === true, 'electron-entitlements');
  } else {
    check(keys.length === 0, 'minimal-entitlements');
  }
}

function validateSignature(text, policy, executable = true) {
  check(typeof text === 'string', 'signature-output');
  const lines = text.split(/\r?\n/);
  check(lines.filter(l => l === `Authority=${policy.identity}`).length === 1, 'signature-authority');
  check(lines.includes('Authority=Developer ID Certification Authority') &&
    lines.includes('Authority=Apple Root CA'), 'signature-chain');
  check(lines.filter(l => l.startsWith('TeamIdentifier=')).length === 1 &&
    lines.includes(`TeamIdentifier=${policy.teamId}`), 'signature-team');
  check(!lines.some(l => /adhoc|ad-hoc|^Signed Time=/.test(l)), 'signature-adhoc');
  const stamps = lines.filter(l => l.startsWith('Timestamp='));
  check(stamps.length === 1 && /\d{1,2}:\d{2}:\d{2}/.test(stamps[0]) &&
    Number.isFinite(Date.parse(stamps[0].slice('Timestamp='.length).replace(' at ', ' '))),
    'signature-timestamp');
  if (executable) {
    check(lines.some(l => /^CodeDirectory .*flags=0x[\da-f]+\([^)]*\bruntime\b[^)]*\)/i.test(l)), 'signature-runtime');
  }
}

function safeRelative(p) {
  return typeof p === 'string' && p.length > 0 && !p.includes('\\') &&
    !/[\r\n\0]/.test(p) && !path.posix.isAbsolute(p) &&
    p.split('/').every(part => part !== '..' && part !== '.' && part !== '');
}
function validateDependencies(dependencies) {
  check(Array.isArray(dependencies), 'dependencies');
  check(dependencies.every(dependency => {
    // Absolute dependencies must be Apple system libraries. Dynamic install
    // names need the adapter's actual dyld/rpath resolution, not just a prefix
    // check: @loader_path/../Frameworks is normal, but may also escape the app.
    if (typeof dependency === 'string') {
      return !dependency.split('/').includes('..') && !/[\r\n\0]/.test(dependency) &&
        (dependency.startsWith('/System/Library/') || dependency.startsWith('/usr/lib/'));
    }
    return dependency && typeof dependency.installName === 'string' &&
      /^@(rpath|loader_path|executable_path)\//.test(dependency.installName) &&
      !/[\r\n\0]/.test(dependency.installName) && safeRelative(dependency.resolvedPath) &&
      dependency.resolvedPath.startsWith('Contents/');
  }), 'external-dependency');
}

function validateApp(evidence, policy) {
  check(evidence && evidence.deepStrict === true && evidence.staple === true &&
    evidence.gatekeeper === 'Notarized Developer ID', 'app-verification');
  check(evidence.bundleId === policy.bundleId && evidence.buildVersion === policy.buildVersion &&
    evidence.commit === policy.commit, 'app-build-identity');
  check(Array.isArray(evidence.inventory) && evidence.inventory.length > 0 &&
    evidence.inventoryComplete === true, 'app-inventory');
  const paths = new Set();
  let main = 0;
  let helper = 0;
  let addon = 0;
  for (const entry of evidence.inventory) {
    check(entry && safeRelative(entry.path) && !paths.has(entry.path), 'inventory-path');
    paths.add(entry.path);
    check(['electron', 'standalone', 'library'].includes(entry.role), 'inventory-role');
    check(entry.strict === true && entry.machO === true &&
      Array.isArray(entry.architectures) && entry.architectures.length === 1 &&
      entry.architectures[0] === 'arm64', 'inventory-code');
    validateSignature(entry.signature, policy, entry.role !== 'library');
    validateEntitlements(entry.entitlements, entry.role);
    validateDependencies(entry.dependencies);
    if (entry.path === 'Contents/MacOS/Peek') {
      check(entry.role === 'electron', 'main-role'); main++;
    }
    if (entry.path === 'Contents/Resources/peek-desktop-helper') {
      check(entry.role === 'standalone', 'helper-role'); helper++;
    }
    if (entry.path === 'Contents/Resources/nonactivating-window.node') {
      check(entry.role === 'library', 'addon-role'); addon++;
    }
  }
  check(main === 1 && helper === 1 && addon === 1, 'packaged-native-missing');
}

function parseJSON(value, code) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    check(parsed && typeof parsed === 'object' && !Array.isArray(parsed), code);
    return parsed;
  } catch { fail(code); }
}
function validateNotary(result, log) {
  const r = parseJSON(result, 'notary-json');
  check(isSubmissionId(r.id), 'notary-id');
  if (r.status !== 'Accepted') fail('notary-not-accepted', r.id);
  let l;
  try { l = parseJSON(log, 'notary-log-json'); }
  catch { fail('notary-log-json', r.id); }
  if (l.jobId !== r.id || l.status !== 'Accepted' || l.statusCode !== 0 ||
      !(l.issues === null || (Array.isArray(l.issues) && l.issues.length === 0))) {
    fail('notary-log-rejected', r.id);
  }
  return r.id;
}

function validateDmg(evidence, policy) {
  check(evidence && evidence.strict === true && evidence.container === true &&
    evidence.staple === true && evidence.gatekeeper === 'Notarized Developer ID', 'dmg-verification');
  validateSignature(evidence.signature, policy, false);
}

/**
 * Operations are supplied by a trusted adapter, not artifact metadata. That
 * adapter must inventory *all* Mach-O code (including framework symlinks), parse
 * plists, enforce tool exit status/timeouts, capture output privately, and verify
 * the evidence flags. `pack` includes afterPack; `signApp` signs inside-out.
 * `archive` creates ZIP/DMG only after the app staple. verifyZip/verifyDmgApp
 * must extract/mount-copy into fresh directories and verify those copies.
 *
 * prepare/cleanup own temporary credentials, keychain search-list restoration,
 * unmounts and scratch removal, including partially failed prepare. The adapter
 * must also arrange signal cleanup; hard-kill VM disposal is the last backstop.
 * No upload permit is returned until all checks AND cleanup succeed. The return
 * is internal policy evidence, not a durable/portable attestation or public
 * release approval. A future workflow still needs an independent upload gate.
 */
async function runCandidate(input, env, operations) {
  const policy = validateConfig(input, env);
  if (policy.mode === 'unsigned') return Object.freeze({ mode: 'unsigned' });
  const required = [
    'preflight', 'prepare', 'pack', 'signApp', 'submitApp', 'stapleApp',
    'verifyApp', 'archive', 'signDmg', 'submitDmg', 'stapleDmg', 'verifyDmg',
    'verifyZip', 'verifyDmgApp', 'cleanup', 'hashFinal',
  ];
  check(operations && required.every(k => typeof operations[k] === 'function'), 'adapter-incomplete');
  let failure;
  const ids = [];
  try {
    validateNative(await operations.preflight(policy));
    await operations.prepare(policy, env);
    await operations.pack(policy);
    await operations.signApp(policy);
    const appNotary = await operations.submitApp(policy);
    ids.push(validateNotary(appNotary?.result, appNotary?.log));
    await operations.stapleApp(policy);
    validateApp(await operations.verifyApp(policy), policy);
    await operations.archive(policy);
    await operations.signDmg(policy);
    const dmgNotary = await operations.submitDmg(policy);
    ids.push(validateNotary(dmgNotary?.result, dmgNotary?.log));
    await operations.stapleDmg(policy);
    validateDmg(await operations.verifyDmg(policy), policy);
    validateApp(await operations.verifyZip(policy), policy);
    validateApp(await operations.verifyDmgApp(policy), policy);
  } catch (error) {
    failure = error instanceof SigningError ? error :
      new SigningError('adapter-failed', error?.submissionId);
  } finally {
    try { await operations.cleanup(); }
    catch { failure = new SigningError('cleanup-failed', failure?.submissionId); }
  }
  if (failure) {
    failure.submissionIds = Object.freeze([...new Set([
      ...ids, ...(failure.submissionId ? [failure.submissionId] : []),
    ])]);
    throw failure;
  }
  // Hash only final stapled bytes. The production adapter must keep these bytes
  // immutable until upload and prohibit extra/staging artifacts in its manifest.
  let artifacts;
  try { artifacts = await operations.hashFinal(policy); }
  catch { fail('hash-failed'); }
  check(Array.isArray(artifacts) && artifacts.length === 2, 'artifact-manifest');
  const names = new Set();
  for (const a of artifacts) {
    check(a && matches(a.name, /^Peek-[A-Za-z0-9._-]+\.(zip|dmg)$/) &&
      !names.has(a.name) && matches(a.sha256, /^[a-f0-9]{64}$/), 'artifact-manifest');
    names.add(a.name);
  }
  check(artifacts.filter(a => a.name.endsWith('.zip')).length === 1 &&
    artifacts.filter(a => a.name.endsWith('.dmg')).length === 1, 'artifact-formats');
  return Object.freeze({ mode: 'candidate', commit: policy.commit,
    submissionIds: Object.freeze([...ids]),
    artifacts: Object.freeze(artifacts.map(a => Object.freeze({ name: a.name, sha256: a.sha256 }))),
  });
}

module.exports = {
  SigningError, validateConfig, validateNative, validateSignature,
  validateEntitlements, validateDependencies, validateApp, validateNotary,
  validateDmg, runCandidate,
};
