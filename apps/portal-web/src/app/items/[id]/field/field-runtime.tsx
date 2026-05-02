'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  Check,
  CircleSlash,
  CloudDownload,
  CloudOff,
  ClipboardList,
  Crosshair,
  Eye,
  EyeOff,
  Layers,
  Loader2,
  LocateFixed,
  MapPin,
  MoreVertical,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Wifi,
  X,
} from 'lucide-react';
import maplibregl from 'maplibre-gl';
import type {
  FeatureField,
  LayerGeometryType,
  MapData,
  MapLayer,
  MapLayerRenderer,
  PickListData,
} from '@gratis-gis/shared-types';
import {
  generateFormFromLayer,
  type FormSchema,
  type Question,
  type Response as FormResponse,
} from '@gratis-gis/form-schema';
import type { CustomBasemap } from '@/lib/custom-basemap';
import { MapCanvas, type MapCanvasHandle } from '../map/map-canvas';
import { FormRuntime } from '@/components/form-runtime';
import { PwaInstallButton } from '@/components/pwa-install-button';
import {
  deleteDeployment,
  enqueueRecord,
  formatBytes,
  getDeployment,
  hashLayerSchema,
  listFeaturesForLayer,
  listPickListsForDeployment,
  listQueue,
  putFeatures,
  type CachedDeployment,
  type CachedFeature,
  type QueueRecord,
} from '@/lib/offline-store';
import { newGlobalId, syncQueue, type SyncResult } from '@/lib/offline-sync';
import {
  downloadDeployment,
  type DownloadLayer,
  type DownloadProgress,
} from '@/lib/offline-download';
import {
  checkDownloadFits,
  estimateStorage,
  isPersistent,
  requestPersistentStorage,
  type StorageEstimate,
} from '@/lib/offline-storage-quota';
import {
  clearTileCache,
  readTileCacheStats,
} from '@/lib/offline-tile-warmer';
import {
  postQueueManifest,
  postQueueManifestThrottled,
} from '@/lib/offline-queue-beacon';
import {
  useGeolocation,
  gpsAccuracyBand,
  type GpsPosition,
} from './use-geolocation';
import { createGpsMarker, type GpsMarkerHandle } from './gps-map-marker';
import { stampGpsMetadata } from './gps-metadata-stamp';
import { V3FeatureAttachments } from '../data-layer/v3-feature-attachments';

/**
 * Per-layer descriptor the field runtime consumes. Server-built (see
 * field/page.tsx) so the client lands ready to render. boundFormItemId
 * is set when the data_collection has an explicit form binding for
 * this layer; otherwise the runtime falls through to schema-derived
 * forms via generateFormFromLayer (Slice 1).
 */
export interface EditableLayer {
  /** data_layer item id this sublayer belongs to. */
  dataLayerId: string;
  /** data_layer item title (shown in the layer picker as a parent label). */
  dataLayerTitle: string;
  /** v3 sublayer id; matches MapLayerSource.layerKey for the
   *  corresponding map layer. */
  layerKey: string;
  /** Sublayer label; the runtime's primary on-screen identifier. */
  layerLabel: string;
  /** Sublayer geometry type; null = table (filtered out at the page
   *  level for Slice 2). */
  geometryType: Exclude<LayerGeometryType, null>;
  fields: FeatureField[];
  editingPolicy: 'all-rows' | 'own-rows-only';
  /** Optional explicit form binding from the data_collection's
   *  formBindings map. When absent, an auto-form is generated. */
  boundFormItemId?: string;
  /** Phase C: child layers (within the same data_layer item) that
   *  reference this layer via parentFkColumn. Lets the FormModal
   *  surface "Add related" buttons in edit mode so a user can drop
   *  child records under the current feature without having to find
   *  the child layer in the picker. Only children whose layerKey
   *  also appears in editableLayers should get a wired Add button --
   *  others are visible as descriptive lines but Add is disabled. */
  childLayers?: Array<{
    layerKey: string;
    layerLabel: string;
    geometryType: LayerGeometryType;
    parentFkColumn: string;
  }>;
}

interface Props {
  dataCollectionId: string;
  title: string;
  mapData: MapData;
  mapTitle: string;
  basemaps: CustomBasemap[];
  editableLayers: EditableLayer[];
  pickLists: Record<string, PickListData>;
  /** Pre-fetched bound form schemas keyed by form item id. */
  boundForms: Record<string, FormSchema>;
  currentUserId: string;
}

/**
 * One row in the field-mode template picker. Field Maps' equivalent
 * of an "editing template" -- a (layer, symbology class) pair that
 * can be added with one tap, with the categorical attribute already
 * pre-filled. Derived from each editable layer's MapLayer renderer
 * at runtime:
 *
 *   - simple renderer    -> one template per layer, no preset
 *                            attributes (color from the simple style)
 *   - unique-values      -> one template per category, presetAttributes
 *                            sets the renderer's `field` to the
 *                            category's `value` so the form opens
 *                            with that field already populated
 *   - class-breaks       -> not yet templated; collapses to one
 *                            "Add to this layer" template (numeric
 *                            ranges aren't classifications you'd
 *                            pre-fill at create time)
 */
interface FieldTemplate {
  /** Stable id, unique within the runtime. Used as React key + as the
   *  active-template handle. */
  id: string;
  layer: EditableLayer;
  /** Display label: "<class>" for unique-values, "<layer label>" for
   *  simple. */
  label: string;
  /** Subtitle shown beneath the label: layer name for unique-values
   *  templates, or the data_layer title for simple ones. */
  sublabel: string;
  /** Color swatch matching how this class renders on the map. */
  color: string;
  /**
   * Attribute name -> value to pre-fill on add. Empty when the layer
   * uses a simple renderer; for unique-values, the renderer's `field`
   * is keyed to the category's value. The form modal merges these
   * into the FormRuntime's `initial` response.
   */
  presetAttributes: Record<string, string>;
}

/**
 * Field Maps Slice 3 runtime.
 *
 * Phone-friendly canvas around MapCanvas with the Field Maps drop-at-
 * crosshair workflow:
 *
 *   - The user taps "Add Feature" to open a template sheet listing
 *     every (editable layer, symbology class) pair derived from the
 *     bound map's renderers. Each row shows a colored swatch matching
 *     the layer's render style so the picker reads visually like the
 *     map itself.
 *   - Selecting a template arms add-mode: a centered crosshair
 *     reticle appears on the map, and the footer changes to show the
 *     chosen template plus an "Add at center" commit button. The
 *     user pans the map to position; "Add at center" drops a feature
 *     at the map's current center (or the GPS position, when
 *     available) and opens the form pre-filled with the template's
 *     presetAttributes.
 *   - Tapping an existing feature on an editable layer opens the
 *     form in edit mode regardless of armed state -- editing is
 *     always available; armed state only changes what tapping
 *     EMPTY map space does.
 *
 * Plus a session-local layer-visibility panel: collectors can toggle
 * layers off without modifying the bound map (toggles reset on next
 * deployment open, matching Field Maps' behaviour).
 *
 * Slice 2 (#193) shipped the canvas + form modal + tap-to-edit /
 * tap-to-add. Slice 3 (#195) replaces the dropdown picker with the
 * symbology-driven template sheet, switches the gesture to drop-at-
 * crosshair, and adds the layer toggle. Offline / sync remain Slice
 * 4-5 territory; line + polygon draw still need a multi-step gesture
 * and ride along with terra-draw integration.
 */
export function FieldRuntime({
  dataCollectionId,
  title,
  mapData,
  mapTitle,
  basemaps,
  editableLayers,
  pickLists,
  boundForms,
  currentUserId,
}: Props) {
  // Where the back arrow goes. Defaults to the deployment's item
  // detail page (admin / desktop flow); when the user came from the
  // /field catalog, we honor that with ?from=field on the deep link.
  // Persisted to sessionStorage so subsequent in-app nav within the
  // runtime (e.g. Add Layer dialog reopening this page) keeps the
  // mobile-correct destination instead of falling back to item-
  // detail. Cleared on next visit when ?from is absent.
  const searchParams = useSearchParams();
  const backHref = useMemo(() => {
    if (typeof window === 'undefined') return `/items/${dataCollectionId}`;
    const fromParam = searchParams?.get('from');
    const key = `gratis:field:back:${dataCollectionId}`;
    if (fromParam === 'field') {
      try {
        window.sessionStorage.setItem(key, '/field');
      } catch {
        /* private browsing etc -- best effort */
      }
      return '/field';
    }
    try {
      const stored = window.sessionStorage.getItem(key);
      if (stored) return stored;
    } catch {
      /* ignore */
    }
    return `/items/${dataCollectionId}`;
  }, [dataCollectionId, searchParams]);

  // The active template: which (layer, symbology class) pair is armed
  // for add-mode. null = no armed template (the user hasn't picked
  // anything from the picker yet, or just cancelled).
  const [activeTemplate, setActiveTemplate] = useState<FieldTemplate | null>(
    null,
  );

  // Whether the template-picker bottom sheet is open. Separate state
  // from `activeTemplate` so the user can re-open the sheet to swap
  // their armed selection without having to "cancel" first.
  const [pickerOpen, setPickerOpen] = useState(false);

  // Layer-toggle panel state. Visibility overrides keyed by MapLayer.id
  // (NOT the v3 sublayer key). Session-local: toggling a layer off
  // hides it for this open of the deployment but doesn't touch the
  // bound map item. Reopening the deployment shows the original
  // visibility from MapData. Matches Field Maps.
  const [layerPanelOpen, setLayerPanelOpen] = useState(false);
  const [hiddenLayerIds, setHiddenLayerIds] = useState<Set<string>>(
    () => new Set(),
  );

  // Form modal state. mode='add' starts with the template's
  // presetAttributes plus a geometry stamped from the map center;
  // mode='edit' pre-fills from the tapped feature's properties.
  const [formModal, setFormModal] = useState<
    | null
    | {
        layer: EditableLayer;
        mode: 'add';
        geometry: GeoJSON.Geometry | null;
        presetAttributes: Record<string, string>;
      }
    | {
        layer: EditableLayer;
        mode: 'edit';
        featureId: string;
        properties: Record<string, unknown>;
        geometry: GeoJSON.Geometry | null;
      }
  >(null);

  const canvasRef = useRef<MapCanvasHandle | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // GPS state (Phase A). Hook owns the watch lifecycle and follow-mode
  // toggle; marker handle paints the dot + accuracy ring on the map and
  // is created on first map-ready. The two are intentionally
  // decoupled: the hook updates the marker only when the map has
  // mounted (the GPS dot doesn't need to render before the map does).
  const gps = useGeolocation();
  const gpsMarkerRef = useRef<GpsMarkerHandle | null>(null);
  // Temporary preview marker shown while the add-form is open. Held
  // by ref (not state) so we don't re-render the whole canvas when
  // the marker comes and goes; maplibre's Marker primitive plants
  // an HTML node directly. Cleared on form close (cancel OR save).
  const pendingMarkerRef = useRef<maplibregl.Marker | null>(null);

  const clearPendingMarker = useCallback(() => {
    if (pendingMarkerRef.current) {
      pendingMarkerRef.current.remove();
      pendingMarkerRef.current = null;
    }
  }, []);

  // Online/offline detection. navigator.onLine is the simplest
  // signal; combined with online/offline events it covers the
  // typical "connection dropped" path. We default to online during
  // SSR-fallback (typeof navigator !== 'undefined' check), then
  // re-evaluate on mount.
  const [isOnline, setIsOnline] = useState(true);
  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    setIsOnline(navigator.onLine);
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  // Tier 4 beacon: post a queue manifest on mount so the admin view
  // sees a fresh row every time a worker opens the runtime. The
  // helper is throttled internally; subsequent calls (after sync, on
  // online-flip) won't double-post inside the same window. See
  // docs/field-offline-areas.md.
  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    if (!navigator.onLine) return;
    void postQueueManifestThrottled();
  }, []);

  // Cached-deployment manifest. Loaded once on mount; refreshed
  // after a successful download. Drives the "cached on <date>" pill
  // and the offline-data substitution path below.
  const [cachedDeployment, setCachedDeployment] =
    useState<CachedDeployment | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const d = await getDeployment(dataCollectionId);
        if (!cancelled) setCachedDeployment(d);
      } catch {
        /* IndexedDB unavailable (private mode + Safari pre-15.4):
           swallow; the runtime stays online-only without surfacing
           an error. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dataCollectionId]);

  // Offline feature substitution. When the user is offline AND we
  // have a cached manifest, swap each editable data-layer source
  // for an inline GeoJSON FeatureCollection sourced from IndexedDB.
  // MapCanvas already handles `geojson-inline` natively, so the
  // canvas renders cached features without any service-worker
  // interception path. Loaded asynchronously per layer; results
  // are keyed by `<itemId>:<layerKey>`.
  const [offlineFeatures, setOfflineFeatures] = useState<
    Record<string, GeoJSON.FeatureCollection>
  >({});
  // Slice 5 state: declared early so the offlineFeatures useEffect
  // can list it as a dep (and re-read after offline writes / sync).
  // The runSync callback + auto-sync effect that consume these live
  // further down with the other Slice 5 logic.
  const [offlineWriteCounter, setOfflineWriteCounter] = useState(0);
  const [queueCount, setQueueCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncResult, setLastSyncResult] = useState<SyncResult | null>(null);
  useEffect(() => {
    if (isOnline || !cachedDeployment) {
      // Online: don't bother loading inline data. The MapCanvas
      // will keep fetching the URL-backed source.
      setOfflineFeatures({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const out: Record<string, GeoJSON.FeatureCollection> = {};
      for (const layer of editableLayers) {
        try {
          const features = await listFeaturesForLayer(
            dataCollectionId,
            layer.dataLayerId,
            layer.layerKey,
          );
          out[`${layer.dataLayerId}:${layer.layerKey}`] = {
            type: 'FeatureCollection',
            features,
          };
        } catch {
          /* missing per-layer cache: leave undefined; MapCanvas
             will render an empty source for that layer offline */
        }
      }
      if (!cancelled) setOfflineFeatures(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    isOnline,
    cachedDeployment,
    editableLayers,
    dataCollectionId,
    // Slice 5: re-read after every offline write so the new / updated
    // feature appears on the map without a manual reload. Same dep
    // shape works for sync completion (the runner bumps the counter).
    offlineWriteCounter,
  ]);

  // Field-mode basemap override (#223.8). Per-session selection
  // surfaced via the layer list's basemap chip. null = honor the
  // map item's authored basemap; otherwise the override id wins
  // and effectiveMapData injects it at render time. Resets on
  // navigation away (state lives on the runtime), so a new field
  // session falls back to the authored basemap until the user
  // picks one again.
  const [basemapOverrideId, setBasemapOverrideId] = useState<string | null>(
    null,
  );

  // Effective MapData: visibility overrides + offline source
  // substitution + per-session basemap swap. Each transform composes:
  // visibility (off when hiddenLayerIds includes the layer),
  // offline substitution (when offline + cached + the source has an
  // inline FC available), and basemap (when the user has picked one
  // via the layer panel chip).
  const effectiveMapData = useMemo<MapData>(() => {
    const offlineActive = !isOnline && Object.keys(offlineFeatures).length > 0;
    const basemapOverride =
      basemapOverrideId && basemapOverrideId !== mapData.basemap
        ? basemapOverrideId
        : null;
    if (hiddenLayerIds.size === 0 && !offlineActive && !basemapOverride) {
      return mapData;
    }
    return {
      ...mapData,
      ...(basemapOverride ? { basemap: basemapOverride } : {}),
      layers: mapData.layers.map((l) => {
        let next: MapLayer = l;
        if (hiddenLayerIds.has(l.id)) {
          next = { ...next, visible: false };
        }
        if (offlineActive && next.source?.kind === 'data-layer') {
          const key = `${next.source.itemId}:${next.source.layerKey ?? ''}`;
          // Try with an empty layerKey first (legacy v1/v2), then
          // with the layerKey when present.
          const fc =
            offlineFeatures[`${next.source.itemId}:${next.source.layerKey ?? ''}`] ??
            (next.source.layerKey
              ? offlineFeatures[`${next.source.itemId}:${next.source.layerKey}`]
              : undefined);
          if (fc) {
            next = {
              ...next,
              source: { kind: 'geojson-inline', geojson: fc },
            };
          }
          // If no cached FC, fall through to the original source.
          // It'll fail to fetch offline, but MapCanvas tolerates
          // that (empty source) and the user sees an empty layer
          // rather than a broken canvas.
          void key;
        }
        return next;
      }),
    };
  }, [mapData, hiddenLayerIds, isOnline, offlineFeatures, basemapOverrideId]);

  // Effective pickLists. When offline, pick from IndexedDB instead of
  // the prop so newly-added pick lists from the download cache work.
  const [offlinePickLists, setOfflinePickLists] =
    useState<Record<string, PickListData>>({});
  useEffect(() => {
    if (isOnline || !cachedDeployment) {
      setOfflinePickLists({});
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const cached = await listPickListsForDeployment(dataCollectionId);
        if (!cancelled) setOfflinePickLists(cached);
      } catch {
        /* swallow */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOnline, cachedDeployment, dataCollectionId]);
  const effectivePickLists = useMemo(
    () => (isOnline ? pickLists : { ...pickLists, ...offlinePickLists }),
    [isOnline, pickLists, offlinePickLists],
  );

  // Download flow state. Null = no active download; non-null = in
  // progress. The progress object is rendered in a small modal so
  // the user sees per-layer status as the run completes.
  const [downloadProgress, setDownloadProgress] =
    useState<DownloadProgress | null>(null);

  // Slice 5 (queue + sync; see docs/field-offline-recovery.md).
  // State declarations are higher up next to offlineFeatures so the
  // useEffect there can include them as deps. The pieces below own
  // the runner + auto-sync wiring.
  // Throttle handle so back-to-back online/offline flips (Wi-Fi
  // flapping while a worker walks past a building corner) don't
  // schedule N parallel syncs.
  const lastSyncAttemptRef = useRef<number>(0);

  // Refresh the queue count whenever something might have changed it:
  // an offline write added a record, a sync run drained records, the
  // user re-opened the page after an offline session. Polling the
  // queue store on these dep changes is cheap (the read is keyed by
  // deployment) and avoids a separate event bus.
  useEffect(() => {
    void (async () => {
      const records = await listQueue(dataCollectionId);
      setQueueCount(records.length);
    })();
  }, [dataCollectionId, offlineWriteCounter, lastSyncResult]);

  // The actual sync runner. Wrapped in a callback so both the
  // online-flip auto-trigger and the manual button share the same
  // path (and so the throttle ref is honoured uniformly).
  const runSync = useCallback(
    async (reason: 'auto' | 'manual') => {
      // 5-second throttle: the network can flap on/off many times in
      // quick succession at the edge of coverage. We don't want to
      // start a fresh sync each flip; the second flip's records will
      // be picked up by the running sync's queue read.
      const now = Date.now();
      if (reason === 'auto' && now - lastSyncAttemptRef.current < 5000) {
        return;
      }
      lastSyncAttemptRef.current = now;
      setSyncing(true);
      try {
        const result = await syncQueue(dataCollectionId);
        setLastSyncResult(result);
        // After a successful sync the live API reflects the queued
        // edits; refresh every editable layer's source so the user
        // sees the post-sync state on the map. Skip when offline (the
        // refresh would 500). The bump to offlineWriteCounter also
        // forces the cached-features read to re-run, which keeps the
        // offline GeoJSON path consistent if the user goes back
        // offline immediately after.
        if (typeof navigator !== 'undefined' && navigator.onLine) {
          for (const ml of mapData.layers ?? []) {
            const source = ml.source;
            if (source?.kind !== 'data-layer') continue;
            canvasRef.current?.refreshLayerSource(ml.id);
          }
        }
        setOfflineWriteCounter((n) => n + 1);
        // Beacon after every sync run so the admin view's row
        // reflects the post-sync queue depth (often zero, which is
        // exactly the signal admins want to see). Throttled, so the
        // mount-time + sync-time + online-flip beacons coalesce.
        void postQueueManifestThrottled();
      } finally {
        setSyncing(false);
      }
    },
    [dataCollectionId, mapData.layers],
  );

  // Auto-sync when isOnline flips from false -> true. Captured via a
  // ref so we don't fire on the initial mount when isOnline starts
  // true and there's nothing queued (the queue read is cheap but
  // pointless).
  const wasOnlineRef = useRef(isOnline);
  useEffect(() => {
    if (!wasOnlineRef.current && isOnline) {
      void runSync('auto');
    }
    wasOnlineRef.current = isOnline;
  }, [isOnline, runSync]);

  // Slice 6 (persistence floor; see docs/field-offline-areas.md):
  // surface whether the browser will keep our IndexedDB across
  // disk-pressure events, and how much storage we're using vs the
  // origin's quota. Both are read on mount and refreshed whenever
  // the cached deployment changes (downloads + cache writes shift
  // usage). The persistence prompt itself fires inside startDownload
  // so the user sees it as a follow-up to the click, not a cold
  // landing ambush.
  const [persistentState, setPersistentState] = useState<
    'unknown' | 'persistent' | 'best-effort'
  >('unknown');
  const [storage, setStorage] = useState<StorageEstimate | null>(null);
  // Slice 10 polish: tile-cache breakdown surfaced separately from
  // total IndexedDB usage so a user can answer "what's eating my
  // quota" without guessing. Null = no SW (dev mode, browsers
  // without SW support); the panel hides the row in that case.
  const [tileCache, setTileCache] = useState<{
    count: number;
    bytes: number;
  } | null>(null);
  useEffect(() => {
    void (async () => {
      const [persisted, est, tiles] = await Promise.all([
        isPersistent(),
        estimateStorage(),
        readTileCacheStats(),
      ]);
      setPersistentState(persisted ? 'persistent' : 'best-effort');
      setStorage(est);
      setTileCache(tiles);
    })();
  }, [cachedDeployment]);

  // Refresh tile-cache stats on demand (after download, after
  // clear). Wrapped as a callback so the LayerVisibilityPanel can
  // call it from its "Clear tiles" affordance.
  const refreshTileCacheStats = useCallback(async () => {
    const tiles = await readTileCacheStats();
    setTileCache(tiles);
    const est = await estimateStorage();
    setStorage(est);
  }, []);

  const startDownload = useCallback(async () => {
    if (downloadProgress?.phase && downloadProgress.phase !== 'done' &&
        downloadProgress.phase !== 'failed') {
      return; // already running
    }
    // Slice 6 step 1: ask the browser to mark our origin's storage
    // as "important" before any bytes land in IndexedDB. The prompt
    // reads as natural follow-up to the user's Download click; if
    // they deny, the download still proceeds, just with reduced
    // resilience. Sets persistentState immediately so the badge in
    // the header reflects the user's choice without a refresh.
    const persistResult = await requestPersistentStorage();
    setPersistentState(persistResult.persistent ? 'persistent' : 'best-effort');

    // Slice 6 step 2: pre-flight quota check. The download manager's
    // estimate is rough (layers * 50 features * ~800 bytes) but
    // close enough to detect cases where the user is about to
    // start a download that has no chance of completing. We reuse
    // that estimate here -- duplicating the math would risk drift.
    const roughEstimate =
      editableLayers.length * 50 * 800 + 5 * 1024 * 1024; // + 5MB headroom for forms+pick-lists
    const quota = await checkDownloadFits(roughEstimate);
    if (!quota.fits) {
      setDownloadProgress({
        phase: 'failed',
        message: 'Not enough storage for this download',
        estimatedSize: quota.estimatedDownloadBytes,
        layerCount: editableLayers.length,
        featuresFetched: 0,
        formsFetched: 0,
        pickListsFetched: 0,
        tilesFetched: 0,
        tilesTotal: 0,
        error: `Need ~${formatBytes(quota.shortfallBytes)} more space. Free up cached deployments or device storage and try again.`,
      });
      return;
    }
    // Refresh the persisted storage gauge so the LayerVisibilityPanel
    // reflects the post-prompt state immediately.
    void estimateStorage().then(setStorage);

    // Collect every pick-list id the deployment will need offline.
    // Two surfaces reference picklists, and we have to walk both:
    //
    //   1. Layer field domains: a feature field with a coded-value-
    //      ref domain points at a pick_list item id directly. The
    //      auto-generated form path consumes this when no bound
    //      form is configured.
    //   2. Bound form questions: a select-one question can carry
    //      its own pickListId (form-schema/index.ts), which the
    //      bound form designer may set independently of the layer
    //      field's domain. Skipping this surface is what made the
    //      first offline download report 0 picklists when the
    //      bound form actually referenced one.
    //
    // De-duped by the Set; downloadDeployment fetches each id once.
    const pickListIdSet = new Set<string>();
    for (const l of editableLayers) {
      for (const f of l.fields) {
        if (f.domain && f.domain.type === 'coded-value-ref') {
          pickListIdSet.add(f.domain.pickListItemId);
        }
      }
    }
    // Walk every bound form's questions for question-level
    // pickListId references. The form schema is a tree of
    // questions / groups / repeats so we recurse with a stack.
    const formStack: unknown[] = Object.values(boundForms);
    while (formStack.length > 0) {
      const node = formStack.pop();
      if (!node || typeof node !== 'object') continue;
      const obj = node as Record<string, unknown>;
      // QuestionBase has pickListId on select-one / select-many.
      // Group / repeat nodes don't, but we still recurse into
      // their .questions array.
      if (typeof obj.pickListId === 'string' && obj.pickListId.length > 0) {
        pickListIdSet.add(obj.pickListId);
      }
      const children = obj.questions;
      if (Array.isArray(children)) {
        for (const c of children) formStack.push(c);
      }
    }
    const downloadLayers: DownloadLayer[] = editableLayers.map((l) => {
      const out: DownloadLayer = {
        dataLayerId: l.dataLayerId,
        layerKey: l.layerKey,
        layerLabel: l.layerLabel,
        fields: l.fields,
      };
      if (l.boundFormItemId) out.boundFormItemId = l.boundFormItemId;
      return out;
    });
    // Slice 10: collect tile URL templates from the currently
    // rendered basemap and any raster/vector overlay sources. Read
    // them off the live MapLibre style rather than parsing the
    // basemap config -- that way we cover whatever basemap variant,
    // provider, or proxy URL is actually in use, including stuff
    // we'll add later (vector tile sources, ArcGIS rest tile URLs).
    // Bbox: use the current viewport for v1. The cached deployment
    // bbox would be more durable, but field workers download for
    // "where I am right now," which the viewport captures naturally.
    const tileUrlTemplates = collectTileTemplates(mapRef.current);
    const viewportBbox = mapRef.current
      ? (() => {
          const b = mapRef.current.getBounds();
          return [
            b.getWest(),
            b.getSouth(),
            b.getEast(),
            b.getNorth(),
          ] as [number, number, number, number];
        })()
      : undefined;
    try {
      const manifest = await downloadDeployment(
        {
          dataCollectionId,
          title,
          mapId: '', // will be set by the caller of FieldRuntime in a future pass; not load-bearing
          layers: downloadLayers,
          pickListIds: Array.from(pickListIdSet),
          ...(viewportBbox !== undefined ? { bbox: viewportBbox } : {}),
          ...(tileUrlTemplates.length > 0
            ? { tileUrlTemplates, tileZoomRange: [12, 17] as [number, number] }
            : {}),
        },
        (p) => setDownloadProgress({ ...p }),
      );
      setCachedDeployment(manifest);
      // Tile-cache stats jumped during the warm phase; refresh so
      // the panel's "Map tiles: X (Y MB)" line catches up without
      // forcing the user to reopen the layer panel.
      void refreshTileCacheStats();
    } catch (err) {
      setDownloadProgress({
        phase: 'failed',
        message: 'Download failed',
        estimatedSize: 0,
        layerCount: editableLayers.length,
        featuresFetched: 0,
        formsFetched: 0,
        pickListsFetched: 0,
        tilesFetched: 0,
        tilesTotal: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [downloadProgress, editableLayers, dataCollectionId, title]);

  // Remove this deployment from the device. Cascades through every
  // IDB store keyed on dataCollectionId (features, queue, forms,
  // pick lists, manifest). Tile cache is left alone because it's a
  // shared origin-wide cache and other deployments may still need
  // those tiles. The user is sent back to /field afterwards so the
  // catalog reflects the new state and they don't sit on a now-
  // hollow runtime view.
  const removeCache = useCallback(async () => {
    try {
      await deleteDeployment(dataCollectionId);
      setCachedDeployment(null);
      // Beacon the now-empty manifest so the admin's field-queues
      // view stops showing this deployment as cached. Bypasses the
      // throttle because this is a meaningful state change, not the
      // periodic chatter the throttle exists to dampen.
      void postQueueManifest();
    } catch (err) {
      // Swallow + log: deletion failures are rare (IDB transaction
      // race) and a retry from the user's next tap usually succeeds.
      // eslint-disable-next-line no-console
      console.error('Failed to remove offline cache:', err);
      return;
    }
    if (typeof window !== 'undefined') {
      window.location.assign('/field');
    }
  }, [dataCollectionId]);

  // Templates: one row per (editable layer, symbology class) pair.
  // Computed once unless the source data changes; stable React keys
  // come from `template.id`.
  const templates = useMemo<FieldTemplate[]>(
    () => buildTemplates(editableLayers, mapData),
    [editableLayers, mapData],
  );

  // Selection is unused at this slice but MapCanvas requires the
  // controlled-state props. Empty selection + an off-tool keeps the
  // canvas rendering without firing select-related side effects.
  const [selection, setSelection] = useState<Record<string, Set<number>>>({});

  const handleMapReady = useCallback((map: maplibregl.Map | null) => {
    mapRef.current = map;
    // Tear down any prior marker before re-attaching: handleMapReady can
    // fire again on a basemap swap that recreates the underlying map.
    if (gpsMarkerRef.current) {
      gpsMarkerRef.current.detach();
      gpsMarkerRef.current = null;
    }
    if (map) {
      gpsMarkerRef.current = createGpsMarker(map);
      gpsMarkerRef.current.attach();
      // Replay the latest position into the freshly attached marker
      // so the dot doesn't disappear after a basemap change.
      if (gps.position) gpsMarkerRef.current.update(gps.position);
    }
  }, [gps.position]);

  // Push every new GPS fix into the marker source. Separate from
  // handleMapReady because positions arrive asynchronously and the
  // marker handle may already exist from the initial map ready.
  useEffect(() => {
    if (!gpsMarkerRef.current) return;
    gpsMarkerRef.current.update(gps.position);
  }, [gps.position]);

  // Follow-me mode: recenter the map on each new fix, keeping the
  // current zoom. easeTo is animated but short so a brisk walk
  // doesn't feel jumpy. Skipped when the user is mid-pan: maplibre's
  // isMoving() check would lie (camera also moves during easeTo), so
  // we trust the user's follow toggle as the only signal.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !gps.follow || !gps.position) return;
    map.easeTo({
      center: [gps.position.lon, gps.position.lat],
      duration: 600,
    });
  }, [gps.follow, gps.position]);

  // Tap-to-edit was Field Maps Quick Capture style: tap a feature,
  // form opens directly in edit mode. Matt's prod test feedback
  // surfaced two problems with that flow: (1) it suppressed the
  // popup that shows attribute values, which is the primary "what's
  // here" affordance users expect, and (2) without an explicit Edit
  // button, users couldn't tell that tapping a feature was about to
  // open an edit form. Both stem from forcing the same gesture
  // (tap) to do two things at once.
  //
  // Reverted to popup-first: tapping a feature lets MapCanvas open
  // its read-only popup, which now shows attributes. Editing is
  // accessed via a future "Edit" button inside that popup
  // (#223.4 follow-up). This matches Field Maps' own popup-then-
  // Edit workflow, and matches the desktop map item where popups
  // already work the same way.
  //
  // The block below is left in place but disabled so the field
  // runtime's onClick listener is gone. Reintroduce when the
  // popup-with-Edit-button surface lands and we wire its Edit
  // button to setFormModal.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function _legacyTapToEditEffect(): void {
    const map = mapRef.current;
    if (!map) return;
    const liveMap = map; // narrow non-null inside the closure below
    const editableMapLayerIds: string[] = [];
    for (const ml of mapData.layers ?? []) {
      const source = ml.source;
      if (source?.kind !== 'data-layer') continue;
      const sourceItemId = source.itemId;
      const sourceLayerKey = source.layerKey;
      const matches = editableLayers.some(
        (e) =>
          e.dataLayerId === sourceItemId &&
          (sourceLayerKey ? e.layerKey === sourceLayerKey : true),
      );
      if (matches) editableMapLayerIds.push(ml.id);
    }

    function onClick(e: maplibregl.MapMouseEvent) {
      const styleLayerIds = new Set<string>(
        liveMap.getStyle().layers?.map((l) => l.id) ?? [],
      );
      const queryLayerIds = editableMapLayerIds
        .flatMap((id) => [`${id}-fill`, `${id}-line`, `${id}-circle`, id])
        .filter((id) => styleLayerIds.has(id));
      const hits = queryLayerIds.length
        ? liveMap.queryRenderedFeatures(e.point, { layers: queryLayerIds })
        : [];
      const hit = hits[0];
      if (!hit) return;

      const mapLayerId = (hit.layer as { id?: string }).id ?? '';
      const sourceMapLayer = (mapData.layers ?? []).find((ml) =>
        mapLayerId.startsWith(ml.id),
      );
      if (!sourceMapLayer) return;
      if (sourceMapLayer.source?.kind !== 'data-layer') return;
      const sourceItemId = sourceMapLayer.source.itemId;
      const sourceLayerKey = sourceMapLayer.source.layerKey;
      const editable = editableLayers.find(
        (l) =>
          l.dataLayerId === sourceItemId && l.layerKey === sourceLayerKey,
      );
      if (!editable) return;
      const props = (hit.properties as Record<string, unknown> | null) ?? {};
      const featureId =
        typeof props._global_id === 'string'
          ? (props._global_id as string)
          : null;
      if (!featureId) return;
      const geometry = (hit.geometry as GeoJSON.Geometry | null) ?? null;
      const cleanProps: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        if (k.startsWith('_')) continue;
        cleanProps[k] = v;
      }
      setFormModal({
        layer: editable,
        mode: 'edit',
        featureId,
        properties: cleanProps,
        geometry,
      });
    }
    map.on('click', onClick);
  }
  void _legacyTapToEditEffect; // referenced to silence unused-warning

  // Commit the active template: drop a feature at the current map
  // center and open the form pre-filled with presetAttributes. Used
  // by the "Add at center" button. Field Maps' equivalent: pan to
  // position, tap "Add Point", form opens.
  const commitAtCenter = useCallback(() => {
    const tpl = activeTemplate;
    const map = mapRef.current;
    if (!tpl || !map) return;
    if (!isPointGeometry(tpl.layer.geometryType)) {
      // Slice 2/3 ship point capture only. Polygon / line need a
      // multi-step gesture (tap-to-add-vertex, double-tap-to-finish)
      // and are #196 territory. Surface a hint and bail rather than
      // dropping a degenerate single-point line.
      // eslint-disable-next-line no-alert
      alert(
        `Adding ${tpl.layer.geometryType} features arrives in a follow-up slice.`,
      );
      return;
    }
    const c = map.getCenter();
    setFormModal({
      layer: tpl.layer,
      mode: 'add',
      geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
      presetAttributes: tpl.presetAttributes,
    });
    setActiveTemplate(null);
    // Plant a preview marker at the drop location so the user can
    // see WHERE they're adding while filling in the form. The real
    // feature only appears in the data source after a successful
    // save (#194 refresh), so without this preview the location
    // appears to vanish the moment the form opens. Tinted with the
    // template's color so the visual carries through from the
    // crosshair-reticle phase.
    clearPendingMarker();
    pendingMarkerRef.current = new maplibregl.Marker({ color: tpl.color })
      .setLngLat([c.lng, c.lat])
      .addTo(map);
    // The form takes the bottom ~60% of the screen, which would hide
    // the feature we just dropped at the geometric center. Ease the
    // camera up so the same lng/lat ends up roughly in the middle of
    // the visible (non-form) area. offset is in pixels; positive y
    // moves the displayed center *down*, so a negative y here shifts
    // the geographic center upward on screen. ~30% of viewport
    // height splits the difference: feature lands centered in the
    // ~40% of map still visible above the form.
    const h = map.getContainer().clientHeight;
    map.easeTo({
      center: [c.lng, c.lat],
      offset: [0, -h * 0.3],
      duration: 350,
    });
  }, [activeTemplate, clearPendingMarker]);

  // Phase A3: drop a point at the current GPS fix instead of map
  // center. Same flow as commitAtCenter otherwise (open form + plant
  // preview marker + ease camera). For surveys / inspections the GPS
  // location is almost always what the user wants; "Add at center"
  // is the fallback when the dot drifts or you want to record a
  // feature at a place you're not standing.
  const commitAtGps = useCallback(() => {
    const tpl = activeTemplate;
    const map = mapRef.current;
    const pos = gps.position;
    if (!tpl || !map || !pos) return;
    if (!isPointGeometry(tpl.layer.geometryType)) {
      // eslint-disable-next-line no-alert
      alert(
        `Adding ${tpl.layer.geometryType} features arrives in a follow-up slice.`,
      );
      return;
    }
    setFormModal({
      layer: tpl.layer,
      mode: 'add',
      geometry: { type: 'Point', coordinates: [pos.lon, pos.lat] },
      presetAttributes: tpl.presetAttributes,
    });
    setActiveTemplate(null);
    clearPendingMarker();
    pendingMarkerRef.current = new maplibregl.Marker({ color: tpl.color })
      .setLngLat([pos.lon, pos.lat])
      .addTo(map);
    // Same screen-offset trick as commitAtCenter so the dropped marker
    // doesn't end up under the form sheet.
    const h = map.getContainer().clientHeight;
    map.easeTo({
      center: [pos.lon, pos.lat],
      offset: [0, -h * 0.3],
      duration: 350,
    });
  }, [activeTemplate, gps.position, clearPendingMarker]);

  return (
    // Field mode owns the entire viewport: AppShell suppresses its
    // chrome on this route (see app-shell.tsx) so we render edge-to-
    // edge. dvh keeps the layout stable when iOS hides the URL bar
    // mid-scroll. The bottom sheets below honor env(safe-area-inset-
    // bottom) so iPhones with rounded corners don't clip the action
    // buttons.
    <div className="flex h-[100dvh] flex-col bg-surface-1">
      {/* Header reserves env(safe-area-inset-top) so iOS status bar
          / dynamic island doesn't sit on top of the back arrow when
          the runtime is launched from a home-screen PWA install
          (viewport-fit=cover puts the page under the status bar). */}
      <header className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-1 px-2 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <Link
          href={backHref}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink-1 hover:bg-surface-2"
          aria-label="Back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        {/* Single-line title. Subtitle ("Field deployment of <map>")
            moved into the More menu's header; field workers care
            about the deployment name, not the underlying map name,
            and the secondary line was eating vertical space + visual
            weight. */}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold text-ink-0">
            {title}
          </h1>
        </div>
        {/* Sync chip: only renders when records are queued. Tapping
            the chip kicks off a manual sync. The badge handles its
            own busy state. Kept on the header (not in the More menu)
            because a queued count is a notification, not a setting. */}
        {queueCount > 0 ? (
          <QueueBadge
            count={queueCount}
            syncing={syncing}
            isOnline={isOnline}
            onSync={() => {
              void runSync('manual');
            }}
          />
        ) : null}
        {/* The More menu collects every status pill + secondary
            action that used to crowd the header (connectivity,
            persistence, download, install). Field Maps does the
            same: a single 3-dot button at the top-right keeps the
            collection chrome out of the way of the canvas. */}
        <FieldMoreMenu
          mapTitle={mapTitle}
          isOnline={isOnline}
          cachedAt={cachedDeployment?.cachedAt ?? null}
          persistentState={persistentState}
          downloadInFlight={
            downloadProgress !== null &&
            downloadProgress.phase !== 'done' &&
            downloadProgress.phase !== 'failed'
          }
          hasCache={cachedDeployment !== null}
          queueCount={queueCount}
          gpsStatus={gps.status}
          gpsAccuracyM={gps.position?.accuracyM ?? null}
          onDownload={() => void startDownload()}
          onRemoveCache={() => void removeCache()}
        />
      </header>

      <div className="relative min-h-0 flex-1">
        <MapCanvas
          ref={canvasRef}
          map={effectiveMapData}
          basemaps={basemaps}
          selection={selection}
          selectTool="off"
          onSelectionChange={setSelection}
          onCameraChange={() => {
            /* Camera changes don't persist in field-mode. */
          }}
          onMapReady={handleMapReady}
        />

        {/* Crosshair reticle: only visible while a template is armed.
            Centered absolutely over the canvas with pointer-events:none
            so the maplibre canvas stays interactive underneath. The
            color is tinted from the active template so the user sees
            the symbology of the feature they're about to drop. */}
        {activeTemplate ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
          >
            <div className="relative h-16 w-16">
              {/* Outer ring -- low-contrast halo */}
              <div
                className="absolute inset-0 rounded-full border-2 border-white/70 shadow-[0_0_0_2px_rgba(0,0,0,0.15)]"
                style={{ borderColor: 'rgba(255,255,255,0.85)' }}
              />
              {/* Inner colored ring (the template's color) */}
              <div
                className="absolute inset-2 rounded-full border-2"
                style={{ borderColor: activeTemplate.color }}
              />
              {/* Center dot */}
              <div
                className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{ backgroundColor: activeTemplate.color }}
              />
              {/* Crosshair lines */}
              <div className="absolute left-1/2 top-0 h-3 w-px -translate-x-1/2 bg-white/85" />
              <div className="absolute left-1/2 bottom-0 h-3 w-px -translate-x-1/2 bg-white/85" />
              <div className="absolute top-1/2 left-0 h-px w-3 -translate-y-1/2 bg-white/85" />
              <div className="absolute top-1/2 right-0 h-px w-3 -translate-y-1/2 bg-white/85" />
            </div>
          </div>
        ) : null}

        {/* Layer-toggle button (top-left). MapLibre's NavigationControl
            (zoom +/- + compass) plants itself at top-right via
            map-canvas.tsx, so we keep this button on the opposite
            side to avoid overlap. Compact icon-only and the panel
            drops below when tapped. */}
        <button
          type="button"
          onClick={() => setLayerPanelOpen((v) => !v)}
          className="absolute left-3 top-3 z-10 inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-surface-1 shadow-card hover:bg-surface-2"
          aria-label="Toggle layers"
          aria-pressed={layerPanelOpen}
        >
          <Layers className="h-4 w-4 text-ink-1" />
        </button>

        {/* Locate-me FAB (Phase A2). Sits bottom-left, above the
            template footer so the worker's thumb has an easy reach
            on mobile. Three-state interaction:
              - idle             -> tap requests permission + starts watch
              - watching, no follow -> tap centers on current fix
              - follow            -> button shows filled + tap toggles off
            The hook handles the OS subscription lifecycle; this
            button is purely a UI affordance. */}
        <FieldLocateButton
          gpsStatus={gps.status}
          hasPosition={gps.position !== null}
          follow={gps.follow}
          accuracyM={gps.position?.accuracyM ?? null}
          onTap={() => {
            const map = mapRef.current;
            if (gps.status === 'idle') {
              gps.start();
              return;
            }
            if (gps.position && map) {
              map.easeTo({
                center: [gps.position.lon, gps.position.lat],
                zoom: Math.max(map.getZoom(), 16),
                duration: 600,
              });
            }
            // Toggle follow mode on the second tap. Each tap after that
            // alternates follow on/off. Tapping while not yet watching
            // starts the watch above.
            gps.toggleFollow();
          }}
        />

        {/* Address search overlay (#223.3). Positioned to the right
            of the Layers button at the top of the canvas; on
            mobile this is the most natural spot for a "find this
            place" affordance and matches Field Maps' equivalent
            location. The internal width grows with available
            horizontal space; on tablet+ the bar is constrained to
            keep the canvas usable. */}
        <div className="pointer-events-none absolute left-14 right-3 top-3 z-10 flex justify-start">
          <div className="pointer-events-auto w-full max-w-sm">
            <FieldAddressSearch mapRef={mapRef} />
          </div>
        </div>

        {layerPanelOpen ? (
          <LayerVisibilityPanel
            layers={mapData.layers ?? []}
            hiddenLayerIds={hiddenLayerIds}
            onToggle={(layerId) => {
              setHiddenLayerIds((prev) => {
                const next = new Set(prev);
                if (next.has(layerId)) next.delete(layerId);
                else next.add(layerId);
                return next;
              });
            }}
            basemaps={basemaps}
            currentBasemapId={basemapOverrideId ?? mapData.basemap}
            onBasemapChange={setBasemapOverrideId}
            cachedDeployment={cachedDeployment}
            isDownloading={
              downloadProgress !== null &&
              downloadProgress.phase !== 'done' &&
              downloadProgress.phase !== 'failed'
            }
            onDownload={() => {
              setLayerPanelOpen(false);
              void startDownload();
            }}
            onClose={() => setLayerPanelOpen(false)}
            storage={storage}
            persistentState={persistentState}
            onRequestPersist={async () => {
              const r = await requestPersistentStorage();
              setPersistentState(
                r.persistent ? 'persistent' : 'best-effort',
              );
            }}
            tileCache={tileCache}
            onClearTiles={async () => {
              const ok = await clearTileCache();
              if (ok) await refreshTileCacheStats();
            }}
          />
        ) : null}
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t border-border bg-surface-1 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {editableLayers.length === 0 ? (
          <p className="flex-1 text-center text-xs text-muted">
            No editable layers in this map.
          </p>
        ) : activeTemplate ? (
          <>
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-surface-0 px-2 py-1.5">
              <span
                aria-hidden="true"
                className="h-4 w-4 shrink-0 rounded-sm border border-border"
                style={{ backgroundColor: activeTemplate.color }}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink-0">
                  {activeTemplate.label}
                </p>
                <p className="truncate text-[11px] text-muted">
                  {activeTemplate.sublabel}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActiveTemplate(null)}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-ink-1"
                aria-label="Cancel"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            {/* When GPS is watching, "Add at my location" is the
                primary action because it's what the field worker
                wants 90% of the time. "Add at center" stays as the
                fallback when the user wants to record a feature
                somewhere they're not standing (e.g., the parcel's
                centroid, a feature visible from a vantage point).
                When GPS is idle/denied/unavailable the only button
                shown is "Add at center". */}
            {gps.status === 'watching' && gps.position ? (
              <button
                type="button"
                onClick={commitAtGps}
                title={`Drop the feature at your current location (~${
                  gps.position.accuracyM < 1
                    ? '<1'
                    : Math.round(gps.position.accuracyM)
                } m accuracy)`}
                className="inline-flex h-11 shrink-0 items-center gap-2 rounded-md bg-accent px-3 text-sm font-semibold text-accent-foreground shadow-card hover:opacity-90"
              >
                <LocateFixed className="h-4 w-4" />
                Add at GPS
              </button>
            ) : null}
            <button
              type="button"
              onClick={commitAtCenter}
              className={`inline-flex h-11 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-semibold shadow-card hover:opacity-90 ${
                gps.status === 'watching' && gps.position
                  ? 'border border-border bg-surface-1 text-ink-1'
                  : 'bg-accent text-accent-foreground'
              }`}
            >
              <MapPin className="h-4 w-4" />
              Add at center
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={templates.length === 0}
            onClick={() => setPickerOpen(true)}
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-accent-foreground shadow-card hover:opacity-90 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            Add feature
          </button>
        )}
      </footer>

      {pickerOpen ? (
        <TemplatePicker
          templates={templates}
          onPick={(tpl) => {
            setActiveTemplate(tpl);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}

      {formModal ? (
        <FormModal
          dataCollectionId={dataCollectionId}
          modal={formModal}
          pickLists={effectivePickLists}
          boundForms={boundForms}
          currentUserId={currentUserId}
          isOnline={isOnline}
          gpsPosition={gps.position}
          editableLayers={editableLayers}
          onAddRelated={(childLayer, parentFkColumn, parentFeatureId) => {
            // Switch the modal to add-mode for the child layer with
            // the FK pre-filled. Geometry: prefer the GPS fix when
            // available, fall back to the parent's geometry, fall back
            // to map center as a last resort. Most surveys want the
            // child captured at the worker's actual position; the
            // parent's geometry is a sane fallback when GPS is off.
            const map = mapRef.current;
            const fallbackCenter = map ? map.getCenter() : null;
            const initialGeometry: GeoJSON.Geometry | null =
              gps.position
                ? {
                    type: 'Point',
                    coordinates: [gps.position.lon, gps.position.lat],
                  }
                : formModal.geometry ??
                  (fallbackCenter
                    ? {
                        type: 'Point',
                        coordinates: [fallbackCenter.lng, fallbackCenter.lat],
                      }
                    : null);
            clearPendingMarker();
            setFormModal({
              layer: childLayer,
              mode: 'add',
              geometry: initialGeometry,
              presetAttributes: { [parentFkColumn]: parentFeatureId },
            });
          }}
          onClose={() => {
            clearPendingMarker();
            setFormModal(null);
          }}
          onSubmitted={() => {
            const submittedLayer = formModal.layer;
            clearPendingMarker();
            setFormModal(null);
            // Refresh the MapLayer(s) backed by the data_layer that
            // just received a write so the new / updated feature
            // appears immediately. setData(url) on the existing
            // GeoJSONSource forces a refetch (#194). Online-only;
            // offline writes are surfaced through the
            // offlineFeatures effect via offlineWriteCounter.
            if (isOnline) {
              for (const ml of mapData.layers ?? []) {
                const source = ml.source;
                if (source?.kind !== 'data-layer') continue;
                if (source.itemId !== submittedLayer.dataLayerId) continue;
                if (source.layerKey && source.layerKey !== submittedLayer.layerKey) {
                  continue;
                }
                canvasRef.current?.refreshLayerSource(ml.id);
              }
            }
          }}
          onLocalWriteApplied={() => setOfflineWriteCounter((n) => n + 1)}
        />
      ) : null}

      {downloadProgress ? (
        <DownloadProgressModal
          progress={downloadProgress}
          onClose={() => setDownloadProgress(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * Read-only check: does this geometry type capture a single tap?
 * Slice 2/3 only handle `point` -- line and polygon need a multi-step
 * gesture and ride along with terra-draw integration in a follow-up
 * slice (#196).
 */
function isPointGeometry(t: LayerGeometryType): boolean {
  return t === 'point';
}

/**
 * Walk the live MapLibre style and collect tile URL templates from
 * every raster + vector source that uses {z}/{x}/{y} addressing.
 * Slice 10: the offline-download manager passes these to the tile
 * warmer so the basemap (and any tiled overlays) are pre-cached for
 * the deployment's bbox.
 *
 * Reading off the live style (rather than parsing the basemap config
 * upstream) means we automatically support every basemap variant
 * the runtime can render: built-in raster XYZs, the org's custom
 * basemaps, vector style URLs (which maplibre expands into source
 * objects internally), proxy-routed URLs, etc.
 *
 * Returns an empty array when the map isn't ready or when none of
 * the active sources expose a tile template (vector-style sources
 * that pull style.json + tile URLs internally fall through here;
 * those tiles still get cached via the SW's passive interception
 * as the user pans).
 */
function collectTileTemplates(map: maplibregl.Map | null): string[] {
  if (!map) return [];
  let style: ReturnType<maplibregl.Map['getStyle']> | null = null;
  try {
    style = map.getStyle();
  } catch {
    return [];
  }
  if (!style?.sources) return [];
  const out: string[] = [];
  for (const source of Object.values(style.sources)) {
    if (
      typeof source === 'object' &&
      source !== null &&
      'tiles' in source &&
      Array.isArray((source as { tiles?: unknown }).tiles)
    ) {
      for (const t of (source as { tiles: unknown[] }).tiles) {
        if (typeof t === 'string' && t.includes('{z}') && t.includes('{x}')) {
          out.push(t);
        }
      }
    }
  }
  return out;
}

/**
 * Build the runtime template list. One template per (editable layer,
 * symbology class) pair, drawn from each layer's MapLayer renderer.
 * Layers with no MapLayer in the map (e.g. the data_collection lists
 * a layer the bound map doesn't reference) are skipped silently.
 */
function buildTemplates(
  editableLayers: EditableLayer[],
  mapData: MapData,
): FieldTemplate[] {
  const out: FieldTemplate[] = [];
  for (const layer of editableLayers) {
    // Find the corresponding MapLayer so we can read its renderer.
    // Match on dataLayerId + layerKey. Multiple MapLayers could
    // reference the same v3 sublayer (rare but possible if the
    // author added it twice); use the first match.
    const ml = mapData.layers.find((m) => {
      const s = m.source;
      if (s?.kind !== 'data-layer') return false;
      if (s.itemId !== layer.dataLayerId) return false;
      // Tolerate a missing layerKey on legacy maps (predates Slice 1).
      // When the source has no layerKey, treat the whole data_layer as
      // a single editable target -- the legacy /items/:id/geojson
      // endpoint now routes to the first spatial sublayer (#194).
      return !s.layerKey || s.layerKey === layer.layerKey;
    });
    if (!ml) continue;

    const fallbackColor = pickFallbackColor(ml);
    const renderer = ml.renderer;

    if (!renderer || renderer.kind === 'simple') {
      out.push({
        id: `${layer.dataLayerId}:${layer.layerKey}:simple`,
        layer,
        label: layer.layerLabel,
        sublabel: layer.dataLayerTitle,
        color: fallbackColor,
        presetAttributes: {},
      });
      continue;
    }

    if (renderer.kind === 'unique-values') {
      // Each category becomes its own template. The form will open
      // with renderer.field already populated, matching Field Maps'
      // editing-template convention.
      for (const cat of renderer.categories) {
        out.push({
          id: `${layer.dataLayerId}:${layer.layerKey}:uv:${cat.value}`,
          layer,
          label: cat.value,
          sublabel: layer.layerLabel,
          color: cat.color,
          presetAttributes: { [renderer.field]: cat.value },
        });
      }
      continue;
    }

    if (renderer.kind === 'class-breaks') {
      // Class breaks are numeric ranges; "create a feature with
      // value 0-50 already filled" doesn't generally make sense.
      // Collapse to one "Add to this layer" template using the
      // layer's fallback color so the picker still has an entry.
      out.push({
        id: `${layer.dataLayerId}:${layer.layerKey}:cb`,
        layer,
        label: layer.layerLabel,
        sublabel: layer.dataLayerTitle,
        color: fallbackColor,
        presetAttributes: {},
      });
    }
  }
  return out;
}

/**
 * Choose a sensible swatch color for the simple-renderer / class-breaks
 * fallback. Picks from the layer's MapLayerStyle: point.color for
 * point layers, line.color for lines, fill.color for polygons.
 */
function pickFallbackColor(ml: MapLayer): string {
  const s = ml.style;
  // Best-effort: try every kind so an unset color falls through.
  const point = (s.point as { color?: string } | undefined)?.color;
  const line = (s.line as { color?: string } | undefined)?.color;
  const fill = (s as unknown as { fill?: { color?: string } }).fill?.color;
  return point || line || fill || '#888888';
}

/**
 * FormRuntime expects select-one / select-many / ranking questions to
 * carry `choices` populated at render time. Both the form designer
 * and the auto-form generator (Slice 1) leave `choices: []` and stash
 * the pick_list reference in `pickListId` -- the consumer is the one
 * who fetches the pick list and inlines the entries. The standalone
 * /forms/respond page does the same dance; field-mode does it here.
 *
 * Returns a new FormSchema (questions tree shallow-cloned) so React's
 * referential-identity checks don't get confused. Pick lists missing
 * from the map (item soft-deleted, caller can't see it) leave the
 * question with whatever inline choices were authored as a fallback,
 * which is usually an empty list -- the runtime will then render an
 * empty dropdown rather than a broken one.
 */
function resolvePickListChoices(
  form: FormSchema,
  pickLists: Record<string, PickListData>,
): FormSchema {
  function resolveQuestion(q: Question): Question {
    if (q.type === 'group') {
      return { ...q, children: q.children.map(resolveQuestion) };
    }
    if (
      q.type === 'select-one' ||
      q.type === 'select-many' ||
      q.type === 'ranking'
    ) {
      const pickListId = (q as { pickListId?: string }).pickListId;
      if (!pickListId) return q;
      // Don't clobber inline choices when they're already populated.
      // The designer may have authored choices and ALSO referenced a
      // pick list; the more-specific inline list wins.
      if (q.choices && q.choices.length > 0) return q;
      const list = pickLists[pickListId];
      if (!list) return q;
      const choices = list.entries.map((e) => ({
        value: e.code,
        label: e.label,
      }));
      return { ...q, choices };
    }
    return q;
  }
  return {
    ...form,
    questions: form.questions.map(resolveQuestion),
  };
}

/**
 * Reshape a FeatureField into the loose structural input the form-schema
 * package's generator accepts. We skip optional fields that are
 * undefined (rather than carrying them as `key: undefined`) to satisfy
 * `exactOptionalPropertyTypes`.
 */
type GeneratorFieldInput = NonNullable<
  Parameters<typeof generateFormFromLayer>[0]['fields']
>[number];

function layerFieldToGeneratorInput(f: FeatureField): GeneratorFieldInput {
  const out: GeneratorFieldInput = {
    name: f.name,
    type: f.type,
  };
  if (f.label !== undefined) out.label = f.label;
  if (f.nullable !== undefined) out.nullable = f.nullable;
  if (f.domain !== undefined) out.domain = f.domain;
  return out;
}

/**
 * Bottom-sheet picker shown when the user taps "Add Feature". Lists
 * every template grouped by layer label. Layer headers are derived
 * from the templates' `sublabel`, which is the parent layer's name
 * for unique-values templates and the data_layer title for simple
 * layers -- the result is "all classes for layer X" reads as one
 * cluster. Tapping a row commits the active template and closes.
 */
function TemplatePicker({
  templates,
  onPick,
  onClose,
}: {
  templates: FieldTemplate[];
  onPick: (tpl: FieldTemplate) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState('');
  const groups = useMemo(() => {
    const term = filter.trim().toLowerCase();
    const filtered = term
      ? templates.filter(
          (t) =>
            t.label.toLowerCase().includes(term) ||
            t.sublabel.toLowerCase().includes(term),
        )
      : templates;
    // Group by sublabel (parent layer / data_layer title) preserving
    // insertion order. A Map preserves keys in insertion order across
    // all engines we care about.
    const byGroup = new Map<string, FieldTemplate[]>();
    for (const t of filtered) {
      const arr = byGroup.get(t.sublabel) ?? [];
      arr.push(t);
      byGroup.set(t.sublabel, arr);
    }
    return Array.from(byGroup.entries());
  }, [templates, filter]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Pick a feature type to add"
      className="fixed inset-0 z-30 flex items-end bg-black/40"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[75vh] w-full flex-col rounded-t-xl border-t border-border bg-surface-1 shadow-overlay pb-[env(safe-area-inset-bottom)] sm:max-h-[80vh]"
      >
        <div className="shrink-0 border-b border-border px-3 py-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink-0">Add feature</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-1 hover:bg-surface-2"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter..."
            className="mt-2 h-9 w-full rounded-md border border-border bg-surface-0 px-3 text-sm text-ink-0 outline-none placeholder:text-muted focus:border-accent"
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {groups.length === 0 ? (
            <p className="p-4 text-center text-xs text-muted">
              {templates.length === 0
                ? "This deployment has no editable layers yet."
                : 'No templates match that filter.'}
            </p>
          ) : (
            groups.map(([groupLabel, groupTemplates]) => (
              <div key={groupLabel} className="border-b border-border last:border-b-0">
                <h3 className="bg-surface-0 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
                  {groupLabel}
                </h3>
                <ul>
                  {groupTemplates.map((t) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => onPick(t)}
                        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
                      >
                        <span
                          aria-hidden="true"
                          className="h-5 w-5 shrink-0 rounded-sm border border-border"
                          style={{ backgroundColor: t.color }}
                        />
                        <span className="min-w-0 flex-1 truncate text-sm text-ink-0">
                          {t.label}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Compact panel that lists every map layer with an eye toggle.
 * Session-local (doesn't mutate the bound map item). Clicking the
 * eye flips visibility for this open of the deployment only.
 */
function LayerVisibilityPanel({
  layers,
  hiddenLayerIds,
  onToggle,
  basemaps,
  currentBasemapId,
  onBasemapChange,
  cachedDeployment,
  isDownloading,
  onDownload,
  onClose,
  storage,
  persistentState,
  onRequestPersist,
  tileCache,
  onClearTiles,
}: {
  layers: MapLayer[];
  hiddenLayerIds: Set<string>;
  onToggle: (layerId: string) => void;
  /** Available basemap items the user can swap to. */
  basemaps: CustomBasemap[];
  /** Currently active basemap id (override or authored default). */
  currentBasemapId: string;
  /** Switch to a different basemap. Pass null to clear the override
   *  and fall back to the map item's authored basemap. */
  onBasemapChange: (next: string | null) => void;
  cachedDeployment: CachedDeployment | null;
  isDownloading: boolean;
  onDownload: () => void;
  onClose: () => void;
  /** Slice 6: live storage usage for the gauge. Null = not loaded yet. */
  storage: StorageEstimate | null;
  /** Slice 6: persistence state surfaced via the in-panel chip. */
  persistentState: 'unknown' | 'persistent' | 'best-effort';
  /** Fires the storage.persist() prompt. The user can also re-request
   *  if they originally denied. */
  onRequestPersist: () => void;
  /** Slice 10: tile cache stats (count + bytes) read from the SW.
   *  Null when the SW isn't registered (dev mode, unsupported
   *  browsers); the panel hides the row in that case. */
  tileCache: { count: number; bytes: number } | null;
  /** Drops every cached tile via the SW message channel. Used for
   *  the "free up space" affordance when the storage gauge is red. */
  onClearTiles: () => void;
}) {
  // Group sources are headers, not togglable rows themselves -- but
  // we still show them so the panel reads like the desktop layer
  // tree. Per-row visibility only applies to leaf layers; toggling a
  // group is a polish item for later.
  const [basemapPickerOpen, setBasemapPickerOpen] = useState(false);
  const activeBasemap = basemaps.find((b) => b.id === currentBasemapId);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Layer visibility"
      className="absolute right-3 top-14 z-20 w-64 max-w-[calc(100vw-1.5rem)] rounded-md border border-border bg-surface-1 shadow-overlay"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
          Layers
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-ink-1"
          aria-label="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {/* Basemap chip at the top of the layer list (#223.8). Field
          workers reach for "swap to satellite" all the time; baking
          it into the layer panel keeps it one tap away without a
          dedicated tool button cluttering the canvas. Tapping the
          chip expands an inline picker; selection updates the
          runtime's session-only basemap override and the chip
          collapses back. Only renders when at least 2 basemaps are
          available -- one isn't a choice. */}
      {basemaps.length >= 2 ? (
        <div className="border-b border-border px-3 py-2">
          <button
            type="button"
            onClick={() => setBasemapPickerOpen((v) => !v)}
            className="flex w-full items-center gap-2 rounded-md border border-border bg-surface-0 px-2 py-1.5 text-left text-xs font-medium text-ink-0 hover:border-accent hover:text-accent"
            aria-expanded={basemapPickerOpen}
          >
            <Layers className="h-3.5 w-3.5 shrink-0 text-muted" />
            <span className="min-w-0 flex-1 truncate">
              Basemap: {activeBasemap?.label ?? 'default'}
            </span>
            <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted">
              {basemapPickerOpen ? 'Hide' : 'Change'}
            </span>
          </button>
          {basemapPickerOpen ? (
            <ul className="mt-1 max-h-44 overflow-y-auto rounded-md border border-border bg-surface-0">
              {basemaps.map((b) => {
                const active = b.id === currentBasemapId;
                return (
                  <li key={b.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onBasemapChange(b.id);
                        setBasemapPickerOpen(false);
                      }}
                      className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs ${
                        active
                          ? 'bg-accent/10 text-accent'
                          : 'text-ink-0 hover:bg-surface-2'
                      }`}
                      aria-pressed={active}
                    >
                      {b.thumbnailUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={b.thumbnailUrl}
                          alt=""
                          className="h-6 w-6 shrink-0 rounded border border-border object-cover"
                        />
                      ) : (
                        <span
                          aria-hidden="true"
                          className="h-6 w-6 shrink-0 rounded border border-border bg-surface-2"
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate">{b.label}</span>
                      {active ? <Check className="h-3 w-3" /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
      <div className="border-b border-border px-3 py-2">
        <button
          type="button"
          onClick={onDownload}
          disabled={isDownloading}
          className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-border bg-surface-0 px-3 text-xs font-medium text-ink-0 hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {isDownloading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CloudDownload className="h-3.5 w-3.5" />
          )}
          {cachedDeployment ? 'Refresh offline cache' : 'Download for offline'}
        </button>
        {cachedDeployment ? (
          <p className="mt-1 text-[10px] text-muted">
            Cached {formatRelativeTime(cachedDeployment.cachedAt)} ·{' '}
            {formatBytes(cachedDeployment.estimatedSize)}
          </p>
        ) : null}
      </div>
      {/* Slice 6 (persistence floor): storage gauge + persistence
          affordance. Only renders when we have real numbers; on
          unsupported browsers (older Safari, restricted WebViews)
          we show nothing rather than a misleading "0 / 0" reading. */}
      {storage && storage.available ? (
        <div className="border-b border-border px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted">
              Storage
            </span>
            {persistentState === 'best-effort' ? (
              <button
                type="button"
                onClick={onRequestPersist}
                className="text-[10px] text-accent hover:underline"
              >
                Make persistent
              </button>
            ) : persistentState === 'persistent' ? (
              <span className="text-[10px] text-emerald-700">Persistent</span>
            ) : null}
          </div>
          <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-ink-1">
            <span>{formatBytes(storage.usage)}</span>
            <span className="text-muted">of {formatBytes(storage.quota)}</span>
          </div>
          <div
            role="progressbar"
            aria-valuenow={Math.round(storage.usagePercent * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-0"
          >
            <div
              className={`h-full transition-all ${
                storage.usagePercent >= 0.95
                  ? 'bg-rose-500'
                  : storage.usagePercent >= 0.8
                    ? 'bg-amber-500'
                    : 'bg-accent'
              }`}
              style={{
                width: `${Math.min(100, Math.round(storage.usagePercent * 100))}%`,
              }}
            />
          </div>
          {storage.usagePercent >= 0.95 ? (
            <p className="mt-1 text-[10px] text-rose-600">
              Storage nearly full. Free up space before downloading more areas.
            </p>
          ) : null}
          {/* Slice 10: tile-cache breakdown surfaced inside the
              storage block so a user staring at the bar can answer
              "what's eating my quota" in one glance. The "Clear
              tiles" link drops only the SW tile cache; cached
              features + queued edits stay put because they're
              load-bearing for offline work. */}
          {tileCache && tileCache.count > 0 ? (
            <div className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2 text-[11px] text-muted">
              <span>
                Map tiles: {tileCache.count.toLocaleString()} (
                {formatBytes(tileCache.bytes)})
              </span>
              <button
                type="button"
                onClick={onClearTiles}
                className="text-[10px] text-accent hover:underline"
              >
                Clear tiles
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <ul className="max-h-72 overflow-y-auto p-1">
        {layers.length === 0 ? (
          <li className="p-2 text-center text-xs text-muted">
            No layers in this map.
          </li>
        ) : (
          layers.map((l) => {
            const isGroup = l.source?.kind === 'group';
            if (isGroup) {
              return (
                <li
                  key={l.id}
                  className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted"
                >
                  {l.title}
                </li>
              );
            }
            const visible = l.visible && !hiddenLayerIds.has(l.id);
            return (
              <li key={l.id}>
                <button
                  type="button"
                  onClick={() => onToggle(l.id)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-2"
                  aria-pressed={visible}
                >
                  {visible ? (
                    <Eye className="h-4 w-4 shrink-0 text-accent" />
                  ) : (
                    <EyeOff className="h-4 w-4 shrink-0 text-muted" />
                  )}
                  <span
                    className={`min-w-0 flex-1 truncate ${
                      visible ? 'text-ink-0' : 'text-muted line-through'
                    }`}
                  >
                    {l.title}
                  </span>
                </button>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}

/**
 * Form modal: full-screen on mobile, right-side panel on desktop. Uses
 * FormRuntime under the hood with whichever schema applies (bound or
 * auto-derived). For add-mode, the active template's presetAttributes
 * are merged into the initial response so the categorical field
 * driving the renderer comes pre-filled. Submission posts (add) or
 * patches (edit) against the v3 features endpoint, then notifies the
 * parent so it can refresh the map.
 */
function FormModal({
  dataCollectionId,
  modal,
  pickLists,
  boundForms,
  currentUserId,
  isOnline,
  gpsPosition,
  editableLayers,
  onAddRelated,
  onClose,
  onSubmitted,
  onLocalWriteApplied,
}: {
  dataCollectionId: string;
  modal:
    | {
        layer: EditableLayer;
        mode: 'add';
        geometry: GeoJSON.Geometry | null;
        presetAttributes: Record<string, string>;
      }
    | {
        layer: EditableLayer;
        mode: 'edit';
        featureId: string;
        properties: Record<string, unknown>;
        geometry: GeoJSON.Geometry | null;
      };
  pickLists: Record<string, PickListData>;
  boundForms: Record<string, FormSchema>;
  currentUserId: string;
  /** Whether the runtime is currently online. Drives the choice
   *  between direct write and enqueue-to-sync-later. */
  isOnline: boolean;
  /** Latest GPS fix at the time the form opened. Stamped onto
   *  add-mode features (Phase A4) so survey-style workflows preserve
   *  fix accuracy + altitude + heading + timestamp alongside the
   *  geometry. Null when the user hasn't enabled location. */
  gpsPosition: GpsPosition | null;
  /** Phase C: full editable-layer list so the modal can resolve a
   *  child layer key to its full EditableLayer (with fields, form
   *  binding, etc.) when the user taps "Add related." */
  editableLayers: EditableLayer[];
  /** Phase C: open a fresh add-mode modal for a child layer with the
   *  parent FK pre-filled. Runtime owns the actual setFormModal call
   *  because it also has to clear pendingMarker, ease the camera,
   *  etc. */
  onAddRelated: (
    childLayer: EditableLayer,
    parentFkColumn: string,
    parentFeatureId: string,
  ) => void;
  onClose: () => void;
  onSubmitted: () => void;
  /** Fires after an offline write (or an online write that fell
   *  back to the queue) has been applied locally. The runtime uses
   *  this to bump its offline-feature refresh counter so the new /
   *  edited feature appears on the map without a manual reload. */
  onLocalWriteApplied: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const form = useMemo<FormSchema>(() => {
    let base: FormSchema;
    if (modal.layer.boundFormItemId) {
      const bound = boundForms[modal.layer.boundFormItemId];
      if (bound) base = bound;
      else {
        base = generateFormFromLayer(
          {
            key: modal.layer.layerKey,
            label: modal.layer.layerLabel,
            fields: modal.layer.fields.map(layerFieldToGeneratorInput),
          },
          {
            dataLayerId: modal.layer.dataLayerId,
            formId: modal.layer.layerKey,
          },
        );
      }
    } else {
      base = generateFormFromLayer(
        {
          key: modal.layer.layerKey,
          label: modal.layer.layerLabel,
          fields: modal.layer.fields.map(layerFieldToGeneratorInput),
        },
        {
          dataLayerId: modal.layer.dataLayerId,
          formId: modal.layer.layerKey,
        },
      );
    }
    return resolvePickListChoices(base, pickLists);
  }, [modal.layer, boundForms, pickLists]);

  // Hydrate the initial response. Edit mode pre-fills from the tapped
  // feature's properties; add mode uses the template's presetAttributes
  // so the categorical column driving the renderer comes pre-filled
  // (Field Maps editing-template convention).
  const initial = useMemo<FormResponse>(() => {
    if (modal.mode === 'edit') return { ...modal.properties };
    return { ...modal.presetAttributes };
  }, [modal]);

  async function handleSubmit(response: FormResponse) {
    setError(null);
    // GPS fix metadata stamping (#225 item 3). For add-mode features
    // only -- on edit, the existing fix was the one that mattered.
    // Walk the layer's declared fields and populate any whose name
    // matches a canonical GPS metadata key (case-insensitive) from
    // the live position. This way admins opt in by adding columns
    // with familiar names (h_accuracy, fix_at, position_source_type,
    // ...); we don't write columns the layer doesn't have, so the
    // attribute table stays the schema's source of truth.
    //
    // Recognized aliases per slot (case-insensitive, leading-underscore
    // tolerated for backwards compat with Phase A's private convention):
    //   - longitude / lon / x / gps_lon         → position.lon
    //   - latitude  / lat / y / gps_lat         → position.lat
    //   - h_accuracy / horizontal_accuracy /
    //     horiz_accuracy / accuracy / gps_accuracy_m
    //                                           → position.accuracyM
    //   - altitude / alt / alt_m / z / gps_altitude_m
    //                                           → position.altitudeM
    //   - v_accuracy / vertical_accuracy /
    //     vert_accuracy / altitude_accuracy /
    //     gps_altitude_accuracy_m               → position.altitudeAccuracyM
    //   - heading / heading_deg / gps_heading_deg
    //                                           → position.headingDeg
    //   - speed / speed_mps / gps_speed_mps     → position.speedMps
    //   - fix_at / captured_at / gps_fix_at     → ISO timestamp
    //   - position_source_type                  → "browser-geolocation"
    //   - capture_method                        → "point-collected"
    //
    // Form-supplied values always win (a user typing into a captured_at
    // field overrides our stamp); we only fill blanks.
    const properties: FormResponse =
      modal.mode === 'add' && gpsPosition
        ? stampGpsMetadata(modal.layer.fields, response, gpsPosition)
        : response;
    // Identity. For inserts we generate the globalId client-side so
    // the queue and the local feature row share a key with the
    // eventual server row -- a re-drained queue (or a sync that
    // succeeded server-side but lost the success response) doesn't
    // double-create. The portal-api COALESCEs against gen_random_uuid()
    // so the server accepts our id directly.
    const featureId =
      modal.mode === 'add' ? newGlobalId() : modal.featureId;
    // Schema hash on the queued record lets sync detect drift later
    // (Slice 5 doesn't act on it yet, but capturing it now means an
    // upgraded portal can reconcile without a queue migration).
    const schemaHash = await hashLayerSchema(modal.layer.fields);

    // Local apply path (used by both offline mode and online mode's
    // network-failure fallback). Enqueues the operation, writes the
    // feature into IndexedDB so it's visible on the map immediately,
    // and bumps the runtime's refresh counter via the callback.
    const applyLocally = async (): Promise<void> => {
      const queueRecord: QueueRecord = {
        id: featureId, // queue id == globalId; one outstanding op per feature
        dataCollectionId,
        op: modal.mode === 'add' ? 'insert' : 'update',
        dataLayerId: modal.layer.dataLayerId,
        layerKey: modal.layer.layerKey,
        globalId: featureId,
        geometry: modal.geometry,
        properties,
        queuedAt: new Date().toISOString(),
        schemaHash,
        syncStatus: 'pending',
      };
      await enqueueRecord(queueRecord);
      // Mirror into the cached features store so the map shows the
      // feature on next render. For inserts this is a fresh row; for
      // updates it overwrites the prior cached copy under the same
      // composite key. The properties carry _global_id so the popup
      // and the existing feature-id resolution paths keep working.
      const cachedFeature: CachedFeature = {
        dataCollectionId,
        dataLayerId: modal.layer.dataLayerId,
        layerKey: modal.layer.layerKey,
        globalId: featureId,
        feature: {
          type: 'Feature',
          id: featureId,
          geometry: modal.geometry as GeoJSON.Geometry,
          properties: {
            ...properties,
            _global_id: featureId,
            _created_by: currentUserId,
            _edited_by: currentUserId,
            _created_at: queueRecord.queuedAt,
            _edited_at: queueRecord.queuedAt,
          },
        },
        cachedAt: queueRecord.queuedAt,
      };
      await putFeatures([cachedFeature]);
      onLocalWriteApplied();
    };

    try {
      if (isOnline) {
        // Online path. Try the live API first. On non-2xx (validation
        // error, schema mismatch, anything 4xx) we propagate to the
        // user so they can fix and retry; this is NOT a queue case.
        // On a network-level failure (TypeError from fetch) we DO
        // fall back to the queue so the edit is preserved.
        if (modal.mode === 'add') {
          let res: Response;
          try {
            res = await fetch(
              `/api/portal/items/${modal.layer.dataLayerId}/layers/${encodeURIComponent(
                modal.layer.layerKey,
              )}/features`,
              {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  // x-data-collection-id triggers the
                  // data_collection_feature_created notification (#229)
                  // server-side. Carries the deployment id so the
                  // BFF passthrough can forward it to portal-api.
                  'x-data-collection-id': dataCollectionId,
                },
                body: JSON.stringify({
                  features: [
                    {
                      globalId: featureId,
                      geometry: modal.geometry,
                      properties,
                    },
                  ],
                }),
              },
            );
          } catch {
            // Likely network failure during a transient blip. Stash
            // it in the queue so it doesn't get lost; auto-sync will
            // retry as soon as the radio comes back.
            await applyLocally();
            onSubmitted();
            return;
          }
          if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`POST failed (${res.status}): ${body || res.statusText}`);
          }
        } else {
          let res: Response;
          try {
            res = await fetch(
              `/api/portal/items/${modal.layer.dataLayerId}/layers/${encodeURIComponent(
                modal.layer.layerKey,
              )}/features/${modal.featureId}`,
              {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ properties }),
              },
            );
          } catch {
            await applyLocally();
            onSubmitted();
            return;
          }
          if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(
              `PATCH failed (${res.status}): ${body || res.statusText}`,
            );
          }
        }
      } else {
        // Offline path. The browser reports !navigator.onLine so we
        // know the network is down; skip the doomed fetch and go
        // straight to the queue. The user sees the same "submitted"
        // success state as online; the difference is the edit lives
        // in IndexedDB until sync runs.
        await applyLocally();
      }
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submit failed.');
      throw err; // FormRuntime needs to know the submit failed so it doesn't render the success state
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={
        modal.mode === 'add'
          ? `Add ${modal.layer.layerLabel}`
          : `Edit ${modal.layer.layerLabel}`
      }
      // Bottom-anchored sheet: form occupies the lower portion of the
      // viewport so the map stays visible above. Matches Field Maps'
      // pattern, which is the right call for field collection -- the
      // collector can verify their dropped location while they fill
      // out attributes. Tap the dim backdrop above to dismiss.
      className="fixed inset-0 z-30 flex flex-col justify-end bg-black/40"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[60vh] w-full flex-col overflow-hidden rounded-t-xl border-t border-border bg-surface-1 shadow-overlay pb-[env(safe-area-inset-bottom)] sm:max-h-[55vh]"
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-1 px-3 py-2">
          <span
            aria-hidden="true"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent"
          >
            <ClipboardList className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-ink-0">
              {modal.mode === 'add'
                ? `New ${modal.layer.layerLabel}`
                : `Edit ${modal.layer.layerLabel}`}
            </h2>
            <p className="truncate text-[11px] text-muted">
              {modal.layer.dataLayerTitle}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink-1 hover:bg-surface-2"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <FormRuntime
            form={form}
            initial={initial}
            onSubmit={handleSubmit}
            submitLabel={modal.mode === 'add' ? 'Save feature' : 'Save changes'}
          />
          {error ? (
            <p
              role="alert"
              className="mt-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
            >
              {error}
            </p>
          ) : null}
          {/* Phase B: per-feature attachments. Only mounted in edit
              mode because attachments need a server-side feature row
              to register against (the API path is keyed by featureId).
              Add-mode features get a fresh global id but the
              attachment endpoint requires the row to exist first;
              users can save the feature, the form re-opens in edit
              mode for picture/audio/video uploads. Online-only for
              now: the offline buffer for blobs is queued separately
              (#200). */}
          {modal.mode === 'edit' ? (
            <div className="mt-4 border-t border-border pt-3">
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">
                Attachments
              </p>
              <V3FeatureAttachments
                itemId={modal.layer.dataLayerId}
                layerId={modal.layer.layerKey}
                featureId={modal.featureId}
                canEdit={true}
              />
            </div>
          ) : null}
          {/* Phase C: child layers in the same data_layer that
              reference this layer via parentFkColumn. Each row is
              a quick-add affordance: tap to drop a fresh child
              record under this feature, with the FK column already
              filled in. Children that aren't editable in this
              deployment (table-only sublayer or restricted
              editingPolicy) are still listed but with the Add
              button disabled so the user knows they exist. */}
          {modal.mode === 'edit' &&
          (modal.layer.childLayers ?? []).length > 0 ? (
            <div className="mt-4 border-t border-border pt-3">
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">
                Related records
              </p>
              <ul className="space-y-1.5">
                {(modal.layer.childLayers ?? []).map((c) => {
                  const childEditable = editableLayers.find(
                    (e) =>
                      e.dataLayerId === modal.layer.dataLayerId &&
                      e.layerKey === c.layerKey,
                  );
                  return (
                    <li
                      key={c.layerKey}
                      className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface-0 px-2 py-1.5"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium text-ink-0">
                          {c.layerLabel}
                        </p>
                        <p className="truncate text-[10px] text-muted">
                          {(c.geometryType ?? 'table').toUpperCase()} ·
                          linked via {c.parentFkColumn}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={!childEditable}
                        onClick={() => {
                          if (!childEditable) return;
                          onAddRelated(
                            childEditable,
                            c.parentFkColumn,
                            modal.featureId,
                          );
                        }}
                        title={
                          childEditable
                            ? `Add a new ${c.layerLabel} record under this feature`
                            : 'This child layer is not editable in this deployment'
                        }
                        className="inline-flex h-7 shrink-0 items-center gap-1 rounded border border-border bg-surface-1 px-2 text-[11px] text-ink-1 hover:bg-surface-2 disabled:opacity-50"
                      >
                        <Plus className="h-3 w-3" />
                        Add
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Locate-me FAB. Bottom-left of the canvas, opposite the layer-toggle
 * button at top-left so the worker's thumb stays in one corner per
 * action class. Three visual states tied to the GPS hook:
 *
 *   - idle / requesting / denied -> outlined icon, neutral tint
 *   - watching, follow=false     -> outlined icon, accent tint
 *   - follow=true                -> filled accent + small "live" pulse
 *
 * Tap behavior is controlled entirely by the parent (the runtime
 * decides whether to start, recenter, or toggle follow); this
 * component just renders the appropriate visual.
 */
function FieldLocateButton({
  gpsStatus,
  hasPosition,
  follow,
  accuracyM,
  onTap,
}: {
  gpsStatus: import('./use-geolocation').GpsStatus;
  hasPosition: boolean;
  follow: boolean;
  accuracyM: number | null;
  onTap: () => void;
}) {
  const tone =
    gpsStatus === 'denied' || gpsStatus === 'unavailable'
      ? 'bg-surface-1 border-border text-muted'
      : follow
        ? 'bg-accent border-accent text-accent-foreground'
        : hasPosition
          ? 'bg-surface-1 border-border text-accent'
          : 'bg-surface-1 border-border text-ink-1';
  const label =
    gpsStatus === 'idle'
      ? 'Show my location'
      : gpsStatus === 'requesting'
        ? 'Acquiring location'
        : gpsStatus === 'denied'
          ? 'Location permission denied'
          : gpsStatus === 'unavailable'
            ? 'Location unavailable'
            : follow
              ? 'Following location (tap to stop)'
              : hasPosition
                ? `Center on my location (~${
                    accuracyM === null
                      ? 'unknown'
                      : accuracyM < 1
                        ? '<1'
                        : Math.round(accuracyM)
                  } m)`
                : 'Show my location';
  return (
    <button
      type="button"
      onClick={onTap}
      title={label}
      aria-label={label}
      aria-pressed={follow}
      disabled={
        gpsStatus === 'requesting' ||
        gpsStatus === 'denied' ||
        gpsStatus === 'unavailable'
      }
      className={`absolute left-3 bottom-20 z-10 inline-flex h-10 w-10 items-center justify-center rounded-full border shadow-card transition-colors disabled:opacity-50 ${tone}`}
    >
      {gpsStatus === 'requesting' ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : follow ? (
        <Crosshair className="h-4 w-4" />
      ) : (
        <LocateFixed className="h-4 w-4" />
      )}
    </button>
  );
}

/**
 * Field-Maps-style "More" menu in the top-right of the field
 * runtime header. Replaces the connectivity pill / persistence
 * badge / download button / PWA install button cluster that used to
 * fill the right side. All of those affordances are still present;
 * they're just collected into one dropdown so the canvas isn't
 * crowded by chrome.
 *
 * The dropdown is a self-contained popover with a backdrop that
 * dismisses on outside-tap. Status rows in the menu are read-only;
 * actions (Refresh offline cache, Install app) are buttons.
 */
function FieldMoreMenu({
  mapTitle,
  isOnline,
  cachedAt,
  persistentState,
  downloadInFlight,
  hasCache,
  queueCount,
  gpsStatus,
  gpsAccuracyM,
  onDownload,
  onRemoveCache,
}: {
  mapTitle: string;
  isOnline: boolean;
  cachedAt: string | null;
  persistentState: 'unknown' | 'persistent' | 'best-effort';
  downloadInFlight: boolean;
  hasCache: boolean;
  queueCount: number;
  gpsStatus: import('./use-geolocation').GpsStatus;
  gpsAccuracyM: number | null;
  onDownload: () => void;
  onRemoveCache: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Two-tap confirm for the destructive Remove action: first tap arms
  // the button (turns red, label flips to Confirm), second tap commits.
  // Cheaper than a full modal on mobile and stays inside the popover.
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  // Same two-tap pattern, but only triggered when the queue has
  // unsynced edits. Refresh itself is non-destructive (downloadDeployment
  // upserts cached features and never touches the queue store), but
  // the runtime renders from cached features, so after a refresh the
  // user sees server state and any locally-edited rows look "lost"
  // until the queue drains. Warning the user lets them sync first.
  const [confirmingRefresh, setConfirmingRefresh] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Outside-tap dismisses. Field workers expect tap-on-canvas to do
  // map work, not stay-trapped-in-menu, so a global listener wins
  // over an internal click handler.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Reset the armed-confirm states whenever the menu closes so the
  // next time the user opens it they see the safe label again.
  useEffect(() => {
    if (!open) {
      setConfirmingRemove(false);
      setConfirmingRefresh(false);
    }
  }, [open]);

  const connStatus = isOnline
    ? { label: 'Online', tone: 'text-emerald-600' as const }
    : hasCache
      ? { label: 'Offline (cached)', tone: 'text-amber-600' as const }
      : { label: 'Offline (no cache)', tone: 'text-rose-600' as const };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="More options"
        aria-expanded={open}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md text-ink-1 hover:bg-surface-2"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-1 w-64 overflow-hidden rounded-md border border-border bg-surface-1 shadow-overlay"
        >
          <div className="border-b border-border px-3 py-2">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted">
              Map
            </p>
            <p className="mt-0.5 truncate text-sm text-ink-0">{mapTitle}</p>
          </div>
          <ul className="px-1 py-1 text-sm">
            <li className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs">
              <span className="text-muted">Connection</span>
              <span className={`font-medium ${connStatus.tone}`}>
                {connStatus.label}
              </span>
            </li>
            {cachedAt ? (
              <li className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs">
                <span className="text-muted">Last cached</span>
                <span className="text-ink-1">
                  {formatRelativeTime(cachedAt)}
                </span>
              </li>
            ) : null}
            {persistentState !== 'unknown' ? (
              <li className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs">
                <span className="text-muted">Storage</span>
                <span
                  className={
                    persistentState === 'persistent'
                      ? 'text-emerald-700'
                      : 'text-amber-700'
                  }
                >
                  {persistentState === 'persistent'
                    ? 'Persistent'
                    : 'Best effort'}
                </span>
              </li>
            ) : null}
            {/* GPS row (Phase A5). Surfaces the watch state + the
                latest accuracy band so the worker can tell at a
                glance whether the next tap-to-add will be precise.
                Only renders when the watch is active or has been
                active; idle = the user hasn't asked for location yet
                and we shouldn't pretend to know anything. */}
            {gpsStatus !== 'idle' ? (
              <li className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs">
                <span className="text-muted">GPS</span>
                <span
                  className={
                    gpsStatus === 'denied' || gpsStatus === 'unavailable'
                      ? 'text-rose-700'
                      : gpsStatus === 'requesting'
                        ? 'text-muted'
                        : (() => {
                            const band = gpsAccuracyBand(gpsAccuracyM);
                            return band === 'excellent' || band === 'good'
                              ? 'text-emerald-700'
                              : band === 'fair'
                                ? 'text-amber-700'
                                : 'text-rose-700';
                          })()
                  }
                >
                  {gpsStatus === 'denied'
                    ? 'Permission denied'
                    : gpsStatus === 'unavailable'
                      ? 'Unavailable'
                      : gpsStatus === 'requesting'
                        ? 'Acquiring...'
                        : gpsStatus === 'error'
                          ? 'Error'
                          : gpsAccuracyM === null
                            ? 'Watching'
                            : `${
                                gpsAccuracyM < 1
                                  ? '<1'
                                  : Math.round(gpsAccuracyM)
                              } m`}
                </span>
              </li>
            ) : null}
          </ul>
          <div className="border-t border-border p-1">
            {/* Refresh + queue safety: when the queue has unsynced
                edits, refreshing pulls server state and the locally
                edited rows look "lost" until the queue drains in the
                background. The records are still safe (downloadDeployment
                never touches the queue), but the visual gap rattles
                users. Two-tap arm/confirm with an inline warning gives
                them the option to sync first. With an empty queue,
                refresh runs straight through. */}
            {confirmingRefresh && hasCache && queueCount > 0 ? (
              <p className="px-2 pt-1 text-[11px] text-amber-700">
                {queueCount} edit{queueCount === 1 ? '' : 's'} not yet
                synced. Refresh anyway?
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => {
                if (
                  hasCache &&
                  queueCount > 0 &&
                  !confirmingRefresh
                ) {
                  setConfirmingRefresh(true);
                  return;
                }
                setOpen(false);
                onDownload();
              }}
              disabled={downloadInFlight}
              className={`flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm disabled:opacity-50 ${
                confirmingRefresh && hasCache && queueCount > 0
                  ? 'bg-amber-50 text-amber-800 hover:bg-amber-100'
                  : 'text-ink-0 hover:bg-surface-2'
              }`}
            >
              {downloadInFlight ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted" />
              ) : hasCache ? (
                <RefreshCw
                  className={`h-4 w-4 ${
                    confirmingRefresh && queueCount > 0
                      ? 'text-amber-700'
                      : 'text-muted'
                  }`}
                />
              ) : (
                <CloudDownload className="h-4 w-4 text-muted" />
              )}
              <span>
                {confirmingRefresh && hasCache && queueCount > 0
                  ? 'Confirm refresh'
                  : hasCache
                    ? 'Refresh offline cache'
                    : 'Download for offline'}
              </span>
            </button>
            {/* Remove from device. Only meaningful when something is
                cached, and we want a hard confirm step because the
                action wipes the deployment's IDB rows. Two-tap pattern
                instead of a separate modal keeps the surface small on
                a phone screen. Queued edits are surfaced as a warning
                line; they will be lost on remove because the records
                are gone with the deployment, so the user gets one
                last chance to sync first. */}
            {hasCache ? (
              <>
                {confirmingRemove && queueCount > 0 ? (
                  <p className="px-2 pt-1 text-[11px] text-rose-600">
                    {queueCount} unsynced edit{queueCount === 1 ? '' : 's'}{' '}
                    will be lost.
                  </p>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    if (!confirmingRemove) {
                      setConfirmingRemove(true);
                      return;
                    }
                    setOpen(false);
                    onRemoveCache();
                  }}
                  disabled={downloadInFlight}
                  className={`flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm disabled:opacity-50 ${
                    confirmingRemove
                      ? 'bg-rose-50 text-rose-700 hover:bg-rose-100'
                      : 'text-ink-0 hover:bg-surface-2'
                  }`}
                >
                  <Trash2
                    className={`h-4 w-4 ${
                      confirmingRemove ? 'text-rose-600' : 'text-muted'
                    }`}
                  />
                  <span>
                    {confirmingRemove
                      ? 'Confirm remove from device'
                      : 'Remove from device'}
                  </span>
                </button>
              </>
            ) : null}
            <div className="px-2 py-1">
              <PwaInstallButton variant="compact" />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Compact pill in the runtime header showing network state. Three
 * variants: green "Online", amber "Offline (cached)" when we have a
 * deployment manifest, red "Offline (no cache)" when we don't and
 * the user can't actually do anything until they reconnect. Tooltip
 * carries the cache timestamp.
 */
function ConnectivityPill({
  isOnline,
  cachedAt,
}: {
  isOnline: boolean;
  cachedAt: string | null;
}) {
  if (isOnline) {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700"
        title="Online: edits sync immediately"
      >
        <Wifi className="h-3 w-3" />
        Online
      </span>
    );
  }
  if (cachedAt) {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700"
        title={`Offline. Cached on ${new Date(cachedAt).toLocaleString()}.`}
      >
        <CloudOff className="h-3 w-3" />
        Offline
      </span>
    );
  }
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[10px] font-medium text-rose-700"
      title="Offline and no cached data for this deployment."
    >
      <CircleSlash className="h-3 w-3" />
      No cache
    </span>
  );
}

/**
 * Queue badge + sync trigger (Slice 5). Renders only when there's
 * something queued; the field worker shouldn't see queue-related
 * chrome during normal online work. Three visual states:
 *
 *   - Online + queued: amber, clickable, runs sync on click.
 *   - Online + syncing: amber + spinner, click-disabled.
 *   - Offline + queued: muted gray, not clickable. Tooltip explains
 *     that sync is paused until reconnect.
 *
 * The count is the live queue depth (pending + failed records). A
 * failed record stays visible here until the next sync run resolves
 * it or the user explicitly drops it from the admin recovery view
 * (which lands later in this slice).
 */
function QueueBadge({
  count,
  syncing,
  isOnline,
  onSync,
}: {
  count: number;
  syncing: boolean;
  isOnline: boolean;
  onSync: () => void;
}) {
  if (!isOnline) {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-muted"
        title={`${count} ${count === 1 ? 'edit' : 'edits'} waiting to sync. Reconnect to send.`}
      >
        <CloudOff className="h-3 w-3" />
        {count} queued
      </span>
    );
  }
  return (
    <button
      type="button"
      disabled={syncing}
      onClick={onSync}
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-60"
      title={`${count} ${count === 1 ? 'edit' : 'edits'} waiting to sync. Click to send now.`}
    >
      {syncing ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <CloudDownload className="h-3 w-3 rotate-180" />
      )}
      {syncing ? 'Syncing...' : `Sync ${count}`}
    </button>
  );
}

/**
 * Persistence-state badge alongside the connectivity pill (Slice 6).
 * Communicates whether the browser will keep our IndexedDB across
 * disk-pressure events so the user can see at a glance whether their
 * cached data + queued edits are protected.
 *
 * Three states:
 *   - 'unknown': we haven't checked yet (rendering nothing avoids a
 *     flash of "Best effort" on a freshly-loaded page).
 *   - 'persistent': muted green dot, no copy. Shows on hover what it
 *     means. Subtle on purpose -- this is the safe state.
 *   - 'best-effort': amber, "Best effort" copy. The user can do
 *     something about it (start a download, which prompts) so the
 *     badge is visible enough to notice.
 *
 * On platforms that don't expose navigator.storage.persist (older
 * Safari, locked-down WebViews) the state stays 'best-effort' since
 * we can't get a positive guarantee. The runtime still works.
 */
function PersistenceBadge({
  state,
}: {
  state: 'unknown' | 'persistent' | 'best-effort';
}) {
  if (state === 'unknown') return null;
  if (state === 'persistent') {
    return (
      <span
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700"
        title="Persistent storage: the browser will not auto-evict your cached deployment or queued edits. Only an explicit Clear browsing data removes it."
      >
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        Persistent
      </span>
    );
  }
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700"
      title="Best-effort storage: the browser may evict your cached data under disk pressure. Starting an offline download prompts to upgrade to persistent."
    >
      <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
      Best effort
    </span>
  );
}

/**
 * Progress modal shown while a download is running and after it
 * finishes. The download manager reports per-phase status; we
 * mirror those phases as a simple list with an icon per state.
 */
function DownloadProgressModal({
  progress,
  onClose,
}: {
  progress: DownloadProgress;
  onClose: () => void;
}) {
  const finished = progress.phase === 'done' || progress.phase === 'failed';
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Download for offline"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface-1 p-4 shadow-overlay">
        <div className="flex items-center gap-2">
          {progress.phase === 'failed' ? (
            <CircleSlash className="h-5 w-5 text-danger" />
          ) : finished ? (
            <Check className="h-5 w-5 text-emerald-600" />
          ) : (
            <Loader2 className="h-5 w-5 animate-spin text-accent" />
          )}
          <h2 className="text-sm font-semibold text-ink-0">
            {progress.phase === 'failed'
              ? 'Download failed'
              : finished
                ? 'Ready for offline'
                : 'Downloading for offline'}
          </h2>
        </div>
        <p className="mt-2 text-xs text-muted">{progress.message}</p>
        {/* Layers leads the breakdown so the user sees a non-zero
            number even on a fresh deployment with no features yet.
            Features, Forms, and Pick lists below are secondary
            detail. */}
        <dl className="mt-3 grid grid-cols-4 gap-2 text-[11px]">
          <div className="rounded border border-border bg-surface-0 p-2 text-center">
            <dt className="text-muted">Layers</dt>
            <dd className="text-sm font-semibold text-ink-0">
              {progress.layerCount}
            </dd>
          </div>
          <div className="rounded border border-border bg-surface-0 p-2 text-center">
            <dt className="text-muted">Features</dt>
            <dd className="text-sm font-semibold text-ink-0">
              {progress.featuresFetched}
            </dd>
          </div>
          <div className="rounded border border-border bg-surface-0 p-2 text-center">
            <dt className="text-muted">Forms</dt>
            <dd className="text-sm font-semibold text-ink-0">
              {progress.formsFetched}
            </dd>
          </div>
          <div className="rounded border border-border bg-surface-0 p-2 text-center">
            <dt className="text-muted">Pick lists</dt>
            <dd className="text-sm font-semibold text-ink-0">
              {progress.pickListsFetched}
            </dd>
          </div>
        </dl>
        {progress.estimatedSize > 0 ? (
          <p className="mt-2 text-[11px] text-muted">
            ~{formatBytes(progress.estimatedSize)} cached
          </p>
        ) : null}
        {progress.error ? (
          <p className="mt-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
            {progress.error}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={!finished}
            className="h-9 rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          >
            {finished ? 'Close' : 'Working...'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Field-mode address search. Lightweight wrapper around the geocode
 * helper at /api/geocode -- no layer-attribute or arcgis-rest
 * search like the desktop SearchBar does, just place lookup so a
 * field worker can type "1234 Main St" and fly there. Per Matt's
 * test feedback (#223.3), this is what users reached for when they
 * mistook the global "Search items" bar for a map address search.
 *
 * Renders as a thin pill that grows on focus. Result selection
 * pans the map to the picked location and highlights it briefly.
 */
function FieldAddressSearch({
  mapRef,
}: {
  mapRef: React.MutableRefObject<maplibregl.Map | null>;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<
    Array<{
      label: string;
      center: [number, number] | null;
      bbox: [number, number, number, number] | null;
    }>
  >([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click so the dropdown doesn't linger when the
  // user pans the map.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // Debounced geocode. Match the desktop SearchBar's 250 ms delay
  // and 3-character minimum so we don't hammer Nominatim.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      setResults([]);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    const handle = setTimeout(() => {
      fetch(`/api/geocode?q=${encodeURIComponent(q)}`, {
        signal: ctrl.signal,
        headers: { Accept: 'application/json' },
      })
        .then((res) => (res.ok ? res.json() : []))
        .then(
          (
            rows: Array<{
              display_name?: string;
              lat?: string;
              lon?: string;
              boundingbox?: [string, string, string, string];
            }>,
          ) => {
            const mapped = rows.map((r) => {
              const lat = Number(r.lat);
              const lon = Number(r.lon);
              const bb = r.boundingbox;
              const bbox =
                bb && bb.length === 4
                  ? ([
                      Number(bb[2]),
                      Number(bb[0]),
                      Number(bb[3]),
                      Number(bb[1]),
                    ] as [number, number, number, number])
                  : null;
              return {
                label: r.display_name ?? '',
                center:
                  Number.isFinite(lat) && Number.isFinite(lon)
                    ? ([lon, lat] as [number, number])
                    : null,
                bbox,
              };
            });
            setResults(mapped);
            setLoading(false);
          },
        )
        .catch(() => {
          setLoading(false);
        });
    }, 250);
    return () => {
      ctrl.abort();
      clearTimeout(handle);
      setLoading(false);
    };
  }, [query]);

  function pick(r: {
    bbox: [number, number, number, number] | null;
    center: [number, number] | null;
  }) {
    const m = mapRef.current;
    if (!m) return;
    if (r.bbox) {
      m.fitBounds(
        [
          [r.bbox[0], r.bbox[1]],
          [r.bbox[2], r.bbox[3]],
        ],
        { padding: 60, duration: 400 },
      );
    } else if (r.center) {
      m.flyTo({ center: r.center, zoom: 16, duration: 400 });
    }
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative w-full">
      <label className="relative block">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
        <input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            if (query.trim().length >= 3) setOpen(true);
          }}
          placeholder="Search address..."
          className="h-9 w-full rounded-md border border-border bg-surface-0 pl-8 pr-8 text-sm text-ink-0 placeholder:text-muted focus:border-accent focus:outline-none"
          aria-label="Search address"
        />
        {query ? (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setResults([]);
              setOpen(false);
            }}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted hover:bg-surface-2"
          >
            <X className="h-3 w-3" />
          </button>
        ) : null}
      </label>
      {open && (loading || results.length > 0) ? (
        <ul className="absolute left-0 right-0 top-full z-30 mt-1 max-h-60 overflow-y-auto rounded-md border border-border bg-surface-1 text-sm shadow-overlay">
          {loading ? (
            <li className="px-3 py-2 text-xs text-muted">Searching...</li>
          ) : null}
          {results.map((r, i) => (
            <li key={`${r.label}-${i}`}>
              <button
                type="button"
                onClick={() => pick(r)}
                className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-surface-2"
              >
                <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate text-xs text-ink-0">
                  {r.label}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Render an ISO timestamp as a relative-friendly string ("2 hours
 * ago", "yesterday", "3 days ago"). Used in the cached-deployment
 * line so the user knows how stale their offline data is at a
 * glance. Falls through to a date string past 30 days.
 */
function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const diffMs = Date.now() - then;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return 'yesterday';
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}
