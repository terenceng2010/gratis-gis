import { notFound } from 'next/navigation';
import type {
  BasemapData,
  DataLayerData,
  DataLayerSublayer,
  EditorData,
  EditorTarget,
  Item,
  MapData,
  PickListData,
  ViewerData,
} from '@gratis-gis/shared-types';
import {
  DEFAULT_VIEWER,
  isViewerItem,
  readViewerData,
} from '@gratis-gis/shared-types';
import type { CustomBasemap } from '@/lib/custom-basemap';
import { apiFetch } from '@/lib/api';
import {
  buildEditorMapData,
  type ResolvedTarget,
} from '../../editor/build-map-data';
import { EditorRuntime } from '../../editor/editor-runtime';

interface Props {
  params: { id: string };
}

/**
 * Map a basemap item into the CustomBasemap shape MapCanvas
 * consumes. Mirrors the helper in editor/run/page.tsx; extracted to
 * a shared util once a third caller appears.
 */
function basemapItemToCustomBasemap(
  it: Item<BasemapData>,
): CustomBasemap | null {
  const d = it.data ?? ({} as BasemapData);
  let url: string | undefined;
  let sourceKind: CustomBasemap['sourceKind'];
  let config: Record<string, unknown> | null = null;
  switch (d.kind) {
    case 'style-url':
      if (!d.styleUrl) return null;
      url = d.styleUrl;
      sourceKind = 'vector-style';
      break;
    case 'tile-url':
      if (!d.tileUrl) return null;
      url = d.tileUrl;
      sourceKind = 'xyz';
      break;
    case 'wms':
      if (!d.wmsUrl) return null;
      url = d.wmsUrl;
      sourceKind = 'wms';
      config = (d.wmsConfig ?? null) as Record<string, unknown> | null;
      break;
    default:
      return null;
  }
  return {
    id: it.id,
    orgId: it.orgId,
    label: it.title,
    description: it.description ?? '',
    url,
    sourceKind,
    attribution: d.attribution ?? '',
    thumbnailUrl: d.thumbnailUrl ?? it.thumbnailUrl ?? null,
    config,
    isDefault: false,
  };
}

/**
 * Synthesize an EditorData payload from a ViewerData so the runtime
 * (which is the read-side substrate the editor already runs on) can
 * render the viewer with no behavioral branching. Every target gets
 * its capability flags zeroed out and its templates dropped so the
 * runtime + the server agree the user has no write capability here.
 *
 * The returned shape is what EditorRuntime expects; we set
 * canEdit=false at the call site too as a belt-and-suspenders gate
 * against any future runtime path that consults the prop directly.
 *
 * The viewer's own `tools` list is intentionally not piped into the
 * editor's `tools` field: those refer to write-side tools the editor
 * exposes (add, edit, delete, snap, undo, redo). The viewer's
 * read-side tools (select, query, measure, attribute-table, legend,
 * print) are always available in the runtime today; print is the
 * follow-up slice that adds a new toolbar entry.
 */
function viewerToEditor(viewer: ViewerData): EditorData {
  const targets: EditorTarget[] = viewer.targets.map((t) => ({
    dataLayerId: t.dataLayerId,
    layerKey: t.layerKey,
    canCreate: false,
    canEditGeometry: false,
    canEditAttributes: false,
    canDelete: false,
    editableFields: [],
    rowScope: 'all',
    templates: [],
  }));
  // exactOptionalPropertyTypes: only set mapId when defined; the
  // editor type's `mapId` is string-or-absent, not string-or-undefined.
  const out: EditorData = {
    version: 1,
    targets,
    tools: [],
    snapping: { enabled: false, selfSnap: false, tolerancePx: 10 },
  };
  if (viewer.mapId) out.mapId = viewer.mapId;
  return out;
}

/**
 * Viewer runtime page (#259). Mirrors editor/run/page.tsx structurally
 * and reuses the EditorRuntime as the read-side substrate. The only
 * differences: we call readViewerData / isViewerItem, synthesize an
 * EditorData with all-readonly targets, and pass canEdit=false.
 *
 * Auth: ItemsService.get() on the API enforces visibility (404 on
 * not-found-or-not-allowed). canEdit is forced to false here for the
 * runtime; per-share grants flow through the API.
 */
export default async function ViewerRuntimePage({ params }: Props) {
  let viewerItem: Item<unknown>;
  try {
    viewerItem = await apiFetch<Item<unknown>>(`/api/items/${params.id}`);
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) notFound();
    throw err;
  }
  if (!isViewerItem(viewerItem)) notFound();

  const viewer: ViewerData = {
    ...DEFAULT_VIEWER,
    ...((readViewerData(viewerItem) ?? {}) as Partial<ViewerData>),
  };
  const editor = viewerToEditor(viewer);

  const uniqueDataLayerIds = Array.from(
    new Set(editor.targets.map((t) => t.dataLayerId)),
  );

  const [basemapItems, referencedMap, targetItems] = await Promise.all([
    apiFetch<Array<Item<BasemapData>>>('/api/items?type=basemap').catch(
      () => [] as Array<Item<BasemapData>>,
    ),
    editor.mapId
      ? apiFetch<Item<MapData>>(`/api/items/${editor.mapId}`).catch(
          () => null,
        )
      : Promise.resolve(null),
    Promise.all(
      uniqueDataLayerIds.map((id) =>
        apiFetch<Item<DataLayerData>>(`/api/items/${id}`).catch(() => null),
      ),
    ),
  ]);

  const basemaps: CustomBasemap[] = basemapItems
    .map(basemapItemToCustomBasemap)
    .filter((b): b is CustomBasemap => b !== null);

  const dataLayerById = new Map<string, Item<DataLayerData>>();
  for (let i = 0; i < uniqueDataLayerIds.length; i += 1) {
    const item = targetItems[i];
    if (item) dataLayerById.set(uniqueDataLayerIds[i]!, item);
  }

  const resolvedTargets: ResolvedTarget[] = editor.targets.map((t) => {
    const item = dataLayerById.get(t.dataLayerId);
    let layer: DataLayerSublayer | null = null;
    if (item) {
      const data = item.data as DataLayerData | undefined;
      if (data && data.version === 3) {
        layer = data.layers.find((l) => l.id === t.layerKey) ?? null;
      }
    }
    return {
      dataLayerId: t.dataLayerId,
      layerKey: t.layerKey,
      layer,
      dataLayerTitle: item?.title ?? t.dataLayerId.slice(0, 8),
    };
  });

  const { mapData, targetLayerIds } = buildEditorMapData({
    editor,
    referencedMap,
    resolvedTargets,
  });

  const pickListItemIds = new Set<string>();
  for (const t of resolvedTargets) {
    if (!t.layer) continue;
    for (const f of t.layer.fields) {
      if (f.domain && f.domain.type === 'coded-value-ref') {
        pickListItemIds.add(f.domain.pickListItemId);
      }
    }
  }
  const pickListItems = await Promise.all(
    Array.from(pickListItemIds).map((id) =>
      apiFetch<Item<PickListData>>(`/api/items/${id}`).catch(() => null),
    ),
  );
  const pickLists: Record<string, PickListData> = {};
  for (const it of pickListItems) {
    if (it && it.data) pickLists[it.id] = it.data as PickListData;
  }

  return (
    <EditorRuntime
      editorId={viewerItem.id}
      editorTitle={viewerItem.title}
      editor={editor}
      resolvedTargets={resolvedTargets}
      pickLists={pickLists}
      referencedMapTitle={referencedMap?.title ?? null}
      initialMapData={mapData}
      targetLayerIds={targetLayerIds}
      basemaps={basemaps}
      canEdit={false}
      // #259 slice 4: surface the Print toolbar entry when the
      // viewer's tools list opted into it. Today this is a basic
      // window.print() call; #132 (Print Template item type) will
      // upgrade it to a layout chooser.
      printEnabled={viewer.tools.includes('print')}
    />
  );
}

export const dynamic = 'force-dynamic';
