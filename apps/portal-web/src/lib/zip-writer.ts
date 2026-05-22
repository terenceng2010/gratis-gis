// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Minimal ZIP writer (#50). Replaces the JSZip dependency with a
 * vendored, dependency-free implementation of the subset of the
 * ZIP file format we actually need:
 *
 *   - Store + Deflate compressed entries
 *   - UTF-8 filenames with slash separators (=> nested "folders"
 *     are just filenames with /; ZIP itself has no folder type
 *     beyond explicit dir entries which we don't bother emitting)
 *   - End of Central Directory record with no comment
 *
 * Not implemented (intentionally):
 *   - ZIP64 extensions (4 GB per-entry / per-archive cap is plenty
 *     for the bundle-export use case; the per-feature attachment
 *     cap is the real limit anyway)
 *   - Encryption
 *   - File timestamps (we always emit 1980-01-01 00:00:00; the
 *     archive's own download mtime is what actually shows up in
 *     Explorer)
 *   - Multi-disk / spanning archives
 *
 * DEFLATE comes from the browser's CompressionStream API
 * (Chrome 80+, Firefox 113+, Safari 16+). Falls back to stored
 * (uncompressed) entries when CompressionStream isn't available;
 * the archive still validates, it's just larger.
 */

interface Entry {
  /** Slash-separated path inside the archive. */
  name: string;
  /** Original (uncompressed) bytes. */
  data: Uint8Array;
  /** Bytes after DEFLATE, or the same buffer when stored. */
  compressed: Uint8Array;
  /** ZIP compression method: 0 = store, 8 = deflate. */
  method: 0 | 8;
  crc32: number;
}

export class ZipWriter {
  private readonly entries: Entry[] = [];

  /** Add a file to the archive. Accepts a Blob, ArrayBuffer, or
   *  string (utf8-encoded). */
  async file(
    name: string,
    data: Blob | ArrayBuffer | Uint8Array | string,
  ): Promise<void> {
    const bytes = await toBytes(data);
    const compressed = await deflateRaw(bytes);
    // If DEFLATE didn't actually save space (or the API was
    // unavailable), fall back to stored. The archive validates
    // either way and unzip clients handle both.
    const useDeflate =
      compressed !== null && compressed.length < bytes.length;
    this.entries.push({
      name,
      data: bytes,
      compressed: useDeflate ? compressed! : bytes,
      method: useDeflate ? 8 : 0,
      crc32: crc32(bytes),
    });
  }

  /** Build the finished ZIP archive as a Blob. */
  async blob(): Promise<Blob> {
    const parts: Uint8Array[] = [];
    const offsets: number[] = [];
    let cursor = 0;

    // Local file headers + file data.
    for (const e of this.entries) {
      offsets.push(cursor);
      const nameBytes = textEncoder.encode(e.name);
      const header = new Uint8Array(30 + nameBytes.length);
      const dv = new DataView(header.buffer);
      dv.setUint32(0, 0x04034b50, true); // Local file header signature
      dv.setUint16(4, 20, true); // Version needed (2.0)
      dv.setUint16(6, 0x0800, true); // Flags: bit 11 = UTF-8 name
      dv.setUint16(8, e.method, true);
      dv.setUint16(10, 0, true); // Mod time
      dv.setUint16(12, 0x21, true); // Mod date (1980-01-01)
      dv.setUint32(14, e.crc32 >>> 0, true);
      dv.setUint32(18, e.compressed.length, true);
      dv.setUint32(22, e.data.length, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true); // Extra length
      header.set(nameBytes, 30);
      parts.push(header);
      parts.push(e.compressed);
      cursor += header.length + e.compressed.length;
    }

    // Central directory.
    const cdStart = cursor;
    for (let i = 0; i < this.entries.length; i += 1) {
      const e = this.entries[i]!;
      const offset = offsets[i]!;
      const nameBytes = textEncoder.encode(e.name);
      const cdHeader = new Uint8Array(46 + nameBytes.length);
      const dv = new DataView(cdHeader.buffer);
      dv.setUint32(0, 0x02014b50, true); // Central dir signature
      dv.setUint16(4, 0x031e, true); // Version made by (unix, 3.0)
      dv.setUint16(6, 20, true); // Version needed (2.0)
      dv.setUint16(8, 0x0800, true); // Flags
      dv.setUint16(10, e.method, true);
      dv.setUint16(12, 0, true); // Mod time
      dv.setUint16(14, 0x21, true); // Mod date
      dv.setUint32(16, e.crc32 >>> 0, true);
      dv.setUint32(20, e.compressed.length, true);
      dv.setUint32(24, e.data.length, true);
      dv.setUint16(28, nameBytes.length, true);
      dv.setUint16(30, 0, true); // Extra length
      dv.setUint16(32, 0, true); // Comment length
      dv.setUint16(34, 0, true); // Disk number
      dv.setUint16(36, 0, true); // Internal attrs
      dv.setUint32(38, 0, true); // External attrs
      dv.setUint32(42, offset, true);
      cdHeader.set(nameBytes, 46);
      parts.push(cdHeader);
      cursor += cdHeader.length;
    }
    const cdSize = cursor - cdStart;

    // End of central directory record.
    const eocd = new Uint8Array(22);
    const eocdDv = new DataView(eocd.buffer);
    eocdDv.setUint32(0, 0x06054b50, true); // EOCD signature
    eocdDv.setUint16(4, 0, true); // Disk number
    eocdDv.setUint16(6, 0, true); // Disk with CD start
    eocdDv.setUint16(8, this.entries.length, true); // Entries on this disk
    eocdDv.setUint16(10, this.entries.length, true); // Total entries
    eocdDv.setUint32(12, cdSize, true);
    eocdDv.setUint32(16, cdStart, true);
    eocdDv.setUint16(20, 0, true); // Comment length
    parts.push(eocd);

    return new Blob(parts as BlobPart[], { type: 'application/zip' });
  }
}

// --------------------------------------------------------------------
// Internals
// --------------------------------------------------------------------

const textEncoder = new TextEncoder();

async function toBytes(
  data: Blob | ArrayBuffer | Uint8Array | string,
): Promise<Uint8Array> {
  if (typeof data === 'string') return textEncoder.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  // Blob.
  return new Uint8Array(await data.arrayBuffer());
}

/**
 * DEFLATE-compress a chunk via the browser's CompressionStream.
 * Returns null when the API isn't available so the caller can
 * fall back to stored entries.
 */
async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new Response(
      new Blob([bytes as BlobPart]).stream().pipeThrough(
        new CompressionStream('deflate-raw'),
      ),
    );
    return new Uint8Array(await stream.arrayBuffer());
  } catch {
    return null;
  }
}

// CRC-32 table cached on first use so we don't pay the
// build-the-table cost per archive.
let crcTable: Uint32Array | null = null;

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
}

function crc32(bytes: Uint8Array): number {
  if (!crcTable) crcTable = buildCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]!) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
