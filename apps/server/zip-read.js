const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// Minimal ZIP reader for archives written by createBackup() (backup.js), which
// uses `archiver` in store/deflate mode with no zip64 extension — that is the
// only shape this ever needs to read. Lifted out of test-backup.js so restore.js
// (shipped code, not a test) can read the same archives an operator would unzip
// by hand (see docs/server-backup-and-deploy.md).

// Every entry this reader is ever asked to extract lives at one of two paths:
// the manifest, or something under a profile's own directory. Anything else —
// an absolute path, a `..` segment, a Windows drive prefix, backslash
// separators — is a traversal attempt or a malformed archive, not a profile's
// data, and gets rejected before a single byte is written.
const ALLOWED_ENTRY_PATTERN = /^profiles\/[^/\\]+\/.+$/;

// A zip with 65535 entries or a 4 GB+ member switches to the zip64 extension,
// marking the field that overflowed with all-ones rather than the real value
// and moving it into an extra field this reader never parses. Detected here
// so a mis-sized read fails with a clear cause instead of a RangeError from
// treating the sentinel as a real offset or length.
const ZIP64_ENTRY_COUNT_SENTINEL = 0xffff;
const ZIP64_SIZE_SENTINEL = 0xffffffff;

function validateEntryName(name) {
  if (path.isAbsolute(name) || name.startsWith("/")) {
    throw new Error(`Zip entry has an absolute path, refusing to extract: ${name}`);
  }
  if (/^[a-zA-Z]:/.test(name)) {
    throw new Error(`Zip entry has a Windows drive prefix, refusing to extract: ${name}`);
  }
  if (name.includes("\\")) {
    throw new Error(`Zip entry uses backslash path separators, refusing to extract: ${name}`);
  }
  if (name.split("/").includes("..")) {
    throw new Error(`Zip entry contains a '..' path segment, refusing to extract: ${name}`);
  }
  // A '.' segment passes every other check yet still changes what path the
  // entry resolves to: restore.js's SNAPSHOT_PATTERN would read
  // "profiles/./datastore.sqlite" as profileId ".", and db.getProfileDir()
  // normalizes that segment away, landing the file at the profiles directory
  // itself rather than inside any profile.
  if (name.split("/").includes(".")) {
    throw new Error(`Zip entry contains a '.' path segment, refusing to extract: ${name}`);
  }
  if (name !== "manifest.json" && !ALLOWED_ENTRY_PATTERN.test(name)) {
    throw new Error(`Zip entry does not match manifest.json or profiles/<id>/..., refusing to extract: ${name}`);
  }
}

function readZipEntries(zipPath) {
  const buf = fs.readFileSync(zipPath);
  const EOCD_SIG = 0x06054b50;
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error(`Not a valid zip (no end-of-central-directory record): ${zipPath}`);
  }

  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  if (entryCount === ZIP64_ENTRY_COUNT_SENTINEL || cdOffset === ZIP64_SIZE_SENTINEL) {
    throw new Error(`Archive uses zip64 (over 65535 entries or 4 GB), which this reader does not support: ${zipPath}`);
  }

  const entries = [];
  let offset = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Bad central directory entry at offset ${offset} in ${zipPath}`);
    }
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLen);
    if (compSize === ZIP64_SIZE_SENTINEL || localHeaderOffset === ZIP64_SIZE_SENTINEL) {
      throw new Error(`Zip entry uses zip64 (over 4 GB), which this reader does not support: ${name}`);
    }
    // Directory entries (name ends with "/") carry no data and are never
    // extracted (see unzipToDir below) — validated anyway so a crafted
    // directory entry can't be used to probe the check.
    validateEntryName(name);
    entries.push({ name, method, compSize, localHeaderOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return { buf, entries };
}

function extractZipEntry(buf, entry) {
  const LOCAL_SIG = 0x04034b50;
  const off = entry.localHeaderOffset;
  if (buf.readUInt32LE(off) !== LOCAL_SIG) {
    throw new Error(`Bad local file header for ${entry.name}`);
  }
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  const compData = buf.subarray(dataStart, dataStart + entry.compSize);

  if (entry.method === 0) return Buffer.from(compData);
  if (entry.method === 8) return zlib.inflateRawSync(compData);
  throw new Error(`Unsupported zip compression method ${entry.method} for ${entry.name}`);
}

// Unzips an archiver-produced zip onto disk, mirroring what an operator doing
// a real restore would do (see docs/server-backup-and-deploy.md's by-hand
// procedure).
function unzipToDir(zipPath, destDir) {
  const { buf, entries } = readZipEntries(zipPath);
  for (const entry of entries) {
    if (entry.name.endsWith("/")) continue; // directory entry, nothing to write
    const outPath = path.join(destDir, entry.name);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, extractZipEntry(buf, entry));
  }
}

module.exports = {
  readZipEntries,
  extractZipEntry,
  unzipToDir,
};
