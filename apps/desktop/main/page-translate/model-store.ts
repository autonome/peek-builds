/**
 * Translation model catalogue: which model files a language pair needs, where they live on
 * disk, and whether downloaded bytes are the bytes the catalogue promised.
 *
 * Records come from Mozilla's Remote Settings collection `translations-models-v2`. Each record
 * is one file (`model`, `lex`, `vocab`, or the split `srcvocab` + `trgvocab`) of one model,
 * keyed by source language, target language, architecture and version. A pair can have more
 * than one model; the `filter_expression` on each record says which Firefox builds it is meant
 * for (Android vs. desktop, nightly vs. release), and the newest remaining version wins.
 *
 * Everything here is pure. Downloading, decompressing and writing the cache build on it.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';

export type ModelFileType = 'model' | 'lex' | 'vocab' | 'srcvocab' | 'trgvocab';

export interface ModelRecordAttachment {
  hash: string;
  size: number;
  filename: string;
  location: string;
  mimetype?: string;
}

/** One record of `translations-models-v2`, as served (unknown extra fields are ignored). */
export interface ModelRecord {
  id: string;
  name: string;
  fileType: string;
  sourceLanguage: string;
  targetLanguage: string;
  architecture: string;
  version: string;
  decompressedHash: string;
  decompressedSize: number;
  filter_expression?: string;
  attachment: ModelRecordAttachment;
  last_modified?: number;
}

/** One direction of translation backed by one model, with every file it needs. */
export interface PairPlan {
  sourceLanguage: string;
  targetLanguage: string;
  architecture: string;
  version: string;
  /** Always `model` and `lex`; then either `vocab`, or both `srcvocab` and `trgvocab`. */
  files: Partial<Record<ModelFileType, ModelRecord>>;
}

export type TranslationPlan =
  | { ok: true; steps: PairPlan[] }
  | { ok: false; reason: 'same-language' }
  | { ok: false; reason: 'unsupported'; missing: Array<{ sourceLanguage: string; targetLanguage: string }> };

/** What the record filters are evaluated against. */
export interface CatalogueEnv {
  /** Only ever compared with `'Android'`; Peek is never Android. */
  os: string;
  /** Firefox channel name. `release` drops the nightly-only models. */
  channel: string;
}

export interface ResolveOptions {
  env?: CatalogueEnv;
  /** Prefer this architecture when the newest versions tie or it is available at all. */
  architecture?: string;
  /** Highest model major version the bundled engine reads. */
  maxMajorVersion?: number;
}

export const PIVOT_LANGUAGE = 'en';
export const SUPPORTED_MODEL_MAJOR_VERSION = 3;
export const DEFAULT_CATALOGUE_ENV: CatalogueEnv = { os: 'Desktop', channel: 'release' };

const KNOWN_FILE_TYPES: ReadonlySet<string> = new Set(['model', 'lex', 'vocab', 'srcvocab', 'trgvocab']);

/**
 * Evaluate a record's `filter_expression`. Only the shapes the collection actually uses are
 * understood; anything else excludes the record, since a filter that cannot be read cannot be
 * shown to apply.
 */
export function recordApplies(record: Pick<ModelRecord, 'filter_expression'>, env: CatalogueEnv): boolean {
  const expr = (record.filter_expression ?? '').trim();
  if (expr === '') return true;
  const terms = expr.split('||').map((term) => /^env\.(appinfo\.OS|channel)\s*(==|!=)\s*'([^']*)'$/.exec(term.trim()));
  if (terms.some((m) => m === null)) return false;
  return terms.some((m) => {
    const [, field, op, value] = m as RegExpExecArray;
    const actual = field === 'channel' ? env.channel : env.os;
    return op === '==' ? actual === value : actual !== value;
  });
}

interface ParsedVersion {
  major: number;
  minor: number;
  /** Release sorts above any pre-release of the same major.minor. */
  pre: number;
}

/** Parse `3.1`, `3.0a1`, `3.0b2`; null for anything else. */
export function parseModelVersion(version: string): ParsedVersion | null {
  const m = /^(\d+)\.(\d+)(?:([ab])(\d+))?$/.exec(version);
  if (!m) return null;
  const pre = m[3] === undefined ? Infinity : (m[3] === 'a' ? 0 : 1000) + Number(m[4]);
  return { major: Number(m[1]), minor: Number(m[2]), pre };
}

export function compareModelVersions(a: string, b: string): number {
  const pa = parseModelVersion(a);
  const pb = parseModelVersion(b);
  if (!pa || !pb) throw new Error(`unparseable model version: ${!pa ? a : b}`);
  return pa.major - pb.major || pa.minor - pb.minor || (pa.pre === pb.pre ? 0 : pa.pre < pb.pre ? -1 : 1);
}

/** A model's files are usable when the engine has everything it loads. */
function isComplete(files: PairPlan['files']): boolean {
  if (!files.model || !files.lex) return false;
  return Boolean(files.vocab) || Boolean(files.srcvocab && files.trgvocab);
}

/** Every usable model for one direction, newest first, preferred architecture first on a tie. */
export function candidatesForPair(
  sourceLanguage: string,
  targetLanguage: string,
  records: readonly ModelRecord[],
  options: ResolveOptions = {},
): PairPlan[] {
  const env = options.env ?? DEFAULT_CATALOGUE_ENV;
  const maxMajor = options.maxMajorVersion ?? SUPPORTED_MODEL_MAJOR_VERSION;
  const byModel = new Map<string, PairPlan>();
  for (const r of records) {
    if (r.sourceLanguage !== sourceLanguage || r.targetLanguage !== targetLanguage) continue;
    if (!KNOWN_FILE_TYPES.has(r.fileType)) continue;
    const v = parseModelVersion(r.version);
    if (!v || v.major > maxMajor) continue;
    if (!recordApplies(r, env)) continue;
    const key = `${r.architecture}\u0000${r.version}`;
    let plan = byModel.get(key);
    if (!plan) {
      plan = { sourceLanguage, targetLanguage, architecture: r.architecture, version: r.version, files: {} };
      byModel.set(key, plan);
    }
    const type = r.fileType as ModelFileType;
    const prev = plan.files[type];
    // Two live records for one file should not happen; keep the most recently published.
    if (!prev || (r.last_modified ?? 0) > (prev.last_modified ?? 0)) plan.files[type] = r;
  }
  const complete = [...byModel.values()].filter((p) => isComplete(p.files));
  const pref = options.architecture;
  return complete.sort((a, b) => {
    if (pref && (a.architecture === pref) !== (b.architecture === pref)) return a.architecture === pref ? -1 : 1;
    return compareModelVersions(b.version, a.version);
  });
}

/**
 * The models needed to translate `src` into `tgt`: the direct pair when it exists, otherwise
 * one pivot through English (`src→en`, `en→tgt`).
 */
export function resolvePlan(
  src: string,
  tgt: string,
  records: readonly ModelRecord[],
  options: ResolveOptions = {},
): TranslationPlan {
  if (src === tgt) return { ok: false, reason: 'same-language' };
  const direct = candidatesForPair(src, tgt, records, options)[0];
  if (direct) return { ok: true, steps: [direct] };
  if (src === PIVOT_LANGUAGE || tgt === PIVOT_LANGUAGE) {
    return { ok: false, reason: 'unsupported', missing: [{ sourceLanguage: src, targetLanguage: tgt }] };
  }
  const first = candidatesForPair(src, PIVOT_LANGUAGE, records, options)[0];
  const second = candidatesForPair(PIVOT_LANGUAGE, tgt, records, options)[0];
  if (first && second) return { ok: true, steps: [first, second] };
  const missing: Array<{ sourceLanguage: string; targetLanguage: string }> = [];
  if (!first) missing.push({ sourceLanguage: src, targetLanguage: PIVOT_LANGUAGE });
  if (!second) missing.push({ sourceLanguage: PIVOT_LANGUAGE, targetLanguage: tgt });
  return { ok: false, reason: 'unsupported', missing };
}

/** Language tags as the collection writes them: `en`, `zh-Hans`, `pt-BR`. */
const SAFE_LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Where one decompressed model file lives under the translations cache root:
 * `<root>/models/<src>-<tgt>/<architecture>/<version>/<fileType>`.
 *
 * Every segment comes from the network, so each is checked against a strict pattern and a
 * record that would escape the cache root throws instead.
 */
export function cachePath(root: string, record: Pick<ModelRecord, 'sourceLanguage' | 'targetLanguage' | 'architecture' | 'version' | 'fileType'>): string {
  const { sourceLanguage, targetLanguage, architecture, version, fileType } = record;
  const dir = pairCacheDir(root, sourceLanguage, targetLanguage);
  for (const seg of [architecture, version]) {
    if (!SAFE_SEGMENT.test(seg) || seg.includes('..')) throw new Error(`unsafe path segment in model record: ${seg}`);
  }
  if (!KNOWN_FILE_TYPES.has(fileType)) throw new Error(`unknown model file type: ${fileType}`);
  return path.join(dir, architecture, version, fileType);
}

/** The folder holding every model of one direction: `<root>/models/<src>-<tgt>`. */
export function pairCacheDir(root: string, sourceLanguage: string, targetLanguage: string): string {
  if (!SAFE_LANGUAGE.test(sourceLanguage) || !SAFE_LANGUAGE.test(targetLanguage)) {
    throw new Error(`unsafe language tag in model record: ${sourceLanguage}-${targetLanguage}`);
  }
  return path.join(root, 'models', `${sourceLanguage}-${targetLanguage}`);
}

/**
 * The direction a `<src>-<tgt>` folder name stands for, or null. Tags can hold hyphens
 * (`zh-Hans-en`), so the split is at the hyphen where the right side starts a new primary
 * language subtag (lower-case letters); script and region subtags never do in the collection.
 */
export function parsePairDirName(name: string): { sourceLanguage: string; targetLanguage: string } | null {
  const parts = name.split('-');
  for (let i = 1; i < parts.length; i++) {
    const sourceLanguage = parts.slice(0, i).join('-');
    const targetLanguage = parts.slice(i).join('-');
    if (/^[a-z]{2,3}$/.test(parts[i]) && SAFE_LANGUAGE.test(sourceLanguage) && SAFE_LANGUAGE.test(targetLanguage)) {
      return { sourceLanguage, targetLanguage };
    }
  }
  return null;
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Whether decompressed bytes match the record: size first (cheap), then SHA-256 of the
 * content against `decompressedHash`.
 */
export function verifyDecompressed(data: Uint8Array, record: Pick<ModelRecord, 'decompressedHash' | 'decompressedSize'>): boolean {
  if (data.byteLength !== record.decompressedSize) return false;
  return sha256Hex(data) === record.decompressedHash.toLowerCase();
}

/** Whether downloaded (still compressed) bytes match the record's attachment. */
export function verifyAttachment(data: Uint8Array, record: Pick<ModelRecord, 'attachment'>): boolean {
  if (data.byteLength !== record.attachment.size) return false;
  return sha256Hex(data) === record.attachment.hash.toLowerCase();
}
