import { notFound } from 'next/navigation';
import type {
  BasemapData,
  CustomAppData,
  DataLayerData,
  DataLayerSublayer,
  Item,
  MapData,
  MapLayer,
} from '@gratis-gis/shared-types';
import {
  DEFAULT_LAYER_ACCESS,
  DEFAULT_LAYER_INTERACTIONS,
  DEFAULT_LAYER_LABELS,
  DEFAULT_LAYER_POPUP,
  DEFAULT_LAYER_RENDERER,
  DEFAULT_LAYER_SCALE,
  DEFAULT_LAYER_SEARCH,
  DEFAULT_LAYER_STYLE,
  DEFAULT_MAP,
  DEFAULT_CUSTOM_APP,
  isCustomAppItem,
  readCustomAppData,
} from '@gratis-gis/shared-types';
import type { CustomBasemap } from '@/lib/custom-basemap';
import { apiFetch, hasSession, publicApiFetch } from '@/lib/api';
import { CustomRuntimeClient } from '../runtime-client';

interface Props {
  params: { id: string };
}

/**
 * Map a basemap item into the CustomBasemap shape MapCanvas
 * consumes. Same helper survey/run + viewer/run inline; extract
 * to a shared util when a fifth caller appears.
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
 * Custom Web App runtime (#261 / #341).
 *
 * Server entry: resolve the app's targets to MapLayer descriptors,
 * fetch basemaps, and hydrate the client runtime. The client
 * component does the actual widget rendering against bound map
 * state (CustomRuntimeClient).
 */
export default async function CustomAppRuntimePage({ params }: Props) {
  const isAnonymous = !(await hasSession());
  const fetchItem = <T,>(path: string): Promise<T> =>
    isAnonymous
      ? publicApiFetch<T>(path.replace('/api/items/', '/api/public/items/'))
      : apiFetch<T>(path);
  const fetchItemList = <T,>(path: string): Promise<T> =>
    isAnonymous
      ? publicApiFetch<T>(path.replace('/api/items', '/api/public/items'))
      : apiFetch<T>(path);

  let item: Item<unknown>;
  try {
    item = await fetchItem<Item<unknown>>(`/api/items/${params.id}`);
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) notFound();
    throw err;
  }
  if (!isCustomAppItem(item)) notFound();

  const app: CustomAppData = {
    ...DEFAULT_CUSTOM_APP,
    ...((readCustomAppData(item) ?? {}) as Partial<CustomAppData>),
  };

  // Resolve targets to MapLayer descriptors. Each target points at a
  // v3 data_layer sublayer; we look up the layer item, find the
  // matching sublayer, and build a MapLayer that reads features via
  // the per-sublayer geojson endpoint. Targets pointing at deleted
  // / unreadable layers get silently dropped; the runtime renders
  // whatever survives.
  const resolvedTargets: Array<{
    dataLayerId: string;
    layerKey: string;
    title: string;
    mapLayer: MapLayer;
  }> = [];
  for (const t of app.targets) {
    let layerItem: Item<DataLayerData> | null = null;
    try {
      layerItem = await fetchItem<Item<DataLayerData>>(
        `/api/items/${t.dataLayerId}`,
      );
    } catch {
      continue;
    }
    if (!layerItem) continue;
    const dlData = layerItem.data as DataLayerData | undefined;
    if (!dlData || dlData.version !== 3) continue;
    const sub: DataLayerSublayer | undefined = dlData.layers.find(
      (l) => l.id === t.layerKey,
    );
    if (!sub || !sub.geometryType) continue;
    const id = `custom-target:${t.dataLayerId}:${t.layerKey}`;
    const url = `/api/portal/items/${t.dataLayerId}/layers/${t.layerKey}/geojson`;
    resolvedTargets.push({
      dataLayerId: t.dataLayerId,
      layerKey: t.layerKey,
      title: `${layerItem.title} / ${sub.label}`,
      mapLayer: {
        id,
        title: `${layerItem.title} / ${sub.label}`,
        visible: true,
        opacity: 1,
        source: { kind: 'geojson-url', url },
        style: DEFAULT_LAYER_STYLE,
        renderer: DEFAULT_LAYER_RENDERER,
        popup: DEFAULT_LAYER_POPUP,
        interactions: DEFAULT_LAYER_INTERACTIONS,
        labels: DEFAULT_LAYER_LABELS,
        search: DEFAULT_LAYER_SEARCH,
        filter: null,
        scale: DEFAULT_LAYER_SCALE,
        access: DEFAULT_LAYER_ACCESS,
      },
    });
  }

  // Fetch the org's basemaps (for MapCanvas's basemap library +
  // BasemapGallery) and the optional reference map (for viewport +
  // base layers + basemap default).
  const [basemapItems, referencedMap] = await Promise.all([
    fetchItemList<Array<Item<BasemapData>>>('/api/items?type=basemap').catch(
      () => [] as Array<Item<BasemapData>>,
    ),
    app.mapId
      ? fetchItem<Item<MapData>>(`/api/items/${app.mapId}`).catch(() => null)
      : Promise.resolve(null as Item<MapData> | null),
  ]);

  const basemaps: CustomBasemap[] = basemapItems
    .map(basemapItemToCustomBasemap)
    .filter((b): b is CustomBasemap => b !== null);

  // Build the base MapData every Map widget starts from. Inherits
  // basemap + viewport + non-target layers from the referenced map
  // when set, falls through to DEFAULT_MAP otherwise. Then appends
  // every resolved target layer so a fresh app with one Map widget
  // shows its targets right away.
  const baseLayers = referencedMap?.data?.layers ?? [];
  const baseMapData: MapData = {
    ...(referencedMap?.data ?? DEFAULT_MAP),
    layers: [...baseLayers, ...resolvedTargets.map((t) => t.mapLayer)],
  };

  return (
    <CustomRuntimeClient
      itemId={item.id}
      itemTitle={item.title}
      app={app}
      basemaps={basemaps}
      baseMapData={baseMapData}
      resolvedTargets={resolvedTargets}
    />
  );
}

export const dynamic = 'force-dynamic';
