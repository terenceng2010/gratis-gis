import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, AlertTriangle, FileText, Hammer } from 'lucide-react';
import type {
  BasemapData,
  DataLayerData,
  DataLayerSublayer,
  EditorData,
  EditorTarget,
  Item,
  MapData,
  PickListData,
  SurveyData,
} from '@gratis-gis/shared-types';
import {
  DEFAULT_SURVEY,
  isSurveyItem,
  readSurveyData,
} from '@gratis-gis/shared-types';
import type { FormSchema } from '@gratis-gis/form-schema';
import type { CustomBasemap } from '@/lib/custom-basemap';
import { apiFetch, hasSession, publicApiFetch } from '@/lib/api';
import {
  buildEditorMapData,
  editorTargetLayerId,
  type ResolvedTarget,
} from '../../editor/build-map-data';
import { EditorRuntime } from '../../editor/editor-runtime';

interface Props {
  params: { id: string };
}

/**
 * Map a basemap item into the CustomBasemap shape MapCanvas
 * consumes. Mirrors the helper in viewer/run/page.tsx; the third
 * caller (here) makes it worth extracting to a shared util in a
 * follow-up commit, but inlining for now to keep the slice small.
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
 * Tiny structural shape we read off the bound form item. Avoids
 * pulling in the entire @gratis-gis/form-schema FormSchema type
 * just to dereference a couple of fields. Keep it loose; the form
 * type is a moving target and a runtime that breaks every time a
 * field is added is not the right blast radius.
 */
interface FormShape {
  /** v3 paired data_layer materialized for this form (#283). */
  linkedLayerId?: string;
  /** When the paired layer has multiple sublayers, the specific
   *  layer this form maps onto. Single-layer pairs omit this. */
  linkedLayerKey?: string;
  /** Schema fields used by the FormView side panel (#320). The form
   *  item's `data` is a full FormSchema; we read the same fields back
   *  out here without restating the entire question union locally. */
  schemaVersion?: number;
  questions?: FormSchema['questions'];
  title?: string;
}

/**
 * Survey Response Viewer runtime (#260).
 *
 * Browses a paired form's submissions on a map. The detail page
 * binds a Survey app to a single form item; on every render we
 * resolve that form -> its `linkedLayerId` (the data_layer materialized
 * by #283) -> the EditorRuntime substrate we already use for Viewer
 * and Editor.
 *
 * Today the runtime is read-only and renders the paired layer with
 * the toolbar opted into by the Survey config. Form-shaped popups,
 * date-range filter chips, and submitter hiding land in follow-up
 * slices on top of EditorRuntime; isolating them there means the
 * three template runtimes (editor / viewer / survey) keep sharing
 * one canvas and one render path.
 *
 * Auth: ItemsService.get() on the API enforces visibility (404 on
 * not-found-or-not-allowed). canEdit is forced to false for surveys
 * by definition; "view responses, never edit a submission".
 */
export default async function SurveyRuntimePage({ params }: Props) {
  // #307 carry-over: anonymous public-share visitors land here too,
  // so branch the fetch path the same way Viewer does. The middleware
  // allowlist for /items/.../survey/run was added alongside the
  // Survey scaffolding in the previous commit.
  const isAnonymous = !(await hasSession());
  const fetchItem = <T,>(path: string): Promise<T> =>
    isAnonymous
      ? publicApiFetch<T>(path.replace('/api/items/', '/api/public/items/'))
      : apiFetch<T>(path);
  const fetchItemList = <T,>(path: string): Promise<T> =>
    isAnonymous
      ? publicApiFetch<T>(path.replace('/api/items', '/api/public/items'))
      : apiFetch<T>(path);

  let surveyItem: Item<unknown>;
  try {
    surveyItem = await fetchItem<Item<unknown>>(`/api/items/${params.id}`);
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) notFound();
    throw err;
  }
  if (!isSurveyItem(surveyItem)) notFound();

  const survey: SurveyData = {
    ...DEFAULT_SURVEY,
    ...((readSurveyData(surveyItem) ?? {}) as Partial<SurveyData>),
  };

  // ---- Empty states ------------------------------------------------
  // Author hasn't bound a form yet: render a "go finish setup" panel
  // pointing back at the configuration page. Reuses the same shell as
  // the runtime so chrome stays consistent.
  if (!survey.formId) {
    return <UnboundShell item={surveyItem} message="no form bound yet" />;
  }

  // Resolve the form. A 404 here means the form was deleted or is
  // unreadable; fall back to the unbound shell with a slightly
  // different message so the author has a clue.
  let formItem: Item<FormShape> | null = null;
  try {
    formItem = await fetchItem<Item<FormShape>>(
      `/api/items/${survey.formId}`,
    );
  } catch (err) {
    if (!(err instanceof Error && err.message.includes('404'))) throw err;
  }
  if (!formItem) {
    return (
      <UnboundShell
        item={surveyItem}
        message="bound form is missing or unreadable"
      />
    );
  }
  const formData = (formItem.data ?? {}) as FormShape;
  if (!formData.linkedLayerId) {
    return (
      <UnboundShell
        item={surveyItem}
        message="bound form has no paired data layer yet"
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
          item={surveyItem}
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
        dlData.layers.find((l) => l.id === formData.linkedLayerKey)?.id ?? null;
    }
    if (!layerKey && dlData.layers.length > 0) {
      layerKey = dlData.layers[0]!.id;
    }
  }
  if (!layerKey) {
    return (
      <UnboundShell
        item={surveyItem}
        message="paired data layer has no readable sublayer"
      />
    );
  }

  // Forms without a geo question pair to a non-spatial table
  // (geometryType=null). The Survey runtime renders submissions on a
  // map, so a table-only paired layer has nothing to draw. Detect and
  // route to an empty-state shell instead of letting MapCanvas /
  // EditorRuntime trip on the missing geometry. A future slice can
  // grow a map-less attribute-table-only mode for this case.
  const matchedSublayer =
    dlData && dlData.version === 3
      ? dlData.layers.find((l) => l.id === layerKey) ?? null
      : null;
  if (matchedSublayer && !matchedSublayer.geometryType) {
    return (
      <UnboundShell
        item={surveyItem}
        message="bound form has no map question, so submissions can't be plotted"
      />
    );
  }

  // Synthesize an EditorData with one read-only target = paired
  // data_layer. Tools list maps the survey's read-side affordances
  // onto EditorRuntime's overlapping options the same way Viewer
  // does. Print is a separate prop on EditorRuntime.
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
  const passthrough: Array<'select' | 'measure'> = [];
  if (survey.tools.includes('select')) passthrough.push('select');
  if (survey.tools.includes('measure')) passthrough.push('measure');
  const editor: EditorData = {
    version: 1,
    targets: [target],
    tools: passthrough,
    snapping: { enabled: false, selfSnap: false, tolerancePx: 10 },
  };
  if (survey.mapId) editor.mapId = survey.mapId;

  const [basemapItems, referencedMap] = await Promise.all([
    fetchItemList<Array<Item<BasemapData>>>('/api/items?type=basemap').catch(
      () => [] as Array<Item<BasemapData>>,
    ),
    editor.mapId
      ? fetchItem<Item<MapData>>(`/api/items/${editor.mapId}`).catch(
          () => null,
        )
      : Promise.resolve(null),
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

  // Pick lists referenced by the paired layer's columns. Same shape
  // the Viewer fetches; submissions ingested through the form mirror
  // already write picklist VALUES (not the labels), so the popup
  // resolves them by looking up the pick_list item here.
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

  // #320: hand the FormView side panel a real schema + the synthesized
  // target-layer id (the runtime has the layer under that id, not the
  // raw paired data_layer id). Reading off formItem.data: the form
  // item stores its full FormSchema there, so we can pass it through
  // without an extra fetch.
  const formViewSchema: FormSchema | null =
    formItem && formItem.data && (formItem.data as { questions?: unknown }).questions
      ? (formItem.data as unknown as FormSchema)
      : null;
  const surveyTargetLayerId = editorTargetLayerId(dataLayerItem.id, layerKey);

  return (
    <EditorRuntime
      editorId={surveyItem.id}
      editorTitle={surveyItem.title}
      editor={editor}
      resolvedTargets={resolvedTargets}
      pickLists={pickLists}
      referencedMapTitle={referencedMap?.title ?? null}
      initialMapData={mapData}
      targetLayerIds={targetLayerIds}
      basemaps={basemaps}
      canEdit={false}
      printEnabled={survey.tools.includes('print')}
      formViewSchema={formViewSchema}
      surveyTargetLayerId={surveyTargetLayerId}
      surveyAttachmentsLayerItemId={dataLayerItem.id}
      surveyAttachmentsLayerKey={layerKey}
    />
  );
}

/**
 * Empty-state shell used when the survey is not fully configured.
 * Centralized so the three "no form / no paired layer / no sublayer"
 * branches all render identically.
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
          Configure
        </Link>
      </header>
      <div className="flex flex-1 items-center justify-center p-10">
        <div className="max-w-md rounded-lg border border-dashed border-border bg-surface-1 p-8 text-center shadow-card">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-amber-50">
            {message.includes('paired') ? (
              <AlertTriangle className="h-5 w-5 text-amber-600" />
            ) : (
              <Hammer className="h-5 w-5 text-amber-600" />
            )}
          </span>
          <h2 className="mt-3 text-base font-semibold text-ink-0">
            Survey not ready to render
          </h2>
          <p className="mt-2 text-sm text-muted">
            This survey app has {message}. Head back to{' '}
            <Link
              href={`/items/${item.id}`}
              className="text-accent hover:underline"
            >
              the configuration page
            </Link>{' '}
            to finish setup.
          </p>
        </div>
      </div>
    </div>
  );
}

export const dynamic = 'force-dynamic';
