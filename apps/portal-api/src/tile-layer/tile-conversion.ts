// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import type { TileLayerOriginalFormat } from '@gratis-gis/shared-types';

/**
 * Tile container conversion pipeline (#179).
 *
 * Detects the upload's container format from the file extension
 * and produces a PMTiles file for storage. Three inputs in v1:
 *
 *   - .pmtiles : no conversion; pass-through.
 *   - .mbtiles : `pmtiles convert in.mbtiles out.pmtiles`. The
 *     pmtiles Go CLI bundled into the api image handles the
 *     SQLite read + PMTiles directory build.
 *   - .zip (XYZ tile directory): unzip into a temp dir, then
 *     `pmtiles convert <tile-dir> out.pmtiles`. The CLI walks
 *     {z}/{x}/{y}.{ext} structure and builds a PMTiles archive.
 *
 * TPK / TPKX are out of v1 ingest because Esri's bundle format
 * needs its own extraction pipeline (bundles pack multiple tiles
 * into one file with a custom index). Documented as a follow-up.
 *
 * Conversion runs in a temp dir under the system tmp; cleaned up
 * unconditionally so a failed conversion doesn't leak gigabytes
 * of intermediate files.
 */

/** Result of a successful conversion. */
export interface ConversionResult {
  /** Local path to the .pmtiles file ready to upload to MinIO. */
  outputPath: string;
  /** Original format the user uploaded. */
  originalFormat: TileLayerOriginalFormat;
  /** Bytes of the resulting .pmtiles file. */
  outputBytes: number;
  /** Milliseconds elapsed for the conversion step. */
  durationMs: number;
  /** Temp directory the caller must clean up (rm -rf). */
  workDir: string;
}

/**
 * Detect the original format from the filename. Reject any
 * unsupported extension early so the conversion doesn't fail
 * with a less helpful error from the CLI.
 */
export function detectOriginalFormat(
  fileName: string,
): TileLayerOriginalFormat {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.pmtiles')) return 'pmtiles';
  if (lower.endsWith('.mbtiles')) return 'mbtiles';
  if (lower.endsWith('.zip')) return 'xyz-zip';
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.')) : '';
  const supported = '.pmtiles, .mbtiles, .zip (XYZ tile directory)';
  if (lower.endsWith('.tpk') || lower.endsWith('.tpkx')) {
    throw new Error(
      `TPK / TPKX ingestion is not supported yet. Convert with ArcGIS Pro's "Export Tile Cache" tool or a third-party converter, then upload the resulting .mbtiles or .pmtiles. Supported: ${supported}.`,
    );
  }
  throw new Error(
    `Unsupported tile container "${ext || lower}". Supported: ${supported}.`,
  );
}

/**
 * Run the conversion pipeline. Caller passes the source URL
 * (public MinIO URL of the just-uploaded file) + the original
 * filename. Returns the local path to the resulting .pmtiles
 * file plus a workDir the caller MUST `rm -rf` once it's done
 * uploading the result.
 *
 * For `.pmtiles` inputs the function returns immediately without
 * touching the file -- the caller's upload-to-MinIO step has
 * already put the bytes where they belong. The workDir in that
 * case is a no-op empty directory so the caller's cleanup
 * branch can call rm uniformly.
 */
export async function convertToPmtiles(
  sourceUrl: string,
  fileName: string,
): Promise<ConversionResult> {
  const originalFormat = detectOriginalFormat(fileName);
  const workDir = await mkdtemp(join(tmpdir(), 'tile-conv-'));

  // Pass-through path. We don't download the file -- the bytes
  // are already in MinIO at sourceUrl, and finalize() will read
  // the header from there with range requests. Returning a
  // dummy output path that doesn't exist would confuse the
  // caller; signal pass-through by returning `outputPath === ''`
  // and the caller decides what to do.
  if (originalFormat === 'pmtiles') {
    return {
      outputPath: '',
      originalFormat,
      outputBytes: 0,
      durationMs: 0,
      workDir,
    };
  }

  const start = Date.now();

  // Download the upload to a local file. pmtiles CLI needs a
  // local input path; it doesn't read HTTP URLs.
  const inputPath = join(workDir, sanitizeFileName(fileName));
  await downloadTo(sourceUrl, inputPath);

  let outputPath = join(workDir, 'out.pmtiles');
  if (originalFormat === 'xyz-zip') {
    // Unzip into a tile-dir subdirectory first. The pmtiles CLI
    // walks the tree expecting {z}/{x}/{y}.{ext} layout (or
    // {z}/{x}/{y}.pbf for vector). Some zips wrap the tree in
    // an extra root directory; pmtiles handles either shape
    // because it scans for the {z} integer pattern.
    const tileDir = join(workDir, 'tiles');
    await mkdir(tileDir, { recursive: true });
    await runCommand('unzip', ['-q', inputPath, '-d', tileDir]);
    // The pmtiles convert CLI for directory input requires a
    // metadata.json at the tile-dir root; if the zip doesn't
    // include one we synthesize a minimal placeholder. The
    // header bbox / center will come from the tile pyramid
    // bounds at runtime.
    const metaPath = join(tileDir, 'metadata.json');
    try {
      await stat(metaPath);
    } catch {
      await writeFile(
        metaPath,
        JSON.stringify({
          name: fileName.replace(/\.zip$/i, ''),
          format: 'png',
          minzoom: 0,
          maxzoom: 22,
        }),
      );
    }
    await runCommand('pmtiles', ['convert', tileDir, outputPath]);
  } else if (originalFormat === 'mbtiles') {
    await runCommand('pmtiles', ['convert', inputPath, outputPath]);
  } else {
    // Defensive: detectOriginalFormat already rejected
    // everything else, but make the never-happens branch
    // explicit so a future format addition doesn't silently
    // produce an empty out.pmtiles.
    throw new Error(`No converter for format ${originalFormat}`);
  }

  const outputStat = await stat(outputPath);
  return {
    outputPath,
    originalFormat,
    outputBytes: outputStat.size,
    durationMs: Date.now() - start,
    workDir,
  };
}

/**
 * Always-run cleanup after the caller uploads the converted
 * PMTiles back to MinIO. Failed conversions also call this so
 * temp space is reclaimed regardless of outcome.
 */
export async function cleanupConversion(workDir: string): Promise<void> {
  if (!workDir) return;
  try {
    await rm(workDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

/**
 * Strip path separators + control characters from the upload
 * filename so we can use it as a temp-file name without worrying
 * about directory traversal in the workDir. The pmtiles CLI is
 * fine with arbitrary names, this is purely for sanity.
 */
function sanitizeFileName(name: string): string {
  return (
    name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200) || 'upload.bin'
  );
}

/**
 * Stream a remote URL to a local file. node:fetch's Response.body
 * is a web ReadableStream; pipe it through Readable.fromWeb to
 * land bytes on disk without holding the file in memory.
 */
async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed (HTTP ${res.status}) from ${url}`);
  }
  if (!res.body) {
    throw new Error(`Download returned no body from ${url}`);
  }
  await pipeline(
    Readable.fromWeb(res.body as unknown as import('stream/web').ReadableStream),
    createWriteStream(dest),
  );
}

/**
 * Spawn an external command and resolve when it exits 0. stderr
 * is buffered and surfaced on non-zero exits so the error
 * message in the API response reflects what the tool actually
 * said. stdout is discarded (the CLIs we run produce progress on
 * stderr and silence on stdout, or write to disk directly).
 */
function runCommand(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      // Cap the buffer so a chatty tool doesn't pin memory.
      if (stderr.length > 32 * 1024) {
        stderr = '...' + stderr.slice(-16 * 1024);
      }
    });
    child.on('error', (err) => {
      reject(new Error(`Failed to run ${cmd}: ${err.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${cmd} exited with code ${code}${stderr ? `\n${stderr.trim()}` : ''}`,
          ),
        );
      }
    });
  });
}
