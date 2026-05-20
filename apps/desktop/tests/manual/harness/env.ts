/**
 * Tiny .env file loader.
 *
 * No dotenv dependency — this parses just what we need: KEY=VALUE lines,
 * comments starting with '#', optional surrounding quotes. Multi-line and
 * variable interpolation are unsupported on purpose.
 */

import fs from 'fs';
import path from 'path';

export interface LoadEnvResult {
  env: Record<string, string>;
  /** Names of keys that were loaded — useful for redaction in trace metadata. */
  loadedKeys: string[];
  /** Path that was actually read, or null if the file didn't exist. */
  source: string | null;
}

export function loadEnv(envFile: string | undefined, repoRoot: string): LoadEnvResult {
  if (!envFile) return { env: {}, loadedKeys: [], source: null };

  const abs = path.isAbsolute(envFile) ? envFile : path.join(repoRoot, envFile);
  if (!fs.existsSync(abs)) return { env: {}, loadedKeys: [], source: null };

  const raw = fs.readFileSync(abs, 'utf8');
  const env: Record<string, string> = {};
  const loadedKeys: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
    loadedKeys.push(key);
  }

  return { env, loadedKeys, source: abs };
}

export function assertRequiredEnv(env: Record<string, string>, required: string[] | undefined, scenarioName: string): void {
  if (!required || required.length === 0) return;
  const missing = required.filter((k) => !env[k] || env[k].length === 0);
  if (missing.length > 0) {
    throw new Error(
      `[harness:${scenarioName}] missing required env: ${missing.join(', ')}. ` +
      `Populate them in the scenario's envFile (typically .env.<scenario>.local at repo root).`,
    );
  }
}
