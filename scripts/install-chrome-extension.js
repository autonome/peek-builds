#!/usr/bin/env node
/**
 * install-chrome-extension.js — download + unpack a Chrome Web Store extension.
 *
 * Usage:
 *   node scripts/install-chrome-extension.js <extId> <destDir>
 *
 * Example:
 *   node scripts/install-chrome-extension.js \
 *     ghmbeldphafepmbegfdlkpapadhbakde \
 *     apps/desktop/chrome-extensions/proton-pass
 *
 * Fetches the CRX from clients2.google.com/service/update2/crx, strips the
 * CRX2/CRX3 header to reveal the inner ZIP, and unpacks to destDir via the
 * system `unzip` binary (macOS + most Linux distros bundle it).
 *
 * Idempotent: if destDir/manifest.json already exists AND --force is not
 * passed, the script no-ops. Otherwise destDir is wiped + repopulated.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { extractCanonicalIdFromCrx } from './crx-canonical-id.mjs';

const CRX_URL = (id) =>
  `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=120.0.0&acceptformat=crx2,crx3&x=id%3D${id}%26installsource%3Dondemand%26uc`;

function die(msg) {
  console.error(`[install-chrome-extension] ${msg}`);
  process.exit(1);
}

function readU32LE(buf, off) {
  return buf.readUInt32LE(off);
}

function stripCrxHeader(crxBuf) {
  // CRX magic: bytes 0..3 = "Cr24"
  if (crxBuf.slice(0, 4).toString('ascii') !== 'Cr24') {
    die('downloaded file is not a CRX (missing Cr24 magic)');
  }
  const version = readU32LE(crxBuf, 4);
  if (version === 2) {
    const pubKeyLen = readU32LE(crxBuf, 8);
    const sigLen = readU32LE(crxBuf, 12);
    const zipStart = 16 + pubKeyLen + sigLen;
    return crxBuf.slice(zipStart);
  }
  if (version === 3) {
    const headerLen = readU32LE(crxBuf, 8);
    const zipStart = 12 + headerLen;
    return crxBuf.slice(zipStart);
  }
  die(`unsupported CRX version: ${version}`);
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const positional = args.filter((a) => !a.startsWith('--'));
  if (positional.length !== 2) {
    die('usage: node scripts/install-chrome-extension.js <extId> <destDir> [--force]');
  }
  const [extId, destDirRaw] = positional;
  if (!/^[a-z]{32}$/.test(extId)) {
    die(`invalid extension id: ${extId} (expected 32 lowercase letters)`);
  }
  const destDir = path.resolve(destDirRaw);

  const manifestPath = path.join(destDir, 'manifest.json');
  if (!force && fs.existsSync(manifestPath)) {
    // Light freshness signal: also confirm popup.js exists (the file the
    // Feb 2026 git commit was missing). If both are present, assume the
    // install is complete and skip.
    const popupJsPath = path.join(destDir, 'popup.js');
    if (fs.existsSync(popupJsPath)) {
      console.log(`[install-chrome-extension] ${destDir} already complete, skipping (pass --force to refresh)`);
      return;
    }
  }

  console.log(`[install-chrome-extension] downloading ${extId} → ${destDir}`);
  const res = await fetch(CRX_URL(extId), { redirect: 'follow' });
  if (!res.ok) die(`fetch failed: HTTP ${res.status} ${res.statusText}`);
  const arrayBuf = await res.arrayBuffer();
  const crxBuf = Buffer.from(arrayBuf);
  console.log(`[install-chrome-extension] downloaded ${crxBuf.length} bytes`);

  const zipBuf = stripCrxHeader(crxBuf);
  console.log(`[install-chrome-extension] stripped header, ZIP payload ${zipBuf.length} bytes`);

  // Write the ZIP to a tmp path, unzip with system tool. unzip is on every
  // dev box this codebase runs on (macOS + Linux); failure means a broken env.
  const tmpZip = path.join('/tmp', `peek-ext-${extId}.zip`);
  fs.writeFileSync(tmpZip, zipBuf);

  // Clear destDir but preserve any Peek-managed files (peek-bridge.html,
  // peek-bridge.js, peek-permissions.js) — patch-chrome-extensions.js will
  // re-write those, but if a user runs this script outside the build, those
  // files would be lost. Safer: wipe everything, the patch step runs after.
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true, force: true });
  }
  fs.mkdirSync(destDir, { recursive: true });

  execSync(`unzip -o "${tmpZip}" -d "${destDir}"`, { stdio: 'inherit' });
  fs.unlinkSync(tmpZip);

  if (!fs.existsSync(manifestPath)) {
    die(`unzip succeeded but ${manifestPath} is missing — bad CRX?`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log(`[install-chrome-extension] installed ${manifest.name} v${manifest.version}`);

  // Derive the canonical Chrome extension ID from the CRX itself and stash
  // it in a peek-managed sibling file (NOT inside the extension dir — keeps
  // upstream source untouched). Compat layer reads this at extension load
  // time to route cross-origin sendMessage fan-out requests faithfully:
  // pages like account.proton.me hardcode 4 platform-specific extension IDs
  // and race them; Chrome rejects all but the installed one as "no such
  // extension". Without the canonical ID we don't know which is "ours".
  try {
    const canonicalId = extractCanonicalIdFromCrx(crxBuf);
    if (canonicalId) {
      const metaDir = path.dirname(destDir);
      const metaPath = path.join(metaDir, '.peek-canonical-ids.json');
      const dirName = path.basename(destDir);
      let metaMap = {};
      if (fs.existsSync(metaPath)) {
        try { metaMap = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { metaMap = {}; }
      }
      metaMap[dirName] = canonicalId;
      fs.writeFileSync(metaPath, JSON.stringify(metaMap, null, 2) + '\n');
      console.log(`[install-chrome-extension] canonical id ${canonicalId} recorded in ${path.relative(process.cwd(), metaPath)}`);
    } else {
      console.warn('[install-chrome-extension] could not derive canonical id from CRX (format unrecognized)');
    }
  } catch (err) {
    console.warn('[install-chrome-extension] canonical id extraction failed:', err && err.message);
  }
}

main().catch((err) => die(err.stack || err.message || String(err)));
