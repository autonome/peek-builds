// single-launch-focus.mjs — automated, ~5-second single-launch focus-theft probe.
//
// WHY: the desktop Playwright suite launches ~140 Electron processes and each
// grabs macOS focus at launch (pre-JS activation), repeatedly stealing focus
// from whoever is at the machine. We must NOT use a suite run to test a fix —
// that IS the focus theft, ~140x over minutes. This launches exactly ONE
// Electron process and reports whether it became the frontmost (active) app.
//
// Mechanism: a swift NSWorkspace sampler streams the frontmost bundle id every
// 50ms (no special permissions). We launch one Electron via Playwright's
// _electron.launch — the SAME mechanism the suite uses (posix_spawn of the
// binary, NOT LaunchServices `open`) — and check whether com.github.Electron
// ever appears as frontmost during its lifetime.
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

// Electron identity in NSWorkspace: bundled Electron.app reports
// com.github.Electron; localizedName "Electron" as a fallback.
const isElectron = (id) => /electron/i.test(id);

async function main() {
  const samples = [];
  // Sampler runs long enough to cover warmup(1.8) + launch + hold + teardown.
  const samplerDuration = (1.8 + Number(HOLD) / 1000 + 2.5).toFixed(1);
  const sampler = spawn('swift', [swiftProbe, samplerDuration, '0.05'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  sampler.stdout.on('data', (d) => {
    for (const line of d.toString().split('\n')) {
      const parts = line.split(',');
      if (parts.length < 3) continue;
      const ts = Number(parts[0]);
      const id = parts[1].trim();
      const pid = Number(parts[2]);
      if (id) samples.push({ ts, id, pid });
    }
  });

  // Let swift compile + start sampling before we launch.
  await sleep(1800);
  const beforeId = samples.length ? samples[samples.length - 1].id : 'unknown';

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

  // Attribution: the LAUNCHED app stole focus iff a sample's frontmost PID
  // equals the launched process PID. Bundle-id matching (com.github.Electron
  // for source, com.autonome.peek for packaged) is a secondary signal — but
  // com.autonome.peek collides with a running production Peek, so PID wins.
  const stolenSamples = launchedPid
    ? samples.filter((s) => s.pid === launchedPid)
    : samples.filter((s) => isElectron(s.id));
  const distinct = [...new Set(samples.map((s) => `${s.id}#${s.pid}`))];

  console.log('════════════════════════════════════════════════════════');
  console.log(`  FOCUS PROBE: ${LABEL}`);
  console.log('════════════════════════════════════════════════════════');
  console.log(`  executablePath : ${launchConfig.executablePath || '(bundled electron)'}`);
  console.log(`  JS accessory   : ${process.env.PROBE_JS_ACCESSORY === '1'}`);
  console.log(`  launched PID   : ${launchedPid ?? '(launch failed)'}`);
  console.log(`  frontmost before launch : ${beforeId}`);
  console.log(`  total samples           : ${samples.length}`);
  console.log(`  launched-app frontmost  : ${stolenSamples.length}`);
  console.log(`  distinct frontmost seen : ${distinct.join(' | ')}`);
  if (launchErr) console.log(`  LAUNCH ERROR   : ${launchErr.message}`);
  console.log('  ------------------------------------------------------');
  console.log(
    stolenSamples.length
      ? '  RESULT: ❌ FOCUS STOLEN — the launched app became frontmost'
      : '  RESULT: ✅ no focus theft — the launched app never frontmost',
  );
  console.log('════════════════════════════════════════════════════════');

  process.exit(stolenSamples.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
