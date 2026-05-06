import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, AlertTriangle, FileText } from 'lucide-react';
import type {
  BasemapData,
  DataLayerData,
  DataLayerSublayer,
  EditorData,
  EditorTarget,
  Item,
  MapData,
  PickListData,
} from '@gratis-gis/shared-types';
import type { FormSchema } from '@gratis-gis/form-schema';
import type { CustomBasemap } from '@/lib/custom-basemap';
import { apiFetch, hasSession, publicApiFetch } from '@/lib/api';
import {
  buildEditorMapData,
  editorTargetLayerId,
  type ResolvedTarget,
} from '../../[id]/editor/build-map-data';
import { EditorRuntime } from '../../[id]/editor/editor-runtime';

interface Props {
  params: { id: string };
}

/**
 * Map a basemap item into the CustomBasemap shape MapCanvas
 * consumes. Same helper that survey/run/page.tsx and viewer/run/page.tsx
 * inline; extracting to a shared util when a fourth caller appears.
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
 * Loose shape we read off the form item. The form's `data` is a full
 * FormSchema (questions, title, schemaVersion) plus the form-app
 * specific fields layered on top. Keep this shape narrow so a future
 * schema bump doesn't crash this page.
 */
interface FormShape {
  /** v3 paired data_layer materialized for this form (#283). */
  linkedLayerId?: string;
  /** When the paired layer has multiple sublayers, the specific
   *  layer this form maps onto. Single-layer pairs omit this. */
  linkedLayerKey?: string;
  /** Schema fields used by the FormView side panel (#320). */
  schemaVersion?: number;
  questions?: FormSchema['questions'];
  title?: string;
}

/**
 * Implicit per-form Response Viewer (#321 / #320).
 *
 * Every Form item gets a built-in Response Viewer at
 * `/items/<formId>/responses` -- no separate Survey web_app item to
 * create, no extra configuration to bind. The form item's data has
 * everything we need: a paired data_layer (#283), a FormSchema for
 * the side panel (#320), and the linkedLayerKey when the pair is
 * multi-layer.
 *
 * The runtime mounts EditorRuntime with the FormView side panel
 * open by default (so the user lands on a recognizable response
 * renderer rather than a bare map). The separate Survey app item
 * (#260) still exists for power-users who want a saved, named,
 * shareable configuration with a specific reference map / toolbar /
 * default lookback window. This route is the zero-config default.
 *
 * Auth: ItemsService.get() on the API enforces visibility. Anonymous
 * public-share visitors land here too -- branch the fetch path the
 * same way Viewer / Survey do. Submissions are read-only by design,
 * so canEdit is forced false regardless of the caller's permissions.
 */
export default async function FormResponsesPage({ params }: Props) {
  const isAnonymous = !(await hasSession());
  const fetchItem = <T,>(path: string): Promise<T> =>
    isAnonymous
      ? publicApiFetch<T>(path.replace('/api/items/', '/api/public/items/'))
      : apiFetch<T>(path);
  const fetchItemList = <T,>(path: string): Promise<T> =>
    isAnonymous
      ? publicApiFetch<T>(path.replace('/api/items', '/api/public/items'))
      : apiFetch<T>(path);

  let formItem: Item<FormShape>;
  try {
    formItem = await fetchItem<Item<FormShape>>(`/api/items/${params.id}`);
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) notFound();
    throw err;
  }
  if (formItem.type !== 'form') notFound();

  const formData = (formItem.data ?? {}) as FormShape;

  // ---- Empty states ------------------------------------------------
  if (!formData.linkedLayerId) {
    return (
      <UnboundShell
        item={formItem}
        message="no paired data layer yet (this should auto-materialize on form save)"
      />
    );
  }

  // Resolve the paired data_layer + (if needed) pick the right
  // sublayer key. A multi-layer pair stores `linkedLayerKey`; a
  // single-layer pair omits it and we default to the first layer.
  let dataLayerItem: Item<DataLayerData> | null;
  try {
    dataLayerItem = await fetchItem<Item<DataLayerData>>(
      `/api/items/${formData.linkedLayerId}`,
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) {
      return (
        <UnboundShell
          item={formItem}
          message="paired data layer is missing or unreadable"
        />
      );
    }
    throw err;
  }
  const dlData = dataLayerItem.data as DataLayerData | undefined;
  let layerKey: string | null = null;
  if (dlData && dlData.version === 3) {
    if (formData.linkedLayerKey) {
      layerKey =
        dlData.layers.find((l) => l.id === formData.linkedLayerKey)?.id ??
        null;
    }
    if (!layerKey && dlData.layers.length > 0) {
      layerKey = dlData.layers[0]!.id;
    }
  }
  if (!layerKey) {
    return (
      <UnboundShell
        item={formItem}
        message="paired data layer has no readable sublayer"
      />
    );
  }

  // Forms without a geo question pair to a non-spatial table
  // (geometryType=null). Until the table-only mode lands (slice 2 of
  // docs/survey-runtime.md), route to an unbound shell so the user
  // gets a clear message instead of a broken map. The form-view
  // side panel still works in that mode; the table layout is what's
  // missing.
  const matchedSublayer =
    dlData && dlData.version === 3
      ? dlData.layers.find((l) => l.id === layerKey) ?? null
      : null;
  if (matchedSublayer && !matchedSublayer.geometryType) {
    return (
      <UnboundShell
        item={formItem}
        message="this form has no map question, so submissions can't be plotted (table-only response viewer is on the way)"
      />
    );
  }

  // Synthesize a read-only EditorData with one target = paired layer.
  const target: EditorTarget = {
    dataLayerId: dataLayerItem.id,
    layerKey,
    canCreate: false,
    canEditGeometry: false,
    canEditAttributes: false,
    canDelete: false,
    editableFields: [],
    rowScope: 'all',
    templates: [],
  };
  const editor: EditorData = {
    version: 1,
    targets: [target],
    // Implicit viewer ships the standard read-side toolbar: select
    // (so the user can pick a row to render through the form view) +
    // measure (handy on a response map). Print lands once #132 does.
    tools: ['select', 'measure'],
    snapping: { enabled: false, selfSnap: false, tolerancePx: 10 },
  };

  const [basemapItems, referencedMap] = await Promise.all([
    fetchItemList<Array<Item<BasemapData>>>('/api/items?type=basemap').catch(
      () => [] as Array<Item<BasemapData>>,
    ),
    // The implicit viewer doesn't carry a reference map of its own;
    // the future per-form Response Viewer config (#260 power-user
    // path) is what wires that up. Pass null here so EditorRuntime
    // builds the map from just the paired layer.
    Promise.resolve(null as Item<MapData> | null),
  ]);

  const basemaps: CustomBasemap[] = basemapItems
    .map(basemapItemToCustomBasemap)
    .filter((b): b is CustomBasemap => b !== null);

  const layer: DataLayerSublayer | null =
    dlData && dlData.version === 3
      ? dlData.layers.find((l) => l.id === layerKey) ?? null
      : null;
  const resolvedTargets: ResolvedTarget[] = [
    {
      dataLayerId: dataLayerItem.id,
      layerKey,
      layer,
      dataLayerTitle: dataLayerItem.title,
    },
  ];

  const { mapData, targetLayerIds } = buildEditorMapData({
    editor,
    referencedMap,
    resolvedTargets,
  });

  // Pick lists referenced by the paired layer's columns; same as
  // survey/run -- the form mirror writes coded VALUES, so the side
  // panel resolves them back to labels here.
  const pickListItemIds = new Set<string>();
  if (layer) {
    for (const f of layer.fields) {
      if (f.domain && f.domain.type === 'coded-value-ref') {
        pickListItemIds.add(f.domain.pickListItemId);
      }
    }
  }
  const pickListItems = await Promise.all(
    Array.from(pickListItemIds).map((id) =>
      fetchItem<Item<PickListData>>(`/api/items/${id}`).catch(() => null),
    ),
  );
  const pickLists: Record<string, PickListData> = {};
  for (const it of pickListItems) {
    if (it && it.data) pickLists[it.id] = it.data as PickListData;
  }

  // The form item's data IS a FormSchema (the designer writes the
  // entire schema there). Pass it through to the FormView side panel
  // so each selected feature renders as a proper form readout.
  const formViewSchema: FormSchema | null =
    formData && formData.questions
      ? (formItem.data as unknown as FormSchema)
      : null;
  const surveyTargetLayerId = editorTargetLayerId(dataLayerItem.id, layerKey);

  return (
    <EditorRuntime
      editorId={formItem.id}
      editorTitle={formItem.title}
      editor={editor}
      resolvedTargets={resolvedTargets}
      pickLists={pickLists}
      referencedMapTitle={null}
      initialMapData={mapData}
      targetLayerIds={targetLayerIds}
      basemaps={basemaps}
      canEdit={false}
      formViewSchema={formViewSchema}
      surveyTargetLayerId={surveyTargetLayerId}
      surveyAttachmentsLayerItemId={dataLayerItem.id}
      surveyAttachmentsLayerKey={layerKey}
      tableOpenDefault
    />
  );
}

/**
 * Empty-state shell used when the form is not fully configured.
 * Centralized so the "no paired layer / no sublayer / non-spatial"
 * branches all render identically and link back to the form's
 * detail page so the author can finish setup.
 */
function UnboundShell({
  item,
  message,
}: {
  item: { id: string; title: string };
  message: string;
}) {
  return (
    <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col bg-surface-0">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface-1 px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/items"
            className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink-0"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to items
          </Link>
          <span className="text-muted">/</span>
          <span className="inline-flex items-center gap-1.5 text-base font-semibold text-ink-0">
            <FileText className="h-4 w-4 text-orange-500" />
            {item.title}
          </span>
        </div>
        <Link
          href={`/items/${item.id}`}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-1 px-2 py-1 text-xs font-medium text-ink-1 hover:bg-surface-2"
        >
          Open form
        </Link>
      </header>
      <div className="flex flex-1 items-center justify-center p-10">
        <div className="max-w-md rounded-lg border border-dashed border-border bg-surface-1 p-8 text-center shadow-card">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-amber-50">
            <AlertTriangle className="h-5 w-5 text-amber-600" />
          </span>
          <h2 className="mt-3 text-base font-semibold text-ink-0">
            Responses not ready to render
          </h2>
          <p className="mt-2 text-sm text-muted">
            This form has {message}. Open{' '}
            <Link
              href={`/items/${item.id}`}
              className="text-accent hover:underline"
            >
              the form's page
            </Link>{' '}
            to finish setup or collect a first submission.
          </p>
        </div>
      </div>
    </div>
  );
}

export const dynamic = 'force-dynamic';
