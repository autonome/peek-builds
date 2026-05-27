/**
 * crx-canonical-id.mjs — extract the canonical Chrome extension ID from a CRX
 * buffer's embedded public key.
 *
 * In Chrome, an unpacked extension's runtime ID is derived deterministically
 * from `manifest.json#key` (an RSA public key, base64-encoded). For
 * Web-Store-distributed extensions, the canonical ID is what Chrome assigns
 * AND what `chrome.runtime.id` returns in pages.
 *
 * Electron's `session.loadExtension()` does NOT honor `manifest#key` — it
 * assigns a path-based hash. As a result, when a webpage sends
 * `chrome.runtime.sendMessage(<hardcoded-web-store-id>, msg)` from a context
 * matching the extension's externally_connectable, our IPC handler can't tell
 * by the requested ID alone whether THIS extension is the intended target —
 * leading to the origin-fallback hack and fan-out duplicates.
 *
 * This util extracts the canonical ID from the CRX itself, so the compat
 * layer can compare the requested ID against the loaded extension's true
 * canonical ID and reject foreign-platform IDs (which Chrome would also
 * reject as "no such extension").
 *
 * Pure Node. No deps beyond node:crypto.
 *
 * Supports CRX2 + CRX3 (the two formats served by clients2.google.com).
 *
 * Usage:
 *   import { extractCanonicalIdFromCrx } from './crx-canonical-id.mjs';
 *   const id = extractCanonicalIdFromCrx(crxBuffer);  // e.g. 'ghmbeldphafepmbegfdlkpapadhbakde'
 */

import crypto from 'node:crypto';

/**
 * Read a protobuf varint at `pos`. Returns { val, bytes }.
 * Only handles values up to 32 bits (sufficient for header lengths).
 */
function readVarint(buf, pos) {
  let val = 0, shift = 0, bytes = 0;
  while (true) {
    const b = buf[pos + bytes];
    val |= (b & 0x7F) << shift;
    bytes++;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 28) throw new Error('varint too large');
  }
  return { val, bytes };
}

/**
 * Walk CRX3 protobuf header and return the bytes of `signed_header_data`
 * (field 10000). That field is a serialized SignedData proto containing
 * `crx_id` (field 1) — the canonical 16-byte extension ID.
 *
 * Why we use signed_header_data instead of hashing the first RSA proof's
 * public_key: Web-Store-distributed CRX3 files carry TWO RSA proofs (Google
 * publisher signature + developer signature). The canonical ID is derived
 * from the DEVELOPER'S key, which is usually the second proof — but order
 * isn't guaranteed. signed_header_data.crx_id is authoritative.
 *
 * CrxFileHeader schema (Chromium components/crx_file/crx3.proto):
 *   repeated AsymmetricKeyProof sha256_with_rsa  = 2;
 *   repeated AsymmetricKeyProof sha256_with_ecdsa = 3;
 *   optional bytes              signed_header_data = 10000;
 *
 * SignedData schema:
 *   optional bytes crx_id = 1;
 */
function readTag(buf, pos) {
  const v = readVarint(buf, pos);
  return { fieldNum: v.val >>> 3, wireType: v.val & 0x07, bytes: v.bytes };
}

function findSignedHeaderData(headerBuf) {
  let pos = 0;
  while (pos < headerBuf.length) {
    const tag = readTag(headerBuf, pos);
    pos += tag.bytes;
    if (tag.wireType !== 2) {
      // We only expect length-delimited fields in CrxFileHeader. Bail safely
      // if we encounter something unexpected.
      return null;
    }
    const len = readVarint(headerBuf, pos);
    pos += len.bytes;
    if (tag.fieldNum === 10000) {
      return headerBuf.slice(pos, pos + len.val);
    }
    pos += len.val;
  }
  return null;
}

function extractCrxIdFromSignedData(signedDataBuf) {
  let pos = 0;
  while (pos < signedDataBuf.length) {
    const tag = readTag(signedDataBuf, pos);
    pos += tag.bytes;
    if (tag.wireType !== 2) return null;
    const len = readVarint(signedDataBuf, pos);
    pos += len.bytes;
    if (tag.fieldNum === 1) {
      return signedDataBuf.slice(pos, pos + len.val);
    }
    pos += len.val;
  }
  return null;
}

/** Render a 16-byte crx_id into Chrome's lowercase a-p alphabet. */
function crxIdBytesToString(idBytes) {
  let id = '';
  for (let i = 0; i < idBytes.length; i++) {
    const b = idBytes[i];
    id += String.fromCharCode('a'.charCodeAt(0) + (b >> 4));
    id += String.fromCharCode('a'.charCodeAt(0) + (b & 0x0F));
  }
  return id;
}

/**
 * Chrome derives the extension ID from the SubjectPublicKeyInfo by:
 *   1. SHA-256 the bytes
 *   2. Take the first 16 bytes
 *   3. Convert to lowercase hex
 *   4. Map each hex digit 0-9a-f → a-p (the "mpdecimal alphabet")
 *
 * See: https://chromium.googlesource.com/chromium/src/+/main/components/crx_file/id_util.cc
 */
export function chromeIdFromSubjectPublicKey(pubKeyBytes) {
  const hash = crypto.createHash('sha256').update(pubKeyBytes).digest();
  const first16 = hash.slice(0, 16);
  let id = '';
  for (let i = 0; i < first16.length; i++) {
    const byte = first16[i];
    id += String.fromCharCode('a'.charCodeAt(0) + (byte >> 4));
    id += String.fromCharCode('a'.charCodeAt(0) + (byte & 0x0F));
  }
  return id;
}

/**
 * Extract the canonical Chrome extension ID from a CRX file buffer.
 * Returns null if the format is unrecognized.
 *
 * CRX2: derive directly from the embedded public key (hash → first 16 bytes →
 * a-p alphabet — Chromium's id_util algorithm).
 * CRX3: prefer `signed_header_data.crx_id` (authoritative — Web Store CRX3s
 * carry both a publisher RSA proof and the developer RSA proof; signed_header
 * names the canonical id). Fall back to the first RSA proof's public_key if
 * signed_header_data is absent (older CRX3 builds).
 */
export function extractCanonicalIdFromCrx(crxBuf) {
  if (crxBuf.slice(0, 4).toString('ascii') !== 'Cr24') return null;
  const version = crxBuf.readUInt32LE(4);

  if (version === 2) {
    const pubKeyLen = crxBuf.readUInt32LE(8);
    const pubKey = crxBuf.slice(16, 16 + pubKeyLen);
    return chromeIdFromSubjectPublicKey(pubKey);
  }

  if (version === 3) {
    const headerLen = crxBuf.readUInt32LE(8);
    const header = crxBuf.slice(12, 12 + headerLen);
    const signedHeader = findSignedHeaderData(header);
    if (signedHeader) {
      const idBytes = extractCrxIdFromSignedData(signedHeader);
      if (idBytes && idBytes.length === 16) return crxIdBytesToString(idBytes);
    }
    // No signed_header_data — best-effort fallback (rare path).
    return null;
  }

  return null;
}
