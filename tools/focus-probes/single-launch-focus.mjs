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
const noopMain = path.join(__dirname, 'noop-main.cjs');
const swiftProbe = path.join(__dirname, 'frontmost-stream.swift');

const LABEL = process.env.PROBE_LABEL || 'baseline';
const HOLD = process.env.PROBE_HOLD_MS || '2500';
const EXE = process.env.PROBE_EXECUTABLE || null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Electron identity in NSWorkspace: bundled Electron.app reports
// com.github.Electron; localizedName "Electron" as a fallback.
const isElectron = (id) => /electron/i.test(id);

async function main() {
  const samples = [];
  // Sampler runs long enough to cover warmup + launch + hold + teardown.
  const sampler = spawn('swift', [swiftProbe, '7.0', '0.05'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  sampler.stdout.on('data', (d) => {
    for (const line of d.toString().split('\n')) {
      const comma = line.indexOf(',');
      if (comma < 0) continue;
      const ts = Number(line.slice(0, comma));
      const id = line.slice(comma + 1).trim();
      if (id) samples.push({ ts, id });
    }
  });

  // Let swift compile + start sampling before we launch.
  await sleep(1800);
  const beforeId = samples.length ? samples[samples.length - 1].id : 'unknown';

  const launchConfig = {
    args: [noopMain],
    env: { ...process.env, PROBE_HOLD_MS: HOLD },
  };
  if (EXE) launchConfig.executablePath = EXE;

  let launchErr = null;
  let app = null;
  const tLaunch = Date.now();
  try {
    app = await _electron.launch(launchConfig);
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

  const electronSamples = samples.filter((s) => isElectron(s.id));
  const distinct = [...new Set(samples.map((s) => s.id))];

  console.log('════════════════════════════════════════════════════════');
  console.log(`  FOCUS PROBE: ${LABEL}`);
  console.log('════════════════════════════════════════════════════════');
  console.log(`  executablePath : ${EXE || '(bundled electron)'}`);
  console.log(`  JS accessory   : ${process.env.PROBE_JS_ACCESSORY === '1'}`);
  console.log(`  frontmost before launch : ${beforeId}`);
  console.log(`  total samples           : ${samples.length}`);
  console.log(`  electron-frontmost hits : ${electronSamples.length}`);
  console.log(`  distinct frontmost seen : ${distinct.join(' | ')}`);
  if (launchErr) console.log(`  LAUNCH ERROR   : ${launchErr.message}`);
  console.log('  ------------------------------------------------------');
  console.log(
    electronSamples.length
      ? '  RESULT: ❌ FOCUS STOLEN — Electron became frontmost'
      : '  RESULT: ✅ no focus theft — Electron never frontmost',
  );
  console.log('════════════════════════════════════════════════════════');

  process.exit(electronSamples.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
