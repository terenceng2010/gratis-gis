// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Minimal ZIP reader (#50 / #51). Pairs with `zip-writer.ts`:
 * reads stored + deflated entries, returns each entry as a
 * Uint8Array or string. Used by the vendored XLSX reader to
 * crack open `.xlsx` workbooks (which are ZIPs of XML parts).
 *
 * Not implemented (intentionally):
 *   - ZIP64 entries (covers 99% of XLSX files; SheetJS-emitted
 *     XLSX files are rarely above 4 GB per entry)
 *   - Encryption
 *   - Spanned / multi-disk archives
 *
 * The end-of-central-directory record can sit anywhere in the
 * last 64 KB of the archive (after the optional comment block).
 * We scan backwards from the end of the file looking for the
 * EOCD signature, then walk the central directory.
 */

export interface ZipEntry {
  name: string;
  /** Compressed bytes verbatim from the archive. */
  compressed: Uint8Array;
  /** Original (uncompressed) size, as recorded in the central
   *  directory. Used to size the output buffer when the entry
   *  is stored (method 0) so we don't have to re-measure. */
  uncompressedSize: number;
  /** ZIP method: 0 = store, 8 = deflate. Anything else throws. */
  method: number;
}

export class ZipReader {
  private constructor(
    private readonly bytes: Uint8Array,
    private readonly entries: Map<string, ZipEntry>,
  ) {}

  /** Parse a ZIP archive from a Blob / ArrayBuffer / Uint8Array. */
  static async open(
    source: Blob | ArrayBuffer | Uint8Array,
  ): Promise<ZipReader> {
    let bytes: Uint8Array;
    if (source instanceof Uint8Array) bytes = source;
    else if (source instanceof ArrayBuffer) bytes = new Uint8Array(source);
    else bytes = new Uint8Array(await source.arrayBuffer());

    // Find the End of Central Directory record. Scan backwards
    // from the end looking for the 0x06054b50 signature; the
    // comment block can extend up to 65,535 bytes after the
    // signature, so the search window is `len - 22 - 65535`.
    const sig = 0x06054b50;
    const len = bytes.length;
    let eocdAt = -1;
    const minStart = Math.max(0, len - 22 - 65535);
    for (let i = len - 22; i >= minStart; i -= 1) {
      if (
        bytes[i] === (sig & 0xff) &&
        bytes[i + 1] === ((sig >>> 8) & 0xff) &&
        bytes[i + 2] === ((sig >>> 16) & 0xff) &&
        bytes[i + 3] === ((sig >>> 24) & 0xff)
      ) {
        eocdAt = i;
        break;
      }
    }
    if (eocdAt < 0) {
      throw new Error('Not a ZIP archive (no end-of-central-directory record)');
    }
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    const cdSize = dv.getUint32(eocdAt + 12, true);
    const cdOffset = dv.getUint32(eocdAt + 16, true);

    // Walk the central directory.
    const entries = new Map<string, ZipEntry>();
    let cursor = cdOffset;
    const cdEnd = cdOffset + cdSize;
    while (cursor < cdEnd) {
      if (dv.getUint32(cursor, true) !== 0x02014b50) {
        throw new Error('Corrupt ZIP central directory');
      }
      const method = dv.getUint16(cursor + 10, true);
      const compressedSize = dv.getUint32(cursor + 20, true);
      const uncompressedSize = dv.getUint32(cursor + 24, true);
      const nameLen = dv.getUint16(cursor + 28, true);
      const extraLen = dv.getUint16(cursor + 30, true);
      const commentLen = dv.getUint16(cursor + 32, true);
      const localHeaderOffset = dv.getUint32(cursor + 42, true);
      const name = textDecoder.decode(
        bytes.subarray(cursor + 46, cursor + 46 + nameLen),
      );
      cursor += 46 + nameLen + extraLen + commentLen;

      // Resolve the actual compressed-data offset by reading the
      // local file header (its name + extra length can differ
      // from the central directory entry's).
      const lhSig = dv.getUint32(localHeaderOffset, true);
      if (lhSig !== 0x04034b50) {
        throw new Error(`Corrupt ZIP local header for ${name}`);
      }
      const lhNameLen = dv.getUint16(localHeaderOffset + 26, true);
      const lhExtraLen = dv.getUint16(localHeaderOffset + 28, true);
      const dataStart = localHeaderOffset + 30 + lhNameLen + lhExtraLen;
      const compressed = bytes.subarray(dataStart, dataStart + compressedSize);

      entries.set(name, {
        name,
        compressed,
        uncompressedSize,
        method,
      });
    }

    return new ZipReader(bytes, entries);
  }

  /** True when the archive carries the named entry. */
  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Iterate every entry in archive order. */
  list(): string[] {
    return Array.from(this.entries.keys());
  }

  /** Read one entry as a Uint8Array (auto-inflating method 8). */
  async readBytes(name: string): Promise<Uint8Array> {
    const e = this.entries.get(name);
    if (!e) throw new Error(`ZIP entry not found: ${name}`);
    if (e.method === 0) return e.compressed;
    if (e.method === 8) {
      if (typeof DecompressionStream === 'undefined') {
        throw new Error(
          'DecompressionStream API not available; cannot inflate deflated ZIP entries',
        );
      }
      const stream = new Response(
        new Blob([e.compressed as BlobPart]).stream().pipeThrough(
          new DecompressionStream('deflate-raw'),
        ),
      );
      return new Uint8Array(await stream.arrayBuffer());
    }
    throw new Error(`Unsupported ZIP compression method ${e.method} for ${name}`);
  }

  /** Read one entry as a UTF-8 string. */
  async readText(name: string): Promise<string> {
    return textDecoder.decode(await this.readBytes(name));
  }
}

const textDecoder = new TextDecoder('utf-8');
