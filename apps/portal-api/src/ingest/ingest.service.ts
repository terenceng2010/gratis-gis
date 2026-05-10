// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Opens an uploaded vector file with GDAL and returns a GeoJSON
 * FeatureCollection plus a simple field list.
 *
 * Why GDAL lives on the server and not the browser: File Geodatabase
 * (.gdb) has no robust in-browser parser; OGR reads a dozen more
 * formats for free (GPX, GML, MapInfo TAB, etc.); and the dataset
 * sizes that justify an "ingest this file" workflow (tens of MB,
 * hundreds of thousands of features) belong on the backend anyway.
 *
 * `gdal-async` ships prebuilt Node bindings, so there's no system
 * install step in dev. If the prebuild is missing for the current
 * platform, the import fails and callers get a friendly error.
 */
@Injectable()
export class IngestService {
  private readonly log = new Logger(IngestService.name);

  /** Reasonable upload ceiling. Matches the multer config in the
   *  controller. 1 GB covers a full county-scale parcel layer
   *  (200-500 MB zipped is typical) without forcing the user to
   *  subset first. Anything bigger should go through a future
   *  direct-to-MinIO presigned-PUT path; right now everything
   *  buffers through portal-api which is RAM-bound on the host. */
  readonly maxBytes = 1024 * 1024 * 1024; // 1 GB

  async fileToGeoJson(
    buffer: Buffer,
    originalName: string,
  ): Promise<{
    geojson: { type: 'FeatureCollection'; features: unknown[] };
    fields: Array<{ name: string; type: 'string' | 'number' | 'boolean' | 'date' }>;
    driver: string;
    /** Canonical auth-name:code string for the source SRS we
     *  reprojected from (e.g. "EPSG:26911"), or null when the source
     *  file had no SRS declared (rare; we assume 4326 in that case). */
    sourceSrs: string | null;
  }> {
    if (!buffer.length) {
      throw new BadRequestException('Uploaded file is empty.');
    }
    if (buffer.length > this.maxBytes) {
      throw new BadRequestException(
        `File is too large. Current cap is ${this.maxBytes / 1024 / 1024} MB.`,
      );
    }

    const gdal = await this.loadGdal();

    // Write to a temp dir so GDAL can open it by path. Directory-based
    // formats (`.gdb`) are delivered as zips, which GDAL handles via
    // its `/vsizip/` virtual filesystem when we point at the zip.
    const dirPath = join(tmpdir(), `gg-ingest-${randomUUID()}`);
    await mkdir(dirPath, { recursive: true });
    const filePath = join(dirPath, safeFilename(originalName));
    await writeFile(filePath, buffer);
    const openPath = filePath.toLowerCase().endsWith('.zip')
      ? `/vsizip/${filePath}`
      : filePath;

    try {
      const ds = gdal.open(openPath);
      try {
        const layers = ds.layers;
        const layerCount = layers.count();
        if (layerCount === 0) {
          throw new BadRequestException(
            'GDAL opened the file but found no vector layers inside.',
          );
        }
        // Flatten every layer into one FeatureCollection for v1. A
        // future pass can let the user pick which layer they want.
        const combined: unknown[] = [];
        const fieldMap = new Map<
          string,
          { name: string; type: 'string' | 'number' | 'boolean' | 'date' }
        >();
        const drivers = new Set<string>();
        // Capture the first layer's SRS as the "source" SRS. In
        // practice all layers in a single file share an SRS (it's a
        // container-level property for shapefile zips and GDBs),
        // but we note the first so the provenance block has
        // something stable to record.
        let sourceSrs: string | null = null;
        const target4326 = gdal.SpatialReference.fromEPSG(4326);

        for (let i = 0; i < layerCount; i += 1) {
          const layer = layers.get(i);
          drivers.add(layer.ds.driver.description);
          if (sourceSrs === null) sourceSrs = srsAuthCode(layer.srs);
          // Build a per-layer transform from the layer's SRS to 4326.
          // If the layer has no SRS declared we can't transform: we
          // assume the coordinates are already 4326 (the OGC
          // convention for GeoJSON) and skip the transform.
          const xform = buildTransform(gdal, layer.srs, target4326);
          // Capture field definitions once per distinct name.
          const defs = layer.fields;
          const defCount = defs.count();
          for (let f = 0; f < defCount; f += 1) {
            const def = defs.get(f);
            if (!fieldMap.has(def.name)) {
              fieldMap.set(def.name, {
                name: def.name,
                type: gdalTypeToSimple(def.type),
              });
            }
          }
          // Iterate features. `layer.features.forEach` would be nicer
          // but gdal-async's iterator helpers don't always cover every
          // driver; the explicit loop is bulletproof.
          layer.features.forEach((feature) => {
            const geomJson = featureGeomJson(feature, xform);
            if (!geomJson) return;
            const props: Record<string, unknown> = feature.fields.toObject();
            combined.push({
              type: 'Feature',
              geometry: geomJson,
              properties: props,
            });
          });
        }

        return {
          geojson: { type: 'FeatureCollection', features: combined },
          fields: [...fieldMap.values()],
          driver: [...drivers].join(', '),
          sourceSrs,
        };
      } finally {
        ds.close();
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`GDAL could not read that file: ${msg}`);
    } finally {
      // Clean up the scratch dir even if GDAL threw, so we don't
      // accumulate temp files under sustained failure.
      await rm(dirPath, { recursive: true, force: true }).catch(() => {
        this.log.warn(`Failed to remove temp dir ${dirPath}`);
      });
    }
  }

  /**
   * Probe an uploaded file and return per-layer metadata (name,
   * geometry type, fields, feature count) without reading geometry.
   * Lets the builder preview what's in a shapefile zip / KML / GDB
   * before the user commits to adding specific layers.
   *
   * A GDB archive typically has many layers; shapefile zips can too
   * (one per .shp inside the zip). KML/KMZ often has a single layer
   * but sometimes multiple. GeoJSON is always one layer.
   */
  async probeFile(
    buffer: Buffer,
    originalName: string,
  ): Promise<{
    driver: string;
    layers: Array<{
      name: string;
      geometryType: 'point' | 'line' | 'polygon' | null;
      fields: Array<{
        name: string;
        type: 'string' | 'number' | 'boolean' | 'date';
      }>;
      featureCount: number;
    }>;
  }> {
    if (!buffer.length) {
      throw new BadRequestException('Uploaded file is empty.');
    }
    if (buffer.length > this.maxBytes) {
      throw new BadRequestException(
        `File is too large. Current cap is ${this.maxBytes / 1024 / 1024} MB.`,
      );
    }
    const dirPath = join(tmpdir(), `gg-probe-${randomUUID()}`);
    await mkdir(dirPath, { recursive: true });
    const filePath = join(dirPath, safeFilename(originalName));
    await writeFile(filePath, buffer);
    try {
      return await this.probeFileFromPath(filePath);
    } finally {
      await rm(dirPath, { recursive: true, force: true }).catch(() => {
        this.log.warn(`Failed to remove temp dir ${dirPath}`);
      });
    }
  }

  /**
   * Path variant of probeFile. Used by the staged-upload path: the
   * file already lives on disk under /tmp/gg-staging/<id>/, so we
   * skip the buffer-write step entirely. The cleanup of the staging
   * dir is the staging service's problem, not this method's.
   */
  async probeFileFromPath(filePath: string): Promise<{
    driver: string;
    layers: Array<{
      name: string;
      geometryType: 'point' | 'line' | 'polygon' | null;
      fields: Array<{
        name: string;
        type: 'string' | 'number' | 'boolean' | 'date';
      }>;
      featureCount: number;
    }>;
  }> {
    const gdal = await this.loadGdal();
    const openPath = filePath.toLowerCase().endsWith('.zip')
      ? `/vsizip/${filePath}`
      : filePath;
    try {
      const ds = gdal.open(openPath);
      try {
        const layerCount = ds.layers.count();
        if (layerCount === 0) {
          throw new BadRequestException(
            'GDAL opened the file but found no vector layers inside.',
          );
        }
        const driver = ds.driver.description;
        const out: Array<{
          name: string;
          geometryType: 'point' | 'line' | 'polygon' | null;
          fields: Array<{
            name: string;
            type: 'string' | 'number' | 'boolean' | 'date';
          }>;
          featureCount: number;
        }> = [];
        for (let i = 0; i < layerCount; i += 1) {
          const layer = ds.layers.get(i);
          const fields: Array<{
            name: string;
            type: 'string' | 'number' | 'boolean' | 'date';
          }> = [];
          const defCount = layer.fields.count();
          for (let f = 0; f < defCount; f += 1) {
            const def = layer.fields.get(f);
            fields.push({ name: def.name, type: gdalTypeToSimple(def.type) });
          }
          out.push({
            name: layer.name,
            geometryType: gdalGeomToSimple(layer.geomType),
            fields,
            featureCount: layer.features.count(),
          });
        }
        return { driver, layers: out };
      } finally {
        ds.close();
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`GDAL could not read that file: ${msg}`);
    }
  }

  /**
   * Extract features from a single named layer inside an uploaded
   * archive. If `sourceLayer` is omitted and the file has exactly one
   * layer, that single layer is used. Used by the v3 per-layer import
   * endpoint so authors can target, say, one table inside a GDB.
   */
  async fileLayerToGeoJson(
    buffer: Buffer,
    originalName: string,
    sourceLayer: string | undefined,
  ): Promise<{
    geojson: { type: 'FeatureCollection'; features: unknown[] };
    fields: Array<{ name: string; type: 'string' | 'number' | 'boolean' | 'date' }>;
    driver: string;
    layerName: string;
    /** Canonical auth-name:code string for the source SRS, if the
     *  layer declared one. See fileToGeoJson for rationale. */
    sourceSrs: string | null;
  }> {
    if (!buffer.length) {
      throw new BadRequestException('Uploaded file is empty.');
    }
    if (buffer.length > this.maxBytes) {
      throw new BadRequestException(
        `File is too large. Current cap is ${this.maxBytes / 1024 / 1024} MB.`,
      );
    }
    const dirPath = join(tmpdir(), `gg-ingest-${randomUUID()}`);
    await mkdir(dirPath, { recursive: true });
    const filePath = join(dirPath, safeFilename(originalName));
    await writeFile(filePath, buffer);
    try {
      return await this.fileLayerToGeoJsonFromPath(filePath, sourceLayer);
    } finally {
      await rm(dirPath, { recursive: true, force: true }).catch(() => {
        this.log.warn(`Failed to remove temp dir ${dirPath}`);
      });
    }
  }

  /**
   * Path variant of fileLayerToGeoJson. Used by the staged-upload
   * path: the file is already on disk under the staging dir, so we
   * skip the buffer-write step. Cleanup of the staging dir is the
   * staging service's problem; callers must NOT delete `filePath` --
   * a single staging is consumed by N per-layer ingests.
   */
  async fileLayerToGeoJsonFromPath(
    filePath: string,
    sourceLayer: string | undefined,
  ): Promise<{
    geojson: { type: 'FeatureCollection'; features: unknown[] };
    fields: Array<{ name: string; type: 'string' | 'number' | 'boolean' | 'date' }>;
    driver: string;
    layerName: string;
    sourceSrs: string | null;
  }> {
    const gdal = await this.loadGdal();
    const openPath = filePath.toLowerCase().endsWith('.zip')
      ? `/vsizip/${filePath}`
      : filePath;
    try {
      const ds = gdal.open(openPath);
      try {
        const layers = ds.layers;
        const count = layers.count();
        if (count === 0) {
          throw new BadRequestException(
            'GDAL opened the file but found no vector layers inside.',
          );
        }
        // Resolve which layer to read.
        let targetIdx = -1;
        if (sourceLayer) {
          for (let i = 0; i < count; i += 1) {
            if (layers.get(i).name === sourceLayer) {
              targetIdx = i;
              break;
            }
          }
          if (targetIdx === -1) {
            throw new BadRequestException(
              `File has no layer named "${sourceLayer}".`,
            );
          }
        } else if (count === 1) {
          targetIdx = 0;
        } else {
          throw new BadRequestException(
            `File has ${count} layers. Specify which one via the "sourceLayer" query parameter.`,
          );
        }

        const layer = layers.get(targetIdx);
        const fields: Array<{
          name: string;
          type: 'string' | 'number' | 'boolean' | 'date';
        }> = [];
        const defCount = layer.fields.count();
        for (let f = 0; f < defCount; f += 1) {
          const def = layer.fields.get(f);
          fields.push({ name: def.name, type: gdalTypeToSimple(def.type) });
        }
        const target4326 = gdal.SpatialReference.fromEPSG(4326);
        const xform = buildTransform(gdal, layer.srs, target4326);
        const features: unknown[] = [];
        layer.features.forEach((feature) => {
          const geomJson = featureGeomJson(feature, xform);
          if (!geomJson) return;
          const props: Record<string, unknown> = feature.fields.toObject();
          features.push({
            type: 'Feature',
            geometry: geomJson,
            properties: props,
          });
        });
        return {
          geojson: { type: 'FeatureCollection', features },
          fields,
          driver: ds.driver.description,
          layerName: layer.name,
          sourceSrs: srsAuthCode(layer.srs),
        };
      } finally {
        ds.close();
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`GDAL could not read that file: ${msg}`);
    }
  }

  /**
   * Write a multipart upload buffer to a fresh temp dir and return
   * the on-disk path plus a cleanup hook. Used by callers that have
   * a Buffer in hand but want to feed the streaming GDAL reader,
   * which only accepts a path. The cleanup hook should be invoked
   * in a finally block by the caller; failures are swallowed so a
   * crashed cleanup doesn't mask the real error.
   */
  async materializeBufferToTemp(
    buffer: Buffer,
    originalName: string,
  ): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
    if (!buffer.length) {
      throw new BadRequestException('Uploaded file is empty.');
    }
    if (buffer.length > this.maxBytes) {
      throw new BadRequestException(
        `File is too large. Current cap is ${this.maxBytes / 1024 / 1024} MB.`,
      );
    }
    const dirPath = join(tmpdir(), `gg-ingest-${randomUUID()}`);
    await mkdir(dirPath, { recursive: true });
    const filePath = join(dirPath, safeFilename(originalName));
    await writeFile(filePath, buffer);
    const cleanup = async () => {
      await rm(dirPath, { recursive: true, force: true }).catch(() => {
        this.log.warn(`Failed to remove temp dir ${dirPath}`);
      });
    };
    return { filePath, cleanup };
  }

  /**
   * Streaming variant of fileLayerToGeoJsonFromPath. Walks features
   * in order, invoking `onBatch` every `batchSize` features so the
   * caller can insert rows incrementally instead of buffering the
   * whole layer in JS memory.
   *
   * Why this exists: a county-scale parcel layer (1.4M polygons +
   * 19 attribute fields) blew through Node's 1.5 GB heap when the
   * non-streaming variant tried to materialise the full
   * FeatureCollection. With streaming, peak memory is bounded by
   * batchSize regardless of source dataset size.
   *
   * The callback may return a Promise; we await it before resuming
   * iteration so DB back-pressure naturally throttles GDAL. GDAL's
   * own forEach is synchronous, so we use index-based access
   * (layer.features.get(i)) instead and yield control between
   * batches via `await onBatch(...)`. Features whose geometry
   * decode returns null (rare; corrupt rows in legacy shapefiles)
   * are skipped silently and counted in `processed` so the total
   * matches what GDAL reported up front.
   *
   * Returns metadata about the source after the stream finishes.
   */
  async streamLayerFromPath(
    filePath: string,
    sourceLayer: string | undefined,
    onBatch: (
      batch: Array<{ geometry: unknown; properties: Record<string, unknown> }>,
      progress: { processed: number; total: number },
    ) => Promise<void>,
    opts: { batchSize?: number } = {},
  ): Promise<{
    fields: Array<{ name: string; type: 'string' | 'number' | 'boolean' | 'date' }>;
    driver: string;
    layerName: string;
    sourceSrs: string | null;
    total: number;
  }> {
    const batchSize = opts.batchSize ?? 5000;
    const gdal = await this.loadGdal();
    const openPath = filePath.toLowerCase().endsWith('.zip')
      ? `/vsizip/${filePath}`
      : filePath;
    const ds = gdal.open(openPath);
    try {
      const layers = ds.layers;
      const count = layers.count();
      if (count === 0) {
        throw new BadRequestException(
          'GDAL opened the file but found no vector layers inside.',
        );
      }
      let targetIdx = -1;
      if (sourceLayer) {
        for (let i = 0; i < count; i += 1) {
          if (layers.get(i).name === sourceLayer) {
            targetIdx = i;
            break;
          }
        }
        if (targetIdx === -1) {
          throw new BadRequestException(
            `File has no layer named "${sourceLayer}".`,
          );
        }
      } else if (count === 1) {
        targetIdx = 0;
      } else {
        throw new BadRequestException(
          `File has ${count} layers. Specify which one via the "sourceLayer" query parameter.`,
        );
      }

      const layer = layers.get(targetIdx);
      const fields: Array<{
        name: string;
        type: 'string' | 'number' | 'boolean' | 'date';
      }> = [];
      const defCount = layer.fields.count();
      for (let f = 0; f < defCount; f += 1) {
        const def = layer.fields.get(f);
        fields.push({ name: def.name, type: gdalTypeToSimple(def.type) });
      }
      const target4326 = gdal.SpatialReference.fromEPSG(4326);
      const xform = buildTransform(gdal, layer.srs, target4326);
      const total = layer.features.count();

      let batch: Array<{
        geometry: unknown;
        properties: Record<string, unknown>;
      }> = [];
      let processed = 0;
      const isTable = layer.geomType === 100; // wkbNone

      // Cursor walk via first()/next(). gdal-async's
      // `layer.features.get(i)` looks up by FID, NOT by index --
      // GDB layers commonly have non-sequential FIDs (e.g. starting
      // at 1 with deletions creating gaps), so the indexed loop
      // 404s on the first iteration and tears the stream. The
      // forEach variant works because it iterates the cursor under
      // the hood; we drive the same cursor manually so we can yield
      // to the event loop with `await onBatch` between flushes
      // without buffering the whole layer in memory.
      let feature = layer.features.first();
      while (feature) {
        processed += 1;
        const geomJson = isTable ? null : featureGeomJson(feature, xform);
        // Spatial layer with an undecodable geometry: skip silently
        // (matches what the legacy non-streaming path did). For
        // table-mode layers, the absence of geometry is expected and
        // we still emit the row.
        const skip = !isTable && !geomJson;
        if (!skip) {
          const props: Record<string, unknown> = feature.fields.toObject();
          batch.push({
            geometry: isTable ? null : geomJson,
            properties: props,
          });
          if (batch.length >= batchSize) {
            await onBatch(batch, { processed, total });
            batch = [];
          }
        }
        feature = layer.features.next();
      }
      if (batch.length > 0) {
        await onBatch(batch, { processed, total });
      }

      return {
        fields,
        driver: ds.driver.description,
        layerName: layer.name,
        sourceSrs: srsAuthCode(layer.srs),
        total,
      };
    } finally {
      ds.close();
    }
  }

  /**
   * gdal-async is a native addon; loading it eagerly would crash the
   * whole portal-api on platforms whose prebuilds are missing. Defer
   * to the first ingest attempt and surface a friendly error if it
   * still fails then.
   */
  private async loadGdal(): Promise<typeof import('gdal-async')> {
    try {
      const mod = await import('gdal-async');
      return (mod as unknown as { default?: typeof import('gdal-async') }).default ?? mod;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`gdal-async failed to load: ${msg}`);
      throw new InternalServerErrorException(
        'Server-side ingest is unavailable because GDAL is not installed. Install the gdal-async native binding or use the client-side upload flow for supported formats.',
      );
    }
  }
}

/** Keep tmp filenames predictable and safe for shell-adjacent tools. */
function safeFilename(name: string): string {
  const base = name.replace(/[^\w.-]/g, '_');
  return base.length > 0 ? base : 'upload.bin';
}

function gdalTypeToSimple(
  t: string,
): 'string' | 'number' | 'boolean' | 'date' {
  const u = t.toLowerCase();
  if (u.includes('int') || u.includes('real') || u.includes('double')) {
    return 'number';
  }
  if (u.includes('date') || u.includes('time')) return 'date';
  if (u.includes('bool')) return 'boolean';
  return 'string';
}

/**
 * Reduce a GDAL WKB geometry type (Point, MultiLineString, etc.) to the
 * tri-state we expose in the builder. Returns null when GDAL reports no
 * specific geometry (attribute-only "table" layer inside a GDB or
 * unknown / mixed geometries inside a shapefile).
 *
 * gdal-async hands us `layer.geomType` as a numeric WKB constant
 * (Point=1, LineString=2, Polygon=3, MultiPoint=4, MultiLineString=5,
 * MultiPolygon=6, plus the +1000/+2000/+3000 dimension variants for
 * Z/M/ZM). The earlier implementation only ran a string includes()
 * check, which mapped numeric values to null and surfaced every
 * shapefile in the wizard as a TABLE rather than the polygon /
 * point / line layer it actually was. Now we fold the numeric path
 * into a real switch over the WKB base type and keep the string
 * fallback for environments where gdal-async returns a name.
 */
function gdalGeomToSimple(
  geomType: number | string,
): 'point' | 'line' | 'polygon' | null {
  const n =
    typeof geomType === 'number'
      ? geomType
      : Number.parseInt(String(geomType), 10);
  if (Number.isFinite(n) && n > 0 && n !== 100) {
    // Strip the high-bit EWKB flag and the dimension offsets
    // (Z=+1000, M=+2000, ZM=+3000) so PointZ, PointM, PointZM all
    // collapse to plain Point.
    const masked = n & 0x7fffffff;
    const base = ((masked - 1) % 1000) + 1;
    switch (base) {
      case 1: // Point
      case 4: // MultiPoint
        return 'point';
      case 2: // LineString
      case 5: // MultiLineString
      case 8: // CircularString
      case 9: // CompoundCurve
      case 11: // MultiCurve
      case 13: // Curve
        return 'line';
      case 3: // Polygon
      case 6: // MultiPolygon
      case 10: // CurvePolygon
      case 12: // MultiSurface
      case 14: // Surface
      case 15: // PolyhedralSurface
      case 16: // TIN
      case 17: // Triangle
        return 'polygon';
      default:
        break;
    }
  }
  const s = String(geomType).toLowerCase();
  if (s.includes('point')) return 'point';
  if (s.includes('line') || s.includes('curve')) return 'line';
  if (s.includes('polygon') || s.includes('surface')) return 'polygon';
  return null;
}

/**
 * Pull a GeoJSON geometry object out of a gdal feature. gdal-async's
 * `geometry.toJSON()` returns a JSON string, so we parse it; falling
 * back to `toObject()` if the JSON string is ever absent.
 *
 * If a CoordinateTransformation is supplied, the geometry is
 * reprojected in-place into the target SRS before serialization.
 * That's the critical piece for #48: without this, a shapefile in
 * UTM meters (EPSG:26911) would land in PostGIS with 4326 declared
 * but coordinates like `[480000, 3750000]`: off in the Gulf of
 * Guinea when rendered.
 */
function featureGeomJson(
  feature: unknown,
  transform: unknown | null,
): unknown | null {
  // Local shape-based access to gdal-async's Feature. Typed-through
  // `unknown` at the boundary because the real `gdal.Feature` type
  // constrains `geom.transform` to `CoordinateTransformation`, and
  // we want this helper usable with the transform built by
  // `buildTransform` below which we also type as `unknown` so
  // callers aren't forced to import gdal types.
  const f = feature as {
    getGeometry: () => {
      toJSON: () => string;
      toObject?: () => unknown;
      transform?: (x: unknown) => void;
    } | null;
  };
  const geom = f.getGeometry();
  if (!geom) return null;
  if (transform && typeof geom.transform === 'function') {
    try {
      geom.transform(transform);
    } catch {
      // Reprojection can fail on malformed geometries (self-
      // intersecting polygons, empty rings). Drop silently: the
      // caller's feature count reflects what actually made it in.
      return null;
    }
  }
  try {
    return JSON.parse(geom.toJSON());
  } catch {
    return geom.toObject ? geom.toObject() : null;
  }
}

/**
 * Build a gdal CoordinateTransformation from a layer's source SRS
 * to EPSG:4326 for ingest. Returns null when:
 *   - the layer has no declared SRS (assume the caller wants no
 *     transform: e.g. already-4326 GeoJSON with no explicit SRS)
 *   - the layer's SRS already IS 4326 (transform would be a no-op)
 *   - building the transform throws (proj lookup failure, etc.)
 * A null return tells featureGeomJson to skip the transform step.
 */
function buildTransform(
  gdal: typeof import('gdal-async'),
  sourceSrs: unknown,
  target4326: unknown,
): unknown | null {
  if (!sourceSrs) return null;
  const srsWithAuth = sourceSrs as {
    getAuthorityName?: () => string | null;
    getAuthorityCode?: () => string | null;
  };
  // Skip transform if source already claims EPSG:4326: cheapest
  // correctness path, and avoids a no-op roundtrip through proj.
  try {
    if (
      srsWithAuth.getAuthorityName?.() === 'EPSG' &&
      srsWithAuth.getAuthorityCode?.() === '4326'
    ) {
      return null;
    }
  } catch {
    /* fall through to build the transform: safer than refusing */
  }
  try {
    return new (gdal as unknown as {
      CoordinateTransformation: new (a: unknown, b: unknown) => unknown;
    }).CoordinateTransformation(sourceSrs, target4326);
  } catch {
    return null;
  }
}

/**
 * Collapse a gdal SpatialReference into an "EPSG:NNNN" string for
 * the provenance block. When the SRS has no declared authority
 * (some exotic projected CRSes define only a WKT string), fall back
 * to "CRS:unknown" so the UI has something to display.
 */
function srsAuthCode(srs: unknown): string | null {
  if (!srs) return null;
  const s = srs as {
    getAuthorityName?: () => string | null;
    getAuthorityCode?: () => string | null;
  };
  try {
    const auth = s.getAuthorityName?.();
    const code = s.getAuthorityCode?.();
    if (auth && code) return `${auth}:${code}`;
  } catch {
    /* fall through */
  }
  return 'CRS:unknown';
}
