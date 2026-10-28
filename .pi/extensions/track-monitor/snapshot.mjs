// Explicit read-only smoke check. No Pi, model requests, timers or lease.
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createCollector, readSmall, validateConfig } from './collector.mjs';
import { describe } from './core.mjs';

try {
  const repo = await realpath(process.cwd());
  const config = validateConfig(JSON.parse(await readSmall(join(repo, '.pi/track-monitor.json'), 65536)));
  const collect = createCollector(repo, config);
  const entries = await collect();
  for (const entry of entries) console.log(describe(entry));
  if (!entries.some(e => e.kind === 'track') || !entries.some(e => e.kind === 'ci')) {
    console.error('Partial snapshot: a source is unavailable. Monitor mode reports persistent failures after three samples.');
    process.exitCode = 1;
  }
} catch {
  console.error('Snapshot unavailable; no raw errors, credentials or logs emitted.');
  process.exitCode = 1;
}
