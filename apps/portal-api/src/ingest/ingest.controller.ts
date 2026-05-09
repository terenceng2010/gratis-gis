// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  NotFoundException,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Prisma } from '@prisma/client';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { ItemsService } from '../items/items.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SharingService } from '../items/sharing.service.js';
import { FeaturesService } from '../features/features.service.js';
import { DataLayerFeaturesService } from '../data-layer/features.service.js';
import {
  DataLayerTablesService,
  type DataLayerLayerShape,
} from '../data-layer/tables.service.js';
import { IngestService } from './ingest.service.js';
import { IngestStagingService } from './ingest-staging.service.js';

/**
 * Server-side ingest endpoint. Accepts a multipart upload of an
 * OGR-readable vector file, parses it via GDAL, and writes the
 * features into a PostGIS table (v2 storage). The item metadata is
 * updated to reflect the new storage type.
 *
 * Only data_layer items are accepted as targets. The caller must
 * have edit rights (owner or org admin, same rule as PATCH /items/:id).
 */
@ApiTags('ingest')
@ApiBearerAuth()
@Controller()
export class IngestController {
  constructor(
    private readonly ingest: IngestService,
    private readonly items: ItemsService,
    private readonly sharing: SharingService,
    private readonly prisma: PrismaService,
    private readonly features: FeaturesService,
    private readonly dataLayerFeatures: DataLayerFeaturesService,
    private readonly dataLayerTables: DataLayerTablesService,
    private readonly staging: IngestStagingService,
  ) {}

  /**
   * Probe an uploaded spatial file and return per-layer metadata
   * (name, geometry type, fields, feature count) without creating or
   * mutating any items. Backs the builder's Import tab: user picks
   * one or more layers, we seed the v3 schema with them, then the
   * user fills in details and creates the item.
   */
  @Post('ingest/probe')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 1024 * 1024 * 1024 },
    }),
  )
  async probe(@UploadedFile() file: Express.Multer.File | undefined) {
    if (!file) {
      throw new BadRequestException(
        'No file uploaded; field name must be "file".',
      );
    }
    return this.ingest.probeFile(file.buffer, file.originalname);
  }

  /**
   * Stage an upload for later ingest AND return the schema preview.
   * Combines /ingest/probe + a server-side hold so the wizard can do
   * one upload, get the schema, let the user edit details, and then
   * fan out per-layer ingest from the stagingId without re-uploading
   * the bytes. Used by the data_layer create wizard.
   *
   * Returns the same probe shape as /ingest/probe with a stagingId
   * tacked on. Stagings expire after one hour (see
   * IngestStagingService); a wizard that idles longer than that has
   * to re-upload, which we accept as the trade for bounded disk.
   */
  @Post('ingest/stage')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 1024 * 1024 * 1024 },
    }),
  )
  async stage(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) {
      throw new BadRequestException(
        'No file uploaded; field name must be "file".',
      );
    }
    // Stage first so the file is on disk under a stable path. probe
    // can then read it from there without re-buffering. If the probe
    // fails (corrupt zip, etc.) we drop the staging to keep disk
    // tidy; the user gets an inline error and re-uploads.
    const staged = await this.staging.stage({
      buffer: file.buffer,
      originalName: file.originalname,
      ownerId: user.id,
    });
    try {
      const probe = await this.ingest.probeFileFromPath(staged.filePath);
      return {
        stagingId: staged.stagingId,
        driver: probe.driver,
        layers: probe.layers,
      };
    } catch (err) {
      // Probe rejected: don't keep a staged file we can't ingest.
      await this.staging.dropStaging(staged.stagingId).catch(() => {});
      throw err;
    }
  }

  @Post('items/:id/ingest')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: {
        // Multer enforces the same ceiling as IngestService. Defense
        // in depth is cheap and it gives users a clear 413 instead
        // of burning CPU on a 2 GB shapefile. Set to 1 GB so a
        // county-scale parcel layer (often 200-500 MB zipped) fits
        // without the user having to subset first. Anything bigger
        // should go through a future direct-to-MinIO presigned-PUT
        // path rather than buffering through portal-api.
        fileSize: 1024 * 1024 * 1024,
      },
    }),
  )
  async ingestFile(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded; field name must be "file".');
    }

    const item = await this.items.get(user, id);
    if (item.type !== 'data_layer') {
      throw new BadRequestException(
        'Server-side ingest only targets data_layer items.',
      );
    }
    const shares = await this.prisma.itemShare.findMany({ where: { itemId: id } });
    if (!this.sharing.canEdit(user, item, shares)) {
      throw new ForbiddenException('You do not have edit permission on this item.');
    }

    const { geojson, fields, driver, sourceSrs } = await this.ingest.fileToGeoJson(
      file.buffer,
      file.originalname,
    );

    // Ensure the PostGIS table exists for this item (idempotent).
    await this.features.provisionTable(id);

    // Replace all current features with the newly ingested set.
    const { inserted, expired } = await this.features.replaceAll(
      id,
      geojson.features.map((f: unknown) => {
        const feat = f as {
          geometry?: unknown;
          properties?: Record<string, unknown> | null;
        };
        return {
          geometry: feat.geometry,
          properties: feat.properties ?? {},
        };
      }),
      user,
    );

    // Compute bbox and update item metadata to v2 storage shape.
    const stats = await this.features.stats(id);
    const nextData: Record<string, unknown> = {
      version: 2,
      storageType: 'postgis',
      fields: fields.map((f) => ({
        name: f.name,
        type: f.type,
        label: f.name,
        nullable: true,
      })),
      featureCount: stats.featureCount,
      bbox: stats.bbox,
      updatedAt: new Date().toISOString(),
      source: {
        fileName: file.originalname,
        format: driverToFormat(driver),
        sizeBytes: file.size,
        importedAt: new Date().toISOString(),
        importedBy: user.id,
        note: `driver: ${driver}`,
        sourceSrs,
      },
    };

    await this.prisma.item.update({
      where: { id },
      data: { data: nextData as unknown as Prisma.InputJsonValue },
    });

    return {
      driver,
      inserted,
      expired,
      featureCount: stats.featureCount,
      bbox: stats.bbox,
      fields: nextData.fields,
      sourceSrs,
    };
  }

  /**
   * Per-layer ingest for v3 multi-layer items. Accepts a file + the
   * optional name of a source layer inside a multi-layer archive
   * (GDB, shapefile zip with several .shp). Features get bulk-
   * inserted into the target layer's PostGIS table: which must
   * already exist (provisioned on item create by ItemsService).
   */
  @Post('items/:id/layers/:layerId/import')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 1024 * 1024 * 1024 },
    }),
  )
  async ingestV3Layer(
    @CurrentUser() user: AuthUser,
    @Param('id') itemId: string,
    @Param('layerId') layerId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query('sourceLayer') sourceLayer?: string,
    // #244 replace-mode. Defaults to 'append' to preserve the existing
    // detail-page behaviour (which is what currently-bookmarked import
    // scripts assume); the UI's primary Import button passes
    // mode=replace explicitly.
    @Query('mode') mode?: 'replace' | 'append',
    // Staging integration: when stagingId is provided the file body
    // is optional, and we read the bytes from /tmp/gg-staging/<id>/
    // instead. The wizard's Create-item flow uses this so a 503 MB
    // GDB uploaded once at probe time gets re-used for N per-layer
    // ingests without N more uploads.
    @Query('stagingId') stagingId?: string,
  ) {
    if (!file && !stagingId) {
      throw new BadRequestException(
        'No file uploaded; provide a multipart "file" field or a "stagingId" query parameter.',
      );
    }
    if (mode !== undefined && mode !== 'replace' && mode !== 'append') {
      throw new BadRequestException(
        `Unknown mode "${mode}"; expected replace or append.`,
      );
    }
    const ingestMode: 'replace' | 'append' = mode ?? 'append';
    const item = await this.items.get(user, itemId);
    if (item.type !== 'data_layer') {
      throw new BadRequestException(
        'Ingest only targets data_layer items.',
      );
    }
    const data = item.data as {
      version?: number;
      layers?: Array<DataLayerLayerShape>;
    } | null;
    if (data?.version !== 3) {
      throw new BadRequestException(
        'Per-layer ingest is v3-only. Use /items/:id/ingest for v1/v2 items.',
      );
    }
    const layer = (data.layers ?? []).find((l) => l.id === layerId);
    if (!layer) {
      throw new NotFoundException(
        `Layer ${layerId} is not part of this item's schema.`,
      );
    }
    await this.items.assertCanEdit(user, itemId);

    // Phase 2.5: the engine substrate doesn't need a pre-insert
    // provisionLayer pass; observations are written to a shared
    // table keyed by scope, so geometry-type promotion (the old
    // pre-#240 Multi-* migration) is unnecessary too. Truncate
    // operates directly on the observation log.

    // #244: replace mode wipes the layer's data before inserting.
    // Solves the "I re-imported and now have 1.3M rows when the
    // source has 869k" problem from a partial-failure left behind
    // by an earlier attempt. Order matters: truncate first, ingest
    // second, so a failed ingest still leaves the user with an
    // empty layer rather than a half-old/half-new mix.
    let truncated = 0;
    if (ingestMode === 'replace') {
      // Capture the pre-truncate live-entity count for the
      // response so the UI can show "Replaced N rows with M".
      // Engine-side count: distinct entities with no tombstone
      // and an open valid_to.
      truncated = await this.dataLayerTables.countLiveEntities(itemId, layer.id);
      await this.dataLayerTables.truncateLayer(itemId, layerId);
    }

    // Resolve the source bytes. Two modes:
    //   1. Staging: we look up the staged file by id, verify it
    //      belongs to the caller, and read straight off disk via
    //      fileLayerToGeoJsonFromPath. The staging is not deleted
    //      here -- a single staging is consumed by N per-layer
    //      ingests, and the staging cleanup cron handles eviction.
    //   2. Multipart: legacy path where the caller PUTs the file in
    //      the request body. Still supported for direct API users
    //      and the detail-page Import button.
    let geojson: { type: 'FeatureCollection'; features: unknown[] };
    let driver: string;
    let layerName: string;
    let sourceSrs: string | null;
    let provenanceFileName: string;
    let provenanceSizeBytes: number;
    if (stagingId) {
      const staged = await this.staging.getStaging(stagingId, user.id);
      const out = await this.ingest.fileLayerToGeoJsonFromPath(
        staged.filePath,
        sourceLayer,
      );
      geojson = out.geojson;
      driver = out.driver;
      layerName = out.layerName;
      sourceSrs = out.sourceSrs;
      provenanceFileName = staged.originalName;
      provenanceSizeBytes = staged.sizeBytes;
    } else {
      // file is guaranteed non-null here by the guard above.
      const f = file!;
      const out = await this.ingest.fileLayerToGeoJson(
        f.buffer,
        f.originalname,
        sourceLayer,
      );
      geojson = out.geojson;
      driver = out.driver;
      layerName = out.layerName;
      sourceSrs = out.sourceSrs;
      provenanceFileName = f.originalname;
      provenanceSizeBytes = f.size;
    }

    // Honor the layer's declared schema as a whitelist: only keep
    // properties whose key matches a declared field name. Without
    // this, importing a shapefile drops every column from the file
    // into properties (including ESRI internal ones like
    // OBJECTID, Shape_Area, Shape_Length) regardless of what the
    // user declared during create. The wizard probe shows the user
    // the file's full column set; if they want all of them, they
    // need to declare all of them. Sparse schemas are honored.
    //
    // Edge case: a layer with zero declared fields is treated as
    // "I haven't decided yet, take everything" so a one-shot
    // wizard create doesn't silently drop all data.
    const fieldNames = new Set((layer.fields ?? []).map((f) => f.name));
    const filterProps = (props: Record<string, unknown>) => {
      if (fieldNames.size === 0) return props;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(props)) {
        if (fieldNames.has(k)) out[k] = props[k];
      }
      return out;
    };

    const { inserted } = await this.dataLayerFeatures.insertFeatures(
      itemId,
      layerId,
      geojson.features.map((f) => {
        const feat = f as {
          geometry?: unknown;
          properties?: Record<string, unknown> | null;
        };
        return {
          geometry: feat.geometry,
          properties: filterProps(feat.properties ?? {}),
        };
      }),
      user,
    );

    // Stamp provenance on the layer so the detail page can render
    // "Imported from nest-points.geojson on 4/24/2026 by Mateo". We
    // re-read the item rather than rely on the earlier snapshot since
    // insertFeatures may have mutated bbox / featureCount in between.
    await this.stampV3LayerSource(itemId, layerId, {
      fileName: provenanceFileName,
      format: driverToFormat(driver),
      sizeBytes: provenanceSizeBytes,
      importedAt: new Date().toISOString(),
      importedBy: user.id,
      note: `driver: ${driver}`,
      sourceSrs,
    });

    // Recompute item-level bbox from the freshly-loaded layer
    // tables. Without this, the items list spatial-search filter
    // and the data_layer detail page's map preview have nothing to
    // anchor on (item.bbox stays empty), so a just-ingested layer
    // can't be panned to or rendered until the next housekeeping
    // recompute pass runs (which can be hours away).
    //
    // We re-read item.data so we aggregate over the canonical layer
    // list (insertFeatures and any concurrent layer edits could
    // have shifted things). Failures here are non-fatal: the
    // ingest already succeeded, the bbox just remains stale until
    // the next housekeeping pass.
    try {
      const fresh = await this.prisma.item.findUnique({
        where: { id: itemId },
        select: { data: true },
      });
      const layers = ((fresh?.data ?? null) as { layers?: DataLayerLayerShape[] } | null)
        ?.layers;
      if (Array.isArray(layers)) {
        const bbox = await this.dataLayerTables.aggregateBbox(itemId, layers);
        await this.prisma.item.update({
          where: { id: itemId },
          data: { bbox: bbox ?? [] },
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[ingestV3Layer] bbox recompute failed for ${itemId}/${layerId}:`,
        err instanceof Error ? err.message : err,
      );
    }

    return {
      driver,
      sourceLayer: layerName,
      inserted,
      sourceSrs,
      mode: ingestMode,
      ...(ingestMode === 'replace' ? { replaced: truncated } : {}),
    };
  }

  /**
   * Merge a `source` block onto the named layer inside the item's
   * v3 data blob. Read-modify-write is safe here: this endpoint is
   * the only writer of layer.source, and we guard with canEdit above.
   */
  private async stampV3LayerSource(
    itemId: string,
    layerId: string,
    source: {
      fileName: string;
      format: string;
      sizeBytes: number;
      importedAt: string;
      importedBy: string;
      note?: string;
      sourceSrs?: string | null;
    },
  ) {
    const row = await this.prisma.item.findUnique({
      where: { id: itemId },
      select: { data: true },
    });
    const data = row?.data as
      | { version?: number; layers?: Array<Record<string, unknown>> }
      | null;
    if (!data || data.version !== 3 || !Array.isArray(data.layers)) return;
    const nextLayers = data.layers.map((l) =>
      (l as { id?: string }).id === layerId ? { ...l, source } : l,
    );
    const nextData = { ...(data as object), layers: nextLayers };
    await this.prisma.item.update({
      where: { id: itemId },
      data: { data: nextData as unknown as Prisma.InputJsonValue },
    });
  }
}

/**
 * Map GDAL driver strings we emit to the format enum the shared
 * DataLayerSource type exposes. Unknown drivers fall through to
 * 'api' so the shape stays strict on the client side.
 */
function driverToFormat(
  driver: string,
): 'geojson' | 'kml' | 'kmz' | 'shapefile' | 'gdb' | 'xlsx' | 'csv' | 'manual' | 'api' {
  const d = driver.toLowerCase();
  if (d.includes('geojson')) return 'geojson';
  if (d.includes('kmz')) return 'kmz';
  if (d.includes('kml')) return 'kml';
  if (d.includes('shape') || d.includes('esri shapefile')) return 'shapefile';
  if (d.includes('filegdb') || d.includes('openfilegdb')) return 'gdb';
  if (d.includes('xlsx') || d.includes('excel')) return 'xlsx';
  if (d.includes('csv')) return 'csv';
  return 'api';
}
