// single-launch-focus.mjs — automated, ~5-second single-launch focus-theft probe.
//
// WHY: the desktop Playwright suite launches ~140 Electron processes and each
// grabs the macOS KEY WINDOW at launch (pre-JS activation), repeatedly stealing
// keyboard focus from whoever is at the machine. We must NOT use a suite run to
// test a fix — that IS the focus theft, ~140x over minutes. This launches
// exactly ONE Electron process and reports whether it grabbed the topmost /
// key window.
//
// Mechanism: a swift sampler streams the OWNER of the topmost on-screen window
// (the current key window) every 50ms via CGWindowList (no special
// permissions — owner PID/layer/bounds need none, only window NAMES do). We
// launch one Electron via Playwright's _electron.launch — the SAME mechanism
// the suite uses (posix_spawn of the binary, NOT LaunchServices `open`) — and
// check whether the launched PID ever owns the topmost/key window during its
// lifetime. NOTE: an _electron.launch app steals the KEY window without ever
// becoming the frontmost *application*, which is why the old
// NSWorkspace.frontmostApplication oracle reported false negatives.
//
// Env knobs:
//   PROBE_EXECUTABLE   — executablePath to launch (default: bundled electron).
//                        Point this at a patched copy to test a candidate fix.
//   PROBE_JS_ACCESSORY — '1' → noop main calls setActivationPolicy('accessory')
//                        after whenReady (the too-late JS path).
//   PROBE_LABEL        — label for the report line.
//   PROBE_HOLD_MS      — how long the launched app stays alive (default 2500).
import { _electron } from '@playwright/test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '../..');
const noopMain = path.join(__dirname, 'noop-main.cjs');
const swiftProbe = path.join(__dirname, 'frontmost-stream.swift');

const LABEL = process.env.PROBE_LABEL || 'baseline';
const HOLD = process.env.PROBE_HOLD_MS || '2500';
const EXE = process.env.PROBE_EXECUTABLE || null;
// PROBE_REAL_APP=1 → launch the REAL Peek app headless exactly as the suite
// fixture does (args:[REPO_ROOT] + PEEK_HEADLESS/E2E_TEST), instead of the
// noop main. This is the ground-truth test of whether a source suite launch
// actually steals focus.
const REAL_APP = process.env.PROBE_REAL_APP === '1';
// PROBE_PACKAGED=<path-to-Peek-binary> → launch the PACKAGED Peek.app headless
// exactly as the PACKAGED=1 gate does (executablePath=binary, no REPO_ROOT
// arg, isolated --user-data-dir). The packaged app's bundle id collides with a
// running production Peek, so attribution is by PID, not bundle id.
const PACKAGED = process.env.PROBE_PACKAGED || null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Electron identity as a topmost-window OWNER NAME: bundled Electron.app's
// kCGWindowOwnerName is "Electron". Secondary signal only — PID attribution
// (below) is authoritative.
const isElectron = (owner) => /electron/i.test(owner);

async function main() {
  const samples = [];
  // Sampler runs long enough to cover warmup(1.8) + launch + hold + teardown.
  const samplerDuration = (1.8 + Number(HOLD) / 1000 + 2.5).toFixed(1);
  const sampler = spawn('swift', [swiftProbe, samplerDuration, '0.05'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  // Swift CSV per sample: <unix-seconds>,<topmost-window-owner-name>,<owner-pid>
  // (owner-pid == -1 / owner == "none" when no layer-0 window is on screen).
  sampler.stdout.on('data', (d) => {
    for (const line of d.toString().split('\n')) {
      const parts = line.split(',');
      if (parts.length < 3) continue;
      const ts = Number(parts[0]);
      const owner = parts[1].trim();
      const pid = Number(parts[2]);
      if (owner) samples.push({ ts, owner, pid });
    }
  });

  // Let swift compile + start sampling before we launch.
  await sleep(1800);
  const beforeOwner = samples.length ? samples[samples.length - 1].owner : 'unknown';

  // PROBE_NO_HEADLESS=1 → launch WITHOUT headless gating (real visible
  // windows). This is the contrast case: the suspected true source of suite
  // focus theft is non-headless launches (e.g. HEADLESS=0 specs), not the
  // headless launch mechanism.
  const noHeadless = process.env.PROBE_NO_HEADLESS === '1';
  const realAppEnv = {
    ...process.env,
    ...(noHeadless ? {} : { PEEK_HEADLESS: '1', HEADLESS: '1' }),
    E2E_TEST: 'true',
    DEBUG: '0',
    PROFILE: `focus-probe-${process.pid}`,
  };
  let launchConfig;
  if (PACKAGED) {
    launchConfig = {
      executablePath: PACKAGED,
      args: [`--user-data-dir=${path.join(process.env.TMPDIR || '/tmp', `focus-probe-pkg-${process.pid}`)}`],
      env: realAppEnv,
    };
  } else if (REAL_APP) {
    launchConfig = { args: [REPO_ROOT], env: realAppEnv };
  } else {
    launchConfig = { args: [noopMain], env: { ...process.env, PROBE_HOLD_MS: HOLD } };
  }
  if (EXE) launchConfig.executablePath = EXE;

  let launchErr = null;
  let app = null;
  let launchedPid = null;
  try {
    app = await _electron.launch(launchConfig);
    try { launchedPid = app.process().pid; } catch { /* ignore */ }
  } catch (e) {
    launchErr = e;
  }

  await sleep(Number(HOLD) + 400);
  if (app) await app.close().catch(() => {});

  // Drain the sampler.
  await new Promise((r) => {
    sampler.on('close', r);
    setTimeout(() => { sampler.kill('SIGTERM'); r(); }, 3000);
  });

  // Attribution: the LAUNCHED app stole the key window iff a sample's
  // topmost-window OWNER PID equals the launched process PID. Owner-name
  // matching ("Electron" for source, "Peek" for packaged) is a secondary
  // signal — but the packaged name collides with a running production Peek, so
  // PID wins.
  const stolenSamples = launchedPid
    ? samples.filter((s) => s.pid === launchedPid)
    : samples.filter((s) => isElectron(s.owner));
  const distinct = [...new Set(samples.map((s) => `${s.owner}#${s.pid}`))];

  console.log('════════════════════════════════════════════════════════');
  console.log(`  FOCUS PROBE: ${LABEL}`);
  console.log('════════════════════════════════════════════════════════');
  console.log(`  executablePath : ${launchConfig.executablePath || '(bundled electron)'}`);
  console.log(`  JS accessory   : ${process.env.PROBE_JS_ACCESSORY === '1'}`);
  console.log(`  launched PID   : ${launchedPid ?? '(launch failed)'}`);
  console.log(`  topmost-window owner before launch : ${beforeOwner}`);
  console.log(`  total samples                      : ${samples.length}`);
  console.log(`  launched-app owned topmost window  : ${stolenSamples.length}`);
  console.log(`  distinct topmost owners seen       : ${distinct.join(' | ')}`);
  if (launchErr) console.log(`  LAUNCH ERROR   : ${launchErr.message}`);
  console.log('  ------------------------------------------------------');
  console.log(
    stolenSamples.length
      ? '  RESULT: ❌ FOCUS STOLEN — the launched app grabbed the topmost/key window'
      : '  RESULT: ✅ no focus theft — the launched app never owned the topmost/key window',
  );
  console.log('════════════════════════════════════════════════════════');

  process.exit(stolenSamples.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
