// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Dry-run report builder for the AGO migration importer.
 *
 * Walks a user's AGO content (via ``AgoClient.walkUserContent``)
 * + classifies each item (via ``type-mapping.ts``) + produces a
 * structured ``DryRunReport`` the operator sees before they
 * commit to running the import. No portal writes happen here.
 *
 * The report shape is the contract the dialog renders against
 * and the import-job worker consumes (so the worker doesn't
 * re-walk; it just acts on the dry-run snapshot). Stable enough
 * that adding new fields stays additive.
 */
import { Injectable, Logger } from '@nestjs/common';

import { AgoClient } from './ago-client.js';
import type { AgoItem, AgoPortalSelf } from './ago-types.js';
import {
  classifyAgoType,
  type AgoTypeMapping,
  type GratisGisImportType,
} from './type-mapping.js';

/**
 * One item in the dry-run report. Carries the AGO metadata plus
 * the classification verdict so the importer can act on the
 * report without re-fetching anything.
 */
export interface DryRunItem {
  agoId: string;
  agoType: string;
  agoTypeKeywords: string[];
  title: string;
  ownerFolder: string | null;
  folderTitle: string;
  /** Whether the importer plans to create a portal item. False
   *  rows carry a ``reason`` so the dialog can explain. */
  willImport: boolean;
  /** Resulting portal item type. ``null`` when the importer
   *  isn't planning to create anything (skipped). */
  targetType: GratisGisImportType | null;
  /** Why this item is being skipped, when willImport is false. */
  reason?: string;
  /** Source URL captured from AGO for services. Empty for
   *  non-service items. */
  serviceUrl?: string;
  /** AGO sharing scope on the source item. Mirrored onto the
   *  portal item the importer creates (with ``shared`` collapsed
   *  to ``org`` since GratisGIS doesn't have a per-group share
   *  primitive on the items table -- per-group shares are done
   *  via the sharing table after the fact). Surfacing this on
   *  the row lets the dialog show a sharing-scope breakdown
   *  before the import runs. */
  access: 'private' | 'org' | 'public' | 'shared';
}

/**
 * Aggregate counts so the dialog can render headline numbers
 * ("3 web maps, 12 feature services") without iterating the
 * items list itself.
 */
export interface DryRunCounts {
  foldersTotal: number;
  itemsTotal: number;
  itemsToImport: number;
  itemsToSkip: number;
  /** count by GratisGIS target type (e.g. ``{ map: 3 }``). Only
   *  importable items contribute. */
  byTargetType: Partial<Record<GratisGisImportType, number>>;
  /** count by AGO type, including unsupported ones, so the
   *  dialog can show "and 4 StoryMap items will be skipped". */
  byAgoType: Record<string, number>;
  /** Count of items in each AGO sharing scope (post-classification:
   *  only items that will import contribute). Lets the dialog warn
   *  about how many items are about to be created public / private. */
  byAccess: Partial<Record<DryRunItem['access'], number>>;
}

/**
 * One pre-flight warning the dialog should surface before the
 * operator clicks Import. Examples: "3 feature services require
 * auth; we'll need credentials before they can resolve in maps"
 * or "5 items have AGO types we don't yet support".
 */
export interface DryRunWarning {
  severity: 'info' | 'warn';
  message: string;
  /** Affected AGO item ids, when the warning is item-scoped. */
  affectedItemIds?: string[];
}

/** The full dry-run snapshot. */
export interface DryRunReport {
  portal: { url: string; username: string };
  generatedAt: string;
  counts: DryRunCounts;
  folders: Array<{ id: string; title: string }>;
  items: DryRunItem[];
  warnings: DryRunWarning[];
}

@Injectable()
export class AgoDryRunService {
  private readonly log = new Logger(AgoDryRunService.name);

  /**
   * Run the dry-run against the given AGO portal. Read-only.
   * Returns the full report; the caller decides what to do
   * with it (render to the operator UI, log, or pass to the
   * import-job worker).
   *
   * The walk is paginated and may take a while for large orgs;
   * callers wanting progress should pass an ``onItem``
   * callback.
   */
  async run(args: {
    portalUrl: string;
    token: string;
    username?: string;
    onItem?: (item: DryRunItem, idx: number) => void;
  }): Promise<DryRunReport> {
    const client = new AgoClient({
      portalUrl: args.portalUrl,
      token: args.token,
    });

    // Resolve the username we're walking. If none provided,
    // pull it from /portals/self.
    let username = args.username;
    let portalSelf: AgoPortalSelf | null = null;
    if (!username) {
      portalSelf = await client.portalSelf();
      username = portalSelf.user?.username;
      if (!username) {
        throw new Error(
          'AGO did not return a username on /portals/self; pass one explicitly.',
        );
      }
    }

    const items: DryRunItem[] = [];
    const foldersSeen = new Map<string, { id: string; title: string }>();
    let idx = 0;
    await client.walkUserContent({
      username,
      onItem: (item, folder) => {
        const row = classifyAndRow(item, folder.title);
        items.push(row);
        if (folder.id) {
          foldersSeen.set(folder.id, { id: folder.id, title: folder.title });
        }
        args.onItem?.(row, idx);
        idx += 1;
      },
    });

    const counts = computeCounts(items, foldersSeen.size);
    const warnings = computeWarnings(items, counts);
    return {
      portal: { url: args.portalUrl, username },
      generatedAt: new Date().toISOString(),
      counts,
      folders: [...foldersSeen.values()].sort((a, b) =>
        a.title.localeCompare(b.title),
      ),
      items,
      warnings,
    };
  }
}

/**
 * Pure-function classification used by the service above. Public
 * for tests so the service spec can stay focused on the walk +
 * report shape.
 */
export function classifyAndRow(
  item: AgoItem,
  folderTitle: string,
): DryRunItem {
  const mapping = classifyAgoType(item.type, item.typeKeywords);
  const row: DryRunItem = {
    agoId: item.id,
    agoType: item.type,
    agoTypeKeywords: item.typeKeywords ?? [],
    title: item.title,
    ownerFolder: item.ownerFolder ?? null,
    folderTitle,
    willImport: mapping.supported && mapping.targetType !== null,
    targetType: mapping.targetType,
    // AGO listing always carries an access; default to 'private'
    // if a malformed row drops it, since refusing to import is
    // less surprising than over-sharing.
    access: item.access ?? 'private',
  };
  if (!row.willImport) {
    row.reason = mapping.notes;
  }
  if (item.url) {
    row.serviceUrl = item.url;
  }
  return row;
}

/**
 * Map an AGO sharing scope onto a portal ItemAccess. AGO's
 * ``shared`` (specific-groups) value has no direct equivalent on
 * the items table (group shares live on the sharing table after
 * the fact) so it collapses to ``org``; the operator can tighten
 * via the per-share UI after import.
 *
 * Exposed for tests and for the importer.
 */
export function agoAccessToPortal(
  access: DryRunItem['access'],
): 'private' | 'org' | 'public' {
  switch (access) {
    case 'public':
      return 'public';
    case 'org':
    case 'shared':
      return 'org';
    case 'private':
    default:
      return 'private';
  }
}

/**
 * Build the counts block from the classified items + the folder
 * total. Public so tests can call directly.
 */
export function computeCounts(
  items: ReadonlyArray<DryRunItem>,
  foldersTotal: number,
): DryRunCounts {
  const byTargetType: Partial<Record<GratisGisImportType, number>> = {};
  const byAgoType: Record<string, number> = {};
  const byAccess: Partial<Record<DryRunItem['access'], number>> = {};
  let itemsToImport = 0;
  let itemsToSkip = 0;
  for (const it of items) {
    byAgoType[it.agoType] = (byAgoType[it.agoType] ?? 0) + 1;
    if (it.willImport && it.targetType) {
      itemsToImport += 1;
      byTargetType[it.targetType] = (byTargetType[it.targetType] ?? 0) + 1;
      byAccess[it.access] = (byAccess[it.access] ?? 0) + 1;
    } else {
      itemsToSkip += 1;
    }
  }
  return {
    foldersTotal,
    itemsTotal: items.length,
    itemsToImport,
    itemsToSkip,
    byTargetType,
    byAgoType,
    byAccess,
  };
}

/**
 * Synthesize cross-cutting warnings from the items + counts.
 * Today emits:
 *
 *   - one warn line per group of unsupported items (so the
 *     operator sees the count + the AGO type instead of N
 *     individual rows in the report);
 *   - one info line summarizing how many service items will
 *     need an auth follow-up (best-effort: we can't tell
 *     authed-vs-anonymous from the listing, so we surface the
 *     reminder without firing per-service);
 *   - one info line when the import is entirely empty.
 */
export function computeWarnings(
  items: ReadonlyArray<DryRunItem>,
  counts: DryRunCounts,
): DryRunWarning[] {
  const warnings: DryRunWarning[] = [];

  if (counts.itemsTotal === 0) {
    warnings.push({
      severity: 'info',
      message: 'No items found for this user. Nothing will be imported.',
    });
    return warnings;
  }

  // Group skipped items by their reason so the report doesn't
  // list 50 identical "StoryMap not supported" rows.
  const skipsByReason = new Map<
    string,
    { count: number; ids: string[] }
  >();
  for (const it of items) {
    if (it.willImport || !it.reason) continue;
    const bucket = skipsByReason.get(it.reason);
    if (bucket) {
      bucket.count += 1;
      bucket.ids.push(it.agoId);
    } else {
      skipsByReason.set(it.reason, { count: 1, ids: [it.agoId] });
    }
  }
  for (const [reason, bucket] of skipsByReason.entries()) {
    warnings.push({
      severity: 'warn',
      message: `${bucket.count} item(s) will be skipped: ${reason}`,
      affectedItemIds: bucket.ids,
    });
  }

  // Service items typically need a follow-up auth step for
  // anything not anonymously readable. AGO doesn't surface
  // "requires-auth" on the listing, so we hint instead of
  // claim.
  const serviceCount = counts.byTargetType.service ?? 0;
  if (serviceCount > 0) {
    warnings.push({
      severity: 'info',
      message:
        `${serviceCount} connected-service item(s) will be created. ` +
        'Services that require authentication will need credentials ' +
        'configured in portal admin before they resolve in maps.',
    });
  }

  // Surface public sharing explicitly: operators sometimes assume
  // an import lands everything private and are surprised when
  // mirrored AGO-public items stay world-readable on the portal.
  const publicCount = counts.byAccess.public ?? 0;
  if (publicCount > 0) {
    warnings.push({
      severity: 'warn',
      message:
        `${publicCount} item(s) are PUBLIC on AGO and will be created as ` +
        'public on the portal. Tighten in the per-item sharing UI after ' +
        'import if that is not what you want.',
    });
  }

  // Folder summary so the dialog can show "imports will be
  // organized into N folders" without iterating the items list.
  if (counts.foldersTotal > 0) {
    warnings.push({
      severity: 'info',
      message:
        `Imports will be organized into ${counts.foldersTotal} folder(s), ` +
        'mirroring the AGO folder layout. Items at the AGO root land at ' +
        'the portal root.',
    });
  }

  return warnings;
}
