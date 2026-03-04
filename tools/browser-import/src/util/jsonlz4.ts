/**
 * Mozilla jsonlz4 decompressor
 *
 * Firefox uses a custom compression format for session files (.jsonlz4):
 * - 8-byte magic header: "mozLz40\0"
 * - 4-byte little-endian uint32: uncompressed size
 * - Remaining bytes: raw LZ4 block-compressed data
 *
 * This is NOT standard LZ4 framing — it's a raw LZ4 block with a Mozilla-specific header.
 * Mozilla adopted LZ4 before the framing standard was finalized, so they use their own wrapper.
 */

import { readFileSync } from 'fs';
// @ts-ignore — lz4 doesn't have great type definitions
import * as lz4 from 'lz4';

const MOZLZ4_MAGIC = 'mozLz40\0';

/**
 * Decompress a .jsonlz4 file and parse the JSON contents.
 *
 * @param filePath Path to the .jsonlz4 file
 * @returns Parsed JSON object
 * @throws Error if the file is not a valid jsonlz4 file
 */
export function decompressJsonlz4(filePath: string): any {
  const buf = readFileSync(filePath);

  // Verify magic header
  if (buf.length < 12) {
    throw new Error(`File too small to be jsonlz4: ${buf.length} bytes`);
  }

  const magic = buf.subarray(0, 8).toString('ascii');
  if (magic !== MOZLZ4_MAGIC) {
    throw new Error(
      `Invalid jsonlz4 magic header: expected "mozLz40\\0", got "${magic}"`
    );
  }

  // Read uncompressed size (4-byte LE uint32)
  const uncompressedSize = buf.readUInt32LE(8);

  // Extract compressed data (everything after the 12-byte header)
  const compressed = buf.subarray(12);

  // Allocate output buffer with the known uncompressed size
  const output = Buffer.alloc(uncompressedSize);

  // Decompress the raw LZ4 block
  const decodedSize = lz4.decodeBlock(compressed, output);

  if (decodedSize < 0) {
    throw new Error(`LZ4 decompression failed at offset ${Math.abs(decodedSize)}`);
  }

  // Parse the decompressed data as UTF-8 JSON
  const jsonString = output.subarray(0, decodedSize).toString('utf-8');
  return JSON.parse(jsonString);
}
