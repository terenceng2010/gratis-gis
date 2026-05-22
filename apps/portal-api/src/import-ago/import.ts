// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * AGO migration importer (workstream 3, phase 4).
 *
 * Consumes a `DryRunReport` + AGO connection params and creates
 * the planned portal items. Per-item failures are isolated --
 * a broken Web Map doesn't take down the rest of the import.
 * The result is an `ImportReport` listing every item the worker
 * touched, what happened, and any per-item warnings.
 *
 * v1 scope (this commit):
 *
 *   - Services (Feature / Map / Image / Vector Tile) -> portal
 *     `service` item with the AGO URL + protocol; service layer
 *     probing deferred to a portal admin re-probe.
 *
 *   - Web Maps -> portal `map` item via the existing
 *     `WebMapJsonImportService` (which already converts the
 *     WebMap JSON envelope and links matching service items).
 *
 *   - Files (Image / PDF / CSV / Document Link / ...) ->
 *     portal `file` item carrying the AGO download URL. v1
 *     does NOT re-host file contents; the URL stays attached
 *     to AGO. Later phases can add re-hosting via MinIO.
 *
 * Out of v1 scope: Web Mapping Applications, Dashboards, Forms,
 * StoryMap, Experience Builder. These items have AGO-runtime-
 * specific configs that don't round-trip cleanly into the
 * portal's own runtimes; trying to recreate them lossily would
 * leave the user worse off than rebuilding from the imported
 * underlying maps + layers. They surface in the dry-run as
 * "skip with reason" so the operator knows what was left behind.
 *
 * The importer runs synchronously inside the HTTP request. For
 * a small AGO account (test orgs, hobby portals) the whole
 * import completes in seconds. The shape stays usable inside a
 * future ImportJob row for large orgs where async + restart-
 * safe is required.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { EsriWebMap } from '@gratis-gis/engine';
import { DEFAULT_FOLDER } from '@gratis-gis/shared-types';

import type { AuthUser } from '../auth/auth-sync.service.js';
import { ItemsService } from '../items/items.service.js';
import { WebMapJsonImportService } from '../items/web-map-json-import.service.js';

import { AgoApiError, AgoClient } from './ago-client.js';
import { agoAccessToPortal, type DryRunItem, type DryRunReport } from './dry-run.js';
import { sortByImportOrder } from './type-mapping.js';

/**
 * One row in the import report. ``status`` is always set;
 * ``portalItemId`` / ``portalItemType`` set when status is
 * 'created'; ``error`` set when status is 'failed'.
 */
export interface ImportResult {
  agoId: string;
  agoType: string;
  agoTitle: string;
  status: 'created' | 'failed' | 'skipped';
  portalItemId?: string;
  portalItemType?: string;
  /** Per-item warnings (sub-conversions that didn't translate
   *  cleanly, e.g. unknown layer in a Web Map, untranslated
   *  Dashboard widget). Always an array; empty when the import
   *  was clean. */
  warnings: string[];
  /** Set when status is 'failed'. */
  error?: string;
}

/**
 * Aggregate import report. Hands back to the dialog (or
 * eventually to an ImportJob row) so the operator can see what
 * happened end-to-end.
 */
export interface ImportReport {
  total: number;
  created: number;
  failed: number;
  skipped: number;
  results: ImportResult[];
  /** Folders the importer created to mirror the AGO folder layout.
   *  Empty when the source had no folders (everything at root) or
   *  when folder creation was skipped entirely (e.g. an empty
   *  willImport set). */
  folders: ImportedFolder[];
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

/** One folder the importer created. The dialog uses this to show
 *  "imported into 3 folders: Field Data, Maps, Public" after the
 *  job finishes. */
export interface ImportedFolder {
  agoFolderId: string;
  title: string;
  portalItemId: string;
  /** Number of items the importer placed in this folder. May be
   *  zero if every item in the AGO folder was skipped or failed. */
  childCount: number;
}

@Injectable()
export class AgoImportService {
  private readonly log = new Logger(AgoImportService.name);

  constructor(
    private readonly items: ItemsService,
    private readonly webMapImport: WebMapJsonImportService,
  ) {}

  /**
   * Execute the import described by ``args.report``. Walks the
   * report's items in dependency order (services before maps,
   * maps before apps) so later items can reference earlier ones
   * via stable portal item ids.
   */
  async run(args: {
    user: AuthUser;
    portalUrl: string;
    token: string;
    report: DryRunReport;
    /** Per-item callback so the dialog / future job runner can
     *  stream progress without buffering. */
    onProgress?: (result: ImportResult, idx: number, total: number) => void;
  }): Promise<ImportReport> {
    const startedAt = new Date();
    const client = new AgoClient({
      portalUrl: args.portalUrl,
      token: args.token,
    });

    // Phase 6: pre-create one portal folder per AGO folder that
    // actually contains at least one importable item. Skipping
    // empty folders keeps the portal-side folder list from filling
    // with placeholders that the operator has to clean up later.
    const folderIdsWithImports = new Set<string>();
    for (const it of args.report.items) {
      if (!it.willImport) continue;
      if (it.ownerFolder) folderIdsWithImports.add(it.ownerFolder);
    }
    const portalFolderByAgoId = new Map<string, string>();
    const folderChildIds = new Map<string, string[]>();
    const folderReport: ImportedFolder[] = [];
    for (const folder of args.report.folders) {
      if (!folderIdsWithImports.has(folder.id)) continue;
      try {
        const created = await this.items.create(args.user, {
          type: 'folder',
          title: folder.title,
          // FolderData has an optional smartQuery field that TS
          // doesn't see as Prisma.InputJsonValue-compatible
          // directly; an explicit cast keeps the type-check happy
          // without losing the shape contract (FolderData itself
          // is the validator).
          data: {
            ...DEFAULT_FOLDER,
            childItemIds: [],
          } as unknown as Prisma.InputJsonValue,
          access: 'private',
        });
        portalFolderByAgoId.set(folder.id, created.id);
        folderChildIds.set(folder.id, []);
        folderReport.push({
          agoFolderId: folder.id,
          title: folder.title,
          portalItemId: created.id,
          childCount: 0,
        });
      } catch (e) {
        // Folder-create failure is non-fatal: items just land at
        // the root instead of in the missing folder. Log + keep
        // going so a permission edge doesn't take down the whole
        // import.
        this.log.warn(
          'Failed to create AGO folder %s ("%s"): %s',
          folder.id,
          folder.title,
          errorMessage(e),
        );
      }
    }

    // Order: services first (so maps can reference them),
    // then maps, then files. Items the report marks as
    // not-importable stay out entirely.
    //
    // ``sortByImportOrder`` keys on a ``type`` field; DryRunItem
    // uses ``agoType``. Wrap so the sort stays type-driven and
    // the result preserves DryRunItem rows.
    const ordered = sortByImportOrder(
      args.report.items
        .filter((row) => row.willImport)
        .map((row) => ({ ...row, type: row.agoType })),
    ) as DryRunItem[];

    const results: ImportResult[] = [];
    for (let i = 0; i < ordered.length; i += 1) {
      const item = ordered[i]!;
      const result = await this.importOne(args.user, client, item).catch(
        (e): ImportResult => ({
          agoId: item.agoId,
          agoType: item.agoType,
          agoTitle: item.title,
          status: 'failed',
          warnings: [],
          error: errorMessage(e),
        }),
      );
      results.push(result);
      // Track folder membership for the post-pass that writes
      // childItemIds back to each created folder.
      if (
        result.status === 'created' &&
        result.portalItemId &&
        item.ownerFolder &&
        folderChildIds.has(item.ownerFolder)
      ) {
        folderChildIds.get(item.ownerFolder)!.push(result.portalItemId);
      }
      args.onProgress?.(result, i, ordered.length);
    }

    // Skipped items from the report (willImport=false) are
    // recorded in the result so the dialog can render a single
    // unified table without re-merging with the dry-run.
    for (const item of args.report.items) {
      if (item.willImport) continue;
      results.push({
        agoId: item.agoId,
        agoType: item.agoType,
        agoTitle: item.title,
        status: 'skipped',
        warnings: item.reason ? [item.reason] : [],
      });
    }

    // Post-pass: populate each portal folder's childItemIds with
    // the list of items the importer placed in it. Done in one
    // update per folder rather than incrementally so a folder
    // never sits in a half-populated state.
    for (const [agoFolderId, portalFolderId] of portalFolderByAgoId) {
      const childIds = folderChildIds.get(agoFolderId) ?? [];
      try {
        await this.items.update(args.user, portalFolderId, {
          data: {
            ...DEFAULT_FOLDER,
            childItemIds: childIds,
          } as unknown as Prisma.InputJsonValue,
        });
      } catch (e) {
        this.log.warn(
          'Failed to populate childItemIds on portal folder %s: %s',
          portalFolderId,
          errorMessage(e),
        );
      }
      // Mirror the count into the report.
      const reportRow = folderReport.find(
        (r) => r.agoFolderId === agoFolderId,
      );
      if (reportRow) reportRow.childCount = childIds.length;
    }

    const completedAt = new Date();
    return {
      total: args.report.items.length,
      created: results.filter((r) => r.status === 'created').length,
      failed: results.filter((r) => r.status === 'failed').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      results,
      folders: folderReport,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
    };
  }

  /**
   * Dispatch one dry-run row to the per-type importer. The
   * dispatch is data-driven (looks at ``targetType``) so adding
   * a new type means: add a row in `type-mapping.ts`, add a
   * branch here, write a converter.
   */
  private async importOne(
    user: AuthUser,
    client: AgoClient,
    row: DryRunItem,
  ): Promise<ImportResult> {
    switch (row.targetType) {
      case 'service':
        return this.importService(user, row);
      case 'map':
        return this.importMap(user, client, row);
      case 'file':
        return this.importFile(user, row);
      default:
        // The dry-run + type-mapping should have caught
        // unsupported types and marked them willImport=false
        // before we got here. Anything that lands here is a
        // mapping-table drift we should fail loudly on so
        // it's caught in dev rather than silently dropped.
        return {
          agoId: row.agoId,
          agoType: row.agoType,
          agoTitle: row.title,
          status: 'failed',
          warnings: [],
          error: `Importer does not handle target type "${row.targetType}".`,
        };
    }
  }

  // -----------------------------------------------------------
  // Per-type importers
  // -----------------------------------------------------------

  /**
   * AGO service items map onto portal ``service`` items. We
   * already know the AGO type so the protocol is derived from
   * the dry-run classification (the dry-run row's
   * ``serviceUrl`` carries the upstream URL). No /data fetch
   * needed -- services don't carry one.
   */
  private async importService(
    user: AuthUser,
    row: DryRunItem,
  ): Promise<ImportResult> {
    const url = row.serviceUrl ?? '';
    if (!url) {
      return failed(row, 'AGO service item carried no URL.');
    }
    const protocol = inferServiceProtocol(row.agoType);
    const data = {
      url,
      layers: [] as Array<{ name: string; title?: string }>,
      version: 1,
      protocol,
      serviceTitle: row.title,
      selectedLayerIds: [] as number[],
      importSource: 'ago',
      agoItemId: row.agoId,
    };
    const created = await this.items.create(user, {
      type: 'service',
      title: row.title,
      data,
      access: agoAccessToPortal(row.access),
    });
    return {
      agoId: row.agoId,
      agoType: row.agoType,
      agoTitle: row.title,
      status: 'created',
      portalItemId: created.id,
      portalItemType: 'service',
      warnings: [
        'Layer list will be empty until portal admin re-probes the service.',
      ],
    };
  }

  /**
   * Web Maps run through the existing
   * ``WebMapJsonImportService``. We fetch the /data envelope
   * here (the dry-run intentionally doesn't, so it stays cheap
   * for large walks).
   */
  private async importMap(
    user: AuthUser,
    client: AgoClient,
    row: DryRunItem,
  ): Promise<ImportResult> {
    let webMap: EsriWebMap;
    try {
      webMap = await client.getItemData<EsriWebMap>(row.agoId);
    } catch (e) {
      return failed(row, `Fetching WebMap JSON failed: ${errorMessage(e)}`);
    }
    const result = await this.webMapImport.import({
      user,
      webMap,
      title: row.title,
      access: agoAccessToPortal(row.access),
    });
    return {
      agoId: row.agoId,
      agoType: row.agoType,
      agoTitle: row.title,
      status: 'created',
      portalItemId: result.itemId,
      portalItemType: 'map',
      warnings: result.warnings,
    };
  }

  /**
   * File-typed AGO items become portal ``file`` items carrying
   * a link back to AGO. v1 does not re-host the bytes; later
   * phases can stream the content into MinIO. Document Link
   * items already point at an external URL on AGO side, so we
   * just preserve it.
   */
  private async importFile(
    user: AuthUser,
    row: DryRunItem,
  ): Promise<ImportResult> {
    const data = {
      kind: 'link' as const,
      url:
        row.serviceUrl ??
        `${row.agoId}`,
      agoItemId: row.agoId,
      agoType: row.agoType,
      importSource: 'ago' as const,
    };
    const created = await this.items.create(user, {
      type: 'file',
      title: row.title,
      data,
      access: agoAccessToPortal(row.access),
    });
    return {
      agoId: row.agoId,
      agoType: row.agoType,
      agoTitle: row.title,
      status: 'created',
      portalItemId: created.id,
      portalItemType: 'file',
      warnings: [
        'File contents stay on AGO. Re-host through the portal upload flow if you need a self-contained copy.',
      ],
    };
  }

}

// ----------------------------------------------------------
// Helpers
// ----------------------------------------------------------

function inferServiceProtocol(
  agoType: string,
):
  | 'arcgis_map'
  | 'arcgis_features'
  | 'arcgis_vector_tiles'
  | 'arcgis_image' {
  switch (agoType) {
    case 'Feature Service':
      return 'arcgis_features';
    case 'Map Service':
      return 'arcgis_map';
    case 'Image Service':
      return 'arcgis_image';
    case 'Vector Tile Service':
      return 'arcgis_vector_tiles';
    default:
      // Should not happen given the dry-run pre-classified; if
      // a new service type slips through, falling back to
      // ``arcgis_map`` keeps the import unblocked and the
      // operator can fix it in portal admin.
      return 'arcgis_map';
  }
}

function failed(row: DryRunItem, error: string): ImportResult {
  return {
    agoId: row.agoId,
    agoType: row.agoType,
    agoTitle: row.title,
    status: 'failed',
    warnings: [],
    error,
  };
}

function errorMessage(e: unknown): string {
  if (e instanceof AgoApiError) {
    return `AGO ${e.status}${e.code ? ` (code ${e.code})` : ''}: ${e.message}`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
