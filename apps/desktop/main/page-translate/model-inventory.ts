/**
 * What the translations cache holds and what a pair would cost to fetch, for the models
 * manager: list the directions on disk with their size, delete one, and estimate a download.
 *
 * A direction is one `<root>/models/<src>-<tgt>` folder (`model-store.ts pairCacheDir`); it may
 * hold more than one model version, and its size counts every file under it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { cachePath, pairCacheDir, parsePairDirName, type ModelRecord, type TranslationPlan } from './model-store.js';

export interface InstalledDirection {
  sourceLanguage: string;
  targetLanguage: string;
  /** Bytes on disk under the direction's folder. */
  bytes: number;
}

async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await folderBytes(full);
    else if (entry.isFile()) total += (await fs.promises.stat(full)).size;
  }
  return total;
}

/** Every direction with files on disk, sorted by source then target. Unrecognised folders are skipped. */
export async function listInstalledDirections(root: string): Promise<InstalledDirection[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(path.join(root, 'models'), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: InstalledDirection[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pair = parsePairDirName(entry.name);
    if (!pair) continue;
    const bytes = await folderBytes(path.join(root, 'models', entry.name));
    if (bytes > 0) out.push({ ...pair, bytes });
  }
  return out.sort((a, b) => a.sourceLanguage.localeCompare(b.sourceLanguage) || a.targetLanguage.localeCompare(b.targetLanguage));
}

/** Removes one direction's folder. Answers whether anything was there. Throws on an unsafe tag. */
export async function deleteInstalledDirection(root: string, sourceLanguage: string, targetLanguage: string): Promise<boolean> {
  const dir = pairCacheDir(root, sourceLanguage, targetLanguage);
  const existed = fs.existsSync(dir);
  await fs.promises.rm(dir, { recursive: true, force: true });
  return existed;
}

export interface StepEstimate {
  sourceLanguage: string;
  targetLanguage: string;
  /** Compressed bytes still to fetch for this step; 0 when every file is on disk. */
  downloadBytes: number;
  /** Decompressed bytes the step occupies once present. */
  diskBytes: number;
}

export type DownloadEstimate =
  | { ok: true; downloadBytes: number; diskBytes: number; steps: StepEstimate[] }
  | Exclude<TranslationPlan, { ok: true }>;

/**
 * A file counts as present when it exists at its cache path with the record's decompressed
 * size. The hash is not read here (a model file is ~30 MB); `model-download.ts` checks it before
 * any use, so a same-size corrupt file costs a later download, not a wrong translation.
 */
async function isPresent(root: string, record: ModelRecord): Promise<boolean> {
  try {
    return (await fs.promises.stat(cachePath(root, record))).size === record.decompressedSize;
  } catch {
    return false;
  }
}

/** What fetching every file of `plan` would download and occupy, counting files already present as free. */
export async function estimateDownload(root: string, plan: TranslationPlan): Promise<DownloadEstimate> {
  if (!plan.ok) return plan;
  const steps: StepEstimate[] = [];
  for (const step of plan.steps) {
    let downloadBytes = 0;
    let diskBytes = 0;
    for (const record of Object.values(step.files)) {
      if (!record) continue;
      diskBytes += record.decompressedSize;
      if (!(await isPresent(root, record))) downloadBytes += record.attachment.size;
    }
    steps.push({ sourceLanguage: step.sourceLanguage, targetLanguage: step.targetLanguage, downloadBytes, diskBytes });
  }
  return {
    ok: true,
    downloadBytes: steps.reduce((n, s) => n + s.downloadBytes, 0),
    diskBytes: steps.reduce((n, s) => n + s.diskBytes, 0),
    steps,
  };
}
