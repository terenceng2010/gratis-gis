'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  Building2,
  Check,
  ClipboardList,
  ExternalLink,
  Eye,
  FileText,
  FlaskConical,
  Folder as FolderIcon,
  Globe,
  Globe2,
  LayoutDashboard,
  Layers,
  ListChecks,
  Loader2,
  Lock,
  Map as MapIcon,
  Notebook,
  PencilRuler,
  Plug,
  Search,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import type {
  ArcgisServiceData,
  BasemapData,
  DataCollectionData,
  DataLayerDataV3,
  DerivedLayerData,
  FileData,
  ISODateString,
  Item,
  ItemAccess,
  ItemType,
  ServiceData,
  WebAppData,
  WmsServiceData,
  WfsServiceData,
} from '@gratis-gis/shared-types';
import {
  DEFAULT_ARCGIS_SERVICE,
  DEFAULT_BASEMAP,
  DEFAULT_DATA_LAYER_V3,
  DEFAULT_DERIVED_LAYER,
  DEFAULT_GEO_BOUNDARY,
  DEFAULT_PICK_LIST,
  DEFAULT_MAP,
  DEFAULT_WMS_SERVICE,
  DEFAULT_WFS_SERVICE,
  DEFAULT_FOLDER,
  DEFAULT_EDITOR,
  DEFAULT_SURVEY,
  DEFAULT_VIEWER,
  ITEM_TYPES,
  serviceProtocolLabel,
} from '@gratis-gis/shared-types';
import { ImageUploader } from '@/components/image-uploader';
import {
  describeArcgisService,
  probeService,
  type ArcgisServiceDescription,
} from '@/lib/arcgis-rest';
import {
  probeWms,
  probeWfs,
  type OgcCapabilities,
} from '@/lib/ogc-rest';
import {
  probeService as autoProbeService,
  type ServiceProbeResult,
} from '@/lib/service-probe';
import { DataCollectionBuilder } from './data-collection-builder';
import { DataLayerBuilder } from './data-layer-builder';
import { DerivedLayerBuilder } from './derived-layer-builder';
import { MetadataXmlImporter } from './metadata-xml-importer';

/**
 * Two-step "Create a new item" wizard:
 *   1. Pick a type.
 *   2. Fill in metadata + type-specific inputs on one screen.
 *
 * Step 2 is the only place that hits the API. For arcgis_service, the
 * service URL is probed inline and the probe result is baked into the
 * item's `data` at creation time so the detail page lands ready-to-use
 * instead of jumping to a #configure-arcgis anchor.
 */

type Step = 'pick' | 'details';

interface TypeOption {
  /**
   * Picker value. Most options match an actual ItemType. A small set
   * of wizard-only sentinels (e.g. 'viewer' in #259) get remapped to
   * web_app + a template tag at submit time so the storage model
   * stays collapsed while the picker keeps Esri-friendly names.
   */
  value: ItemType | 'viewer' | 'survey';
  label: string;
  desc: string;
  Icon: LucideIcon;
}

// Item types live in five functional groups (#75): Data, Maps, Apps,
// Analysis, Organize. Within each group items are alphabetical so a
// returning user can run their eye to a known option without hunting.
// Group order follows the typical user journey: load data, make a
// map, build apps over it, analyze, then organize.
interface TypeGroup {
  label: string;
  options: TypeOption[];
}

const TYPE_GROUPS: TypeGroup[] = [
  {
    label: 'Data',
    options: [
      {
        value: 'geo_boundary',
        label: 'Boundary',
        desc: 'A named region (polygon) reused across shares, maps, and filters.',
        Icon: MapIcon,
      },
      {
        // #304: unified Connected Service replaces the four
        // protocol-specific tiles (ArcGIS service, WMS service,
        // WFS service, and the not-yet-shipped WMTS). One tile,
        // auto-detect probe -- the wizard figures out the protocol
        // from the URL response so the user doesn't have to know
        // upfront whether they're pointing at a MapServer, a WMS,
        // or a WMTS endpoint.
        value: 'service',
        label: 'Connected service',
        desc: 'Live pointer at an external service. Paste a URL; we recognize ArcGIS REST, WMS, WFS, and WMTS.',
        Icon: Plug,
      },
      {
        value: 'data_layer',
        label: 'Data layer',
        desc: 'A shareable vector layer backed by PostGIS.',
        Icon: Layers,
      },
      {
        value: 'file',
        label: 'File',
        desc: 'Any uploaded file (PDF, image, zip, etc.).',
        Icon: FileText,
      },
      {
        value: 'pick_list',
        label: 'Pick list',
        desc: 'Shared list of codes + labels referenced by fields, forms, and filters.',
        Icon: ListChecks,
      },
    ],
  },
  {
    label: 'Maps',
    options: [
      {
        value: 'basemap',
        label: 'Basemap',
        desc: 'A reusable background layer (style URL, tile template, or WMS) for maps.',
        Icon: Globe,
      },
      {
        value: 'map',
        label: 'Map',
        desc: 'A basemap with overlay layers and styling.',
        Icon: MapIcon,
      },
    ],
  },
  {
    label: 'Apps',
    options: [
      {
        value: 'dashboard',
        label: 'Dashboard',
        desc: 'Live panels showing feature data.',
        Icon: LayoutDashboard,
      },
      {
        value: 'editor',
        label: 'Editor',
        desc: 'Online workspace for adding, editing, and deleting features in one or more data layers.',
        Icon: PencilRuler,
      },
      {
        value: 'viewer',
        label: 'Viewer',
        desc: 'Read-only app for zooming, querying, and printing. No editing tools; layers are presented as-is.',
        Icon: Eye,
      },
      {
        value: 'survey',
        label: 'Survey responses',
        desc: 'Browse a form’s submissions on a map, with click-through to a form-shaped receipt.',
        Icon: ClipboardList,
      },
      {
        value: 'form',
        label: 'Form',
        desc: 'A collection form for fieldwork or survey data. Submissions land in a paired data layer.',
        Icon: FileText,
      },
      {
        value: 'data_collection',
        label: 'Data collection',
        desc: 'Field-mode deployment: tap features on a map to add or edit them. Forms come from the layer schema by default.',
        Icon: ClipboardList,
      },
      {
        value: 'report_template',
        label: 'Report template',
        desc: 'A document template that renders data.',
        Icon: FileText,
      },
      {
        value: 'web_app',
        label: 'Web app',
        desc: 'A configurable app built from widgets.',
        Icon: Sparkles,
      },
    ],
  },
  {
    label: 'Analysis',
    options: [
      {
        value: 'derived_layer',
        label: 'Derived layer',
        desc: 'A layer computed live from another, with tools like buffer.',
        Icon: FlaskConical,
      },
      {
        value: 'notebook',
        label: 'Notebook',
        desc: 'A Jupyter notebook hosted in the portal.',
        Icon: Notebook,
      },
    ],
  },
  {
    label: 'Organize',
    options: [
      {
        value: 'folder',
        label: 'Folder',
        desc: 'A curated grouping of items. Sharing a folder shares the arrangement; per-item access still applies.',
        Icon: FolderIcon,
      },
    ],
  },
];

// Flat fallback used by everything-else-on-the-page (the picked-type
// summary header on step 2, etc.) so we keep the grouped picker
// the single source of label/desc/icon truth.
const TYPE_OPTIONS: TypeOption[] = TYPE_GROUPS.flatMap((g) => g.options);

const ACCESS_OPTIONS: Array<{
  value: ItemAccess;
  label: string;
  desc: string;
  Icon: LucideIcon;
}> = [
  {
    value: 'private',
    label: 'Private',
    desc: 'Only you and people you share with.',
    Icon: Lock,
  },
  {
    value: 'org',
    label: 'Your organization',
    desc: 'Everyone with a login in your org.',
    Icon: Building2,
  },
  {
    value: 'public',
    label: 'Public',
    desc: 'Anyone on the internet.',
    Icon: Globe2,
  },
];

export function NewItemWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Optional `?type=<itemType>` query param lets entry points like the
  // folder rail's "Create one" link, the FolderDetail "+ New
  // subfolder" button, and any future deep-link skip the picker step
  // and land directly on the details form. Validated against the
  // known ItemType set so a stray param can't put the wizard in a
  // bogus state.
  const queryType =
    searchParams && (ITEM_TYPES as readonly string[]).includes(
      searchParams.get('type') ?? '',
    )
      ? ((searchParams.get('type') as ItemType) as ItemType)
      : null;
  const [step, setStep] = useState<Step>(queryType ? 'details' : 'pick');
  // #259: 'viewer' is a wizard-only sentinel that maps to web_app +
  // template='viewer' at submit time. It isn't a persisted ItemType
  // (the picker stays an Esri-friendly noun while the storage stays
  // collapsed under web_app templates).
  const [type, setType] = useState<ItemType | 'viewer' | 'survey' | null>(queryType);

  // Metadata persists across back/forward between steps so the user
  // doesn't lose typed input when they pop back to change type.
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [access, setAccess] = useState<ItemAccess>('private');
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);

  // ArcGIS-specific state. Probe result is staged until Create fires.
  // `userEditedTitle` guards us from clobbering a title the user typed
  // by hand when the probe comes back with a service name.
  const [arcgisUrlDraft, setArcgisUrlDraft] = useState('');
  const [arcgisProbing, setArcgisProbing] = useState(false);
  const [arcgisProbeResult, setArcgisProbeResult] =
    useState<ArcgisServiceDescription | null>(null);
  const [arcgisDefaultLayerId, setArcgisDefaultLayerId] = useState<
    number | null
  >(null);
  // Which layers the user wants to include in this item. Default on
  // probe is 'all layers selected' so the most common case ('I want
  // the whole service') is zero clicks. User can deselect the few
  // they don't want before hitting Create.
  const [arcgisSelectedLayerIds, setArcgisSelectedLayerIds] = useState<
    Set<number>
  >(new Set());
  const arcgisAbortRef = useRef<AbortController | null>(null);
  const userEditedTitleRef = useRef(false);
  const userEditedDescRef = useRef(false);

  // Credential bootstrap (#74). When the anonymous probe gets a
  // 401 / 403 / 499 / "Token Required" we surface the credential
  // form inline instead of failing the wizard. The form drives the
  // probe-with-credential endpoint server-side, then on Create we
  // store the same credential payload against the freshly-created
  // item id so the proxy works without any further setup. The
  // credential plaintext lives in this component for the duration
  // of the wizard only.
  type WizardCredential =
    | { kind: 'arcgis_token'; token: string }
    | { kind: 'bearer'; token: string }
    | { kind: 'basic'; username: string; password: string };
  const [needsAuth, setNeedsAuth] = useState(false);
  // Default is Basic (username + password): it's how ArcGIS Online
  // exposes per-user auth and the most common shape we'll see.
  // The probe endpoint exchanges Basic for a token under the hood
  // for ArcGIS REST URLs so the upstream call goes out as a real
  // token-bearing request (AGO does not honour HTTP Basic). (#76)
  const [credentialKind, setCredentialKind] = useState<
    'arcgis_token' | 'bearer' | 'basic'
  >('basic');
  const [credentialToken, setCredentialToken] = useState('');
  const [credentialUsername, setCredentialUsername] = useState('');
  const [credentialPassword, setCredentialPassword] = useState('');
  // Set once a probe-with-credential succeeds. On Create we POST
  // this to PUT /api/items/:newId/credential so the new item is
  // immediately useable through the proxy.
  const [pendingCredential, setPendingCredential] =
    useState<WizardCredential | null>(null);

  // Feature-service builder state. Stays in v3 shape from the start so
  // the POST body can be sent as-is.
  const [featureServiceData, setDataLayerData] =
    useState<DataLayerDataV3>(DEFAULT_DATA_LAYER_V3);

  // Derived-layer builder state. The recipe (source + pipeline) is
  // structural so the wizard collects it up front rather than starting
  // with an empty scaffold the user fills in on the detail page.
  const [derivedLayerData, setDerivedLayerData] =
    useState<DerivedLayerData>(DEFAULT_DERIVED_LAYER);

  // data_collection wizard state: just the chosen map id. mapId is
  // required at create-time (no map = nothing to deploy), and there's
  // no "configure later" because the rest of the data_collection (form
  // bindings, offline config) is purely additive on the detail page.
  // Field Maps Slice 1 (#141).
  const [dataCollectionMapId, setDataCollectionMapId] = useState<string | null>(
    null,
  );

  // #296: file item upload state. The wizard does the presign + PUT
  // up front so the item is fully populated on create -- no "create
  // empty, then upload" two-step. Null until the user picks a file
  // and the upload completes; submit() blocks on it.
  const [fileItemUpload, setFileItemUpload] = useState<FileData | null>(null);

  // #298: basemap draft state. Captured up front so the wizard
  // writes a fully-configured item (kind + URL + WMS layer list)
  // instead of an empty placeholder. The shape mirrors BasemapData;
  // only fields matching the active kind are meaningful.
  const [basemapDraft, setBasemapDraft] = useState<BasemapData>(DEFAULT_BASEMAP);

  // #304 slice 3: unified Connected Service probe state. Replaces
  // the legacy per-protocol probe state for new items going
  // forward (the legacy state below stays for the deprecation
  // window in case a deep-link or migration script hits a legacy
  // type). Auto-detect probe lives in lib/service-probe.ts; the
  // wizard just stores the result and feeds it to submit() as a
  // ServiceData payload.
  const [serviceUrlDraft, setServiceUrlDraft] = useState<string>('');
  const [serviceProbing, setServiceProbing] = useState(false);
  const [serviceProbeError, setServiceProbeError] = useState<string | null>(null);
  const [serviceProbeResult, setServiceProbeResult] =
    useState<ServiceProbeResult | null>(null);
  const [serviceSelectedLayerNames, setServiceSelectedLayerNames] =
    useState<Set<string>>(new Set());

  // #297: WMS / WFS probe state. Mirrors the ArcGIS probe flow but
  // simpler -- no auth path yet (most public WMS / WFS endpoints are
  // anonymous) and the layer ids are strings, not numbers. The probe
  // result is shaped as OgcCapabilities so the same branch handles
  // both protocols; submit() reads the kind off the result.
  const [ogcUrlDraft, setOgcUrlDraft] = useState<string>('');
  const [ogcProbing, setOgcProbing] = useState(false);
  const [ogcProbeError, setOgcProbeError] = useState<string | null>(null);
  const [ogcProbeResult, setOgcProbeResult] = useState<OgcCapabilities | null>(
    null,
  );
  const [ogcSelectedLayerNames, setOgcSelectedLayerNames] = useState<Set<string>>(
    new Set(),
  );

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const pickType = useCallback((t: ItemType | 'viewer' | 'survey') => {
    setType(t);
    setStep('details');
    setError(null);
  }, []);

  const backToPicker = useCallback(() => {
    setStep('pick');
    setError(null);
  }, []);

  /**
   * Spread a probe result into the wizard's UI state. Shared by
   * the anonymous and credential-aware probe paths so they stay
   * in lockstep on auto-fill / default-pick / select-all logic.
   */
  const applyProbeResult = useCallback(
    (desc: ArcgisServiceDescription) => {
      setArcgisProbeResult(desc);
      if (!userEditedTitleRef.current && !title.trim() && desc.name) {
        setTitle(desc.name);
      }
      if (
        !userEditedDescRef.current &&
        !description.trim() &&
        desc.description
      ) {
        setDescription(desc.description);
      }
      const firstGeom = desc.layers.find((l) => l.geometryType);
      const pick = firstGeom?.id ?? desc.layers[0]?.id ?? null;
      setArcgisDefaultLayerId(pick);
      setArcgisSelectedLayerIds(new Set(desc.layers.map((l) => l.id)));
    },
    [title, description],
  );

  /**
   * Recognise the upstream "needs auth" signal across the various
   * shapes ArcGIS / WMS / WFS use. ArcGIS can either emit a real
   * 401/403 or a 200 envelope with code 498/499. WMS/WFS usually
   * just 401. We fold them all into the same UX path.
   */
  function isAuthError(err: unknown): boolean {
    if (!err) return false;
    const msg = err instanceof Error ? err.message : String(err);
    return (
      /\b(401|403|498|499)\b/.test(msg) ||
      /token\s*required/i.test(msg) ||
      /not\s*authorized/i.test(msg) ||
      /unauthor/i.test(msg)
    );
  }

  const runArcgisProbe = useCallback(async () => {
    const raw = arcgisUrlDraft.trim();
    if (!raw) {
      setError('Paste an ArcGIS MapServer or FeatureServer URL.');
      return;
    }
    setError(null);
    setNeedsAuth(false);
    setPendingCredential(null);
    arcgisAbortRef.current?.abort();
    const controller = new AbortController();
    arcgisAbortRef.current = controller;
    setArcgisProbing(true);
    try {
      const desc = await probeService(raw, controller.signal);
      if (controller.signal.aborted) return;
      applyProbeResult(desc);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      // Auth-shaped failure: switch to the credential form instead
      // of giving up. The user fills it in and we re-probe through
      // the server-side endpoint. (#74)
      if (isAuthError(err)) {
        setNeedsAuth(true);
        setError(
          'This service requires authentication. Pick a credential type and provide the secret to continue.',
        );
        return;
      }
      setError(
        (err as Error).message ||
          'Could not read that service. Check the URL and CORS config.',
      );
    } finally {
      if (!controller.signal.aborted) setArcgisProbing(false);
    }
  }, [arcgisUrlDraft, applyProbeResult]);

  /**
   * #304 slice 3: unified Connected Service probe runner. Hits
   * lib/service-probe.ts which auto-detects ArcGIS REST / WMS /
   * WFS / WMTS, then stages the resulting ServiceData on
   * serviceProbeResult so the rest of the wizard can render the
   * picker + submit. Selects every probed layer by default so a
   * "probe -> Create" flow yields a complete item without picker
   * interaction; the user only touches the picker to curate.
   */
  const runServiceProbe = useCallback(async () => {
    const raw = serviceUrlDraft.trim();
    if (!raw) {
      setServiceProbeError('Paste a service URL.');
      return;
    }
    setServiceProbeError(null);
    setServiceProbing(true);
    try {
      const result = await autoProbeService(raw);
      setServiceProbeResult(result);
      setServiceSelectedLayerNames(
        new Set(result.data.layers.map((l) => l.name)),
      );
    } catch (err) {
      setServiceProbeError(
        err instanceof Error
          ? err.message
          : 'Could not identify that service. Check the URL and CORS config.',
      );
      setServiceProbeResult(null);
      setServiceSelectedLayerNames(new Set());
    } finally {
      setServiceProbing(false);
    }
  }, [serviceUrlDraft]);

  /**
   * #297 OGC probe runner. Fires a GetCapabilities against the user-
   * supplied URL, parses the response, and lights up the layer picker.
   * Selects all layers by default so a "Probe -> Create" flow yields
   * a complete item without extra clicks. Selection is per-protocol
   * (WMS layer Name / WFS typeName) and stored as a string set.
   */
  const runOgcProbe = useCallback(async () => {
    const raw = ogcUrlDraft.trim();
    if (!raw) {
      setOgcProbeError(
        type === 'wfs_service'
          ? 'Paste a WFS endpoint URL (the GetCapabilities base, no query string).'
          : 'Paste a WMS endpoint URL (the GetCapabilities base, no query string).',
      );
      return;
    }
    setOgcProbeError(null);
    setOgcProbing(true);
    try {
      const result =
        type === 'wfs_service' ? await probeWfs(raw) : await probeWms(raw);
      setOgcProbeResult(result);
      setOgcSelectedLayerNames(new Set(result.layers.map((l) => l.name)));
    } catch (err) {
      setOgcProbeError(
        err instanceof Error
          ? err.message
          : 'Could not read that service. Check the URL and CORS config.',
      );
      setOgcProbeResult(null);
      setOgcSelectedLayerNames(new Set());
    } finally {
      setOgcProbing(false);
    }
  }, [ogcUrlDraft, type]);

  /**
   * Probe with a user-supplied credential via the server-side
   * /api/portal/services/probe endpoint. Same response shape as
   * the anonymous client probe so applyProbeResult reuses the
   * existing UI logic. Stashes the credential into pendingCredential
   * so we can save it against the new item id at Create time.
   */
  const runArcgisProbeWithCredential = useCallback(async () => {
    const raw = arcgisUrlDraft.trim();
    if (!raw) {
      setError('Paste an ArcGIS MapServer or FeatureServer URL.');
      return;
    }
    let cred: WizardCredential;
    if (credentialKind === 'arcgis_token' || credentialKind === 'bearer') {
      const token = credentialToken.trim();
      if (!token) {
        setError('Token is required for this credential type.');
        return;
      }
      cred = { kind: credentialKind, token };
    } else {
      const u = credentialUsername.trim();
      const p = credentialPassword;
      if (!u || !p) {
        setError('Username and password are required for basic auth.');
        return;
      }
      cred = { kind: 'basic', username: u, password: p };
    }
    setError(null);
    arcgisAbortRef.current?.abort();
    const controller = new AbortController();
    arcgisAbortRef.current = controller;
    setArcgisProbing(true);
    try {
      const res = await fetch('/api/portal/services/probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: raw, credential: cred }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        setError(
          `Probe failed: ${res.status}${text ? ` - ${text.slice(0, 200)}` : ''}`,
        );
        return;
      }
      const wrapped = (await res.json()) as {
        ok: boolean;
        status: number;
        statusText?: string;
        body?: unknown;
      };
      if (controller.signal.aborted) return;
      if (!wrapped.ok) {
        setError(
          wrapped.statusText ||
            `Upstream returned ${wrapped.status}. Check the credential and try again.`,
        );
        return;
      }
      // Re-shape the upstream JSON into the same ArcgisServiceDescription
      // the client probe produces. describeArcgisService is the
      // pure parser shared with probeService so the two paths stay
      // in lockstep on layer/table/bbox extraction.
      let desc: ArcgisServiceDescription;
      try {
        desc = await describeArcgisService(
          raw,
          wrapped.body,
          controller.signal,
        );
      } catch (parseErr) {
        setError(
          (parseErr as Error).message ||
            'Probe succeeded but the response did not look like an ArcGIS service.',
        );
        return;
      }
      applyProbeResult(desc);
      setPendingCredential(cred);
      setNeedsAuth(false);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      setError(
        (err as Error).message ||
          'Could not reach the probe endpoint. Try again in a moment.',
      );
    } finally {
      if (!controller.signal.aborted) setArcgisProbing(false);
    }
  }, [
    arcgisUrlDraft,
    credentialKind,
    credentialToken,
    credentialUsername,
    credentialPassword,
    applyProbeResult,
  ]);

  async function submit() {
    if (!type) return;
    setError(null);
    if (title.trim().length === 0) {
      setError('Title is required.');
      return;
    }

    // For arcgis_service we require a successful probe so the item
    // lands fully configured. Everything else uses its default scaffold.
    let data: unknown;
    if (type === 'arcgis_service') {
      if (!arcgisProbeResult) {
        setError(
          'Probe the ArcGIS service URL before creating the item so the layer list is captured.',
        );
        return;
      }
      // Validate: selection must be non-empty. A zero-layer item
      // would be a dead reference nobody can use.
      if (arcgisSelectedLayerIds.size === 0) {
        setError(
          'Select at least one layer to include in this item. All layers are selected by default after probe.',
        );
        return;
      }
      // Default layer must be one of the selected layers - otherwise
      // a map consuming this item would land on a layer the item
      // claims not to own.
      const effectiveDefault =
        arcgisDefaultLayerId !== null &&
        arcgisSelectedLayerIds.has(arcgisDefaultLayerId)
          ? arcgisDefaultLayerId
          : (Array.from(arcgisSelectedLayerIds)[0] ?? null);
      const staged: ArcgisServiceData = {
        ...DEFAULT_ARCGIS_SERVICE,
        url: arcgisProbeResult.url,
        serviceType: arcgisProbeResult.serviceType,
        layers: arcgisProbeResult.layers.map((l) => {
          const base: { id: number; name: string; geometryType?: string } = {
            id: l.id,
            name: l.name,
          };
          if (l.geometryType) base.geometryType = l.geometryType;
          return base;
        }),
        selectedLayerIds: Array.from(arcgisSelectedLayerIds).sort(
          (a, b) => a - b,
        ),
        ...(arcgisProbeResult.bbox ? { bbox: arcgisProbeResult.bbox } : {}),
        ...(effectiveDefault !== null
          ? { defaultLayerId: effectiveDefault }
          : {}),
        // requiresAuth flips on automatically when a credential was
        // used during probe. The credential payload is saved against
        // the new item id immediately after create (#74) so the proxy
        // works without further setup.
        requiresAuth: pendingCredential !== null,
        probedAt: new Date().toISOString() as ISODateString,
      };
      data = staged;
    } else if (type === 'map') {
      data = DEFAULT_MAP;
    } else if (type === 'data_layer') {
      // Gentle validation: require at least one layer, each labeled.
      // Anything beyond that is advisory - a user may legitimately
      // want an empty layer to start and populate later.
      const missing = featureServiceData.layers.find(
        (l) => !l.label.trim() || !l.name.trim(),
      );
      if (missing) {
        setError(
          'Each layer needs a label and a table name before you create the item.',
        );
        return;
      }
      // Field name uniqueness within a layer - PostGIS won't let two
      // columns share a name, so catch it here before the server
      // has to reject the create.
      for (const layer of featureServiceData.layers) {
        const names = layer.fields.map((f) => f.name).filter(Boolean);
        const dupes = names.filter((n, i) => names.indexOf(n) !== i);
        if (dupes.length > 0) {
          setError(
            `Layer "${layer.label}" has duplicate field name(s): ${[
              ...new Set(dupes),
            ].join(', ')}.`,
          );
          return;
        }
      }
      data = featureServiceData;
    } else if (type === 'pick_list') {
      // Start a pick list empty. The detail-page editor handles
      // manual entry, CSV / XLSX upload, and paste-from-clipboard
      // import, so the wizard doesn't need a custom builder step.
      data = DEFAULT_PICK_LIST;
    } else if (type === 'geo_boundary') {
      // Start an empty boundary; detail-page editor lets the user
      // draw, upload, or paste the geometry.
      data = DEFAULT_GEO_BOUNDARY;
    } else if (type === 'basemap') {
      // #298: source-aware basemap authoring. The wizard collects the
      // source kind + the URL / WMS config the renderer needs so the
      // item lands fully configured. Empty kind/URL falls back to the
      // empty scaffold so a user can still create a placeholder and
      // fill it in on the detail page.
      if (basemapDraft && basemapDraft.kind) {
        if (basemapDraft.kind === 'tile-url' && !basemapDraft.tileUrl?.trim()) {
          setError('Tile URL is required (XYZ template like https://.../{z}/{x}/{y}.png).');
          return;
        }
        if (basemapDraft.kind === 'style-url' && !basemapDraft.styleUrl?.trim()) {
          setError('Style URL is required (a hosted style.json).');
          return;
        }
        if (basemapDraft.kind === 'wms') {
          if (!basemapDraft.wmsUrl?.trim()) {
            setError('WMS GetMap URL is required.');
            return;
          }
          if (!basemapDraft.wmsConfig?.layers?.trim()) {
            setError('At least one WMS layer name is required.');
            return;
          }
        }
        data = basemapDraft;
      } else {
        data = DEFAULT_BASEMAP;
      }
    } else if (type === 'wms_service' || type === 'wfs_service') {
      // #297: WMS / WFS items now ship with a probe-or-bail wizard
      // step. The picker writes a fully-configured item (URL, layer
      // list, selectedLayerIds defaulting to "all") so the detail
      // page lands ready-to-render. Same shape pattern as
      // arcgis_service.
      if (
        !ogcProbeResult ||
        ogcProbeResult.kind !== (type === 'wms_service' ? 'wms' : 'wfs')
      ) {
        setError(
          type === 'wfs_service'
            ? 'Probe the WFS service URL before creating the item.'
            : 'Probe the WMS service URL before creating the item.',
        );
        return;
      }
      if (ogcSelectedLayerNames.size === 0) {
        setError('Select at least one layer to include in this item.');
        return;
      }
      // selectedLayerIds is typed as number[] (predates the OGC
      // types). For OGC services we use the layer's index in the
      // probed list; the canonical name lives on layers[i].name.
      const ids: number[] = [];
      ogcProbeResult.layers.forEach((l, i) => {
        if (ogcSelectedLayerNames.has(l.name)) ids.push(i);
      });
      if (type === 'wms_service' && ogcProbeResult.kind === 'wms') {
        const wms: WmsServiceData = {
          version: 1,
          url: ogcProbeResult.url,
          protocolVersion: ogcProbeResult.protocolVersion,
          format: 'image/png',
          transparent: true,
          crs: 'EPSG:3857',
          layers: ogcProbeResult.layers.map((l) => {
            const out: WmsServiceData['layers'][number] = {
              name: l.name,
              title: l.title,
            };
            if (l.bbox) out.bbox = l.bbox;
            return out;
          }),
          selectedLayerIds: ids,
          ...(ogcProbeResult.bbox ? { bbox: ogcProbeResult.bbox } : {}),
          probedAt: new Date().toISOString() as ISODateString,
        };
        data = wms;
      } else if (type === 'wfs_service' && ogcProbeResult.kind === 'wfs') {
        const wfs: WfsServiceData = {
          version: 1,
          url: ogcProbeResult.url,
          protocolVersion: ogcProbeResult.protocolVersion,
          outputFormat: 'application/json',
          layers: ogcProbeResult.layers.map((l) => {
            const out: WfsServiceData['layers'][number] = {
              name: l.name,
              title: l.title,
            };
            if (l.bbox) out.bbox = l.bbox;
            return out;
          }),
          selectedLayerIds: ids,
          ...(ogcProbeResult.bbox ? { bbox: ogcProbeResult.bbox } : {}),
          probedAt: new Date().toISOString() as ISODateString,
        };
        data = wfs;
      }
    } else if (type === 'folder') {
      // Empty folder; the detail page handles adding children via the
      // "Add to folder" multi-select and drag-drop in Phase 1b.
      data = DEFAULT_FOLDER;
    } else if (type === 'editor') {
      // #258: new editor items go in as web_app + template='editor'
      // directly so we don't keep accumulating legacy `type='editor'`
      // rows during the deprecation window. The user-facing word
      // stays "Editor" (see the picker option above) but the persisted
      // shape is the consolidated WebAppData. readEditorData() unwraps
      // the nested EditorData on read; isEditorItem() identifies
      // these rows for routing and policy.
      //
      // The detail page handles target-layer configuration and
      // template authoring on top of an empty editor scaffold. The
      // runtime renders an empty-state prompt until the first target
      // is added. See docs/editing-and-collection.md.
      const webApp: WebAppData = {
        version: 1,
        template: 'editor',
        config: { template: 'editor', editor: DEFAULT_EDITOR },
      };
      data = webApp;
    } else if (type === 'viewer') {
      // #259: viewer items go in as web_app + template='viewer' from
      // day one (no legacy top-level type='viewer' to migrate from).
      // Same shape pattern as the editor branch above; the runtime
      // and detail-page dispatch unwrap via readViewerData /
      // isViewerItem. Empty targets + map; the detail page wires
      // those up post-create.
      const webApp: WebAppData = {
        version: 1,
        template: 'viewer',
        config: { template: 'viewer', viewer: DEFAULT_VIEWER },
      };
      data = webApp;
    } else if (type === 'survey') {
      // #260: survey response viewer. Empty defaults; the detail page
      // gates Open until the author binds a form. Same WebAppData
      // wrapper pattern as editor/viewer.
      const webApp: WebAppData = {
        version: 1,
        template: 'survey',
        config: { template: 'survey', survey: DEFAULT_SURVEY },
      };
      data = webApp;
    } else if (type === 'data_collection') {
      // mapId is structural: a data_collection without a map has
      // nothing for collectors to tap on. Block create until the
      // wizard's map picker has resolved a choice. Form bindings and
      // offline config stay defaulted-empty; the field-mode runtime
      // falls through to schema-derived forms (Field Maps default)
      // and online-only mode until an author opts in on the detail
      // page.
      if (!dataCollectionMapId) {
        setError('Pick a map for this data collection.');
        return;
      }
      const dc: DataCollectionData = {
        version: 1,
        mapId: dataCollectionMapId,
      };
      data = dc;
    } else if (type === 'service') {
      // #304 slice 3: unified Connected Service probe-or-bail.
      // The wizard requires a successful auto-detect probe so the
      // new item lands fully configured (URL, protocol, layer
      // list, default selection). Selection by name makes re-
      // probe later resilient to layer reorderings.
      if (!serviceProbeResult) {
        setError('Probe the service URL before creating the item.');
        return;
      }
      if (serviceSelectedLayerNames.size === 0) {
        setError('Select at least one layer to include in this item.');
        return;
      }
      const probedData = serviceProbeResult.data;
      const ids: number[] = [];
      probedData.layers.forEach((l, i) => {
        if (serviceSelectedLayerNames.has(l.name)) ids.push(i);
      });
      const payload: ServiceData = {
        ...probedData,
        selectedLayerIds: ids,
      };
      data = payload;
    } else if (type === 'file') {
      // #296: the wizard already presigned + PUT the file when the
      // user picked it; we just have to require the upload finished
      // and stamp it onto the item's data here. No bytes flow through
      // the API; we only persist the metadata.
      if (!fileItemUpload) {
        setError('Choose a file to upload before creating the item.');
        return;
      }
      data = fileItemUpload;
    } else if (type === 'derived_layer') {
      // The wizard's DerivedLayerBuilder gathers the source layer +
      // pipeline up front (the recipe is structural, not optional).
      // Bail out with a friendly error if the user clicked Create
      // without picking a source / configuring a tool.
      if (!derivedLayerData) {
        setError('Pick a source data layer and configure at least one tool.');
        return;
      }
      const src = derivedLayerData.source;
      if (!src || !src.itemId) {
        setError('Pick a source data layer for this derived layer.');
        return;
      }
      if (
        !Array.isArray(derivedLayerData.pipeline) ||
        derivedLayerData.pipeline.length === 0
      ) {
        setError('Add at least one tool step to the pipeline.');
        return;
      }
      data = derivedLayerData;
    } else {
      data = {};
    }

    // #258: the picker still surfaces an "Editor" option that sets
    // type='editor' so the rest of the wizard's gating, validation,
    // and copy reads naturally. The persisted shape is web_app +
    // template='editor' though, so swap the type here at the
    // payload-build boundary. Keeps the user-facing word stable
    // while we collapse the storage model.
    const payloadType: ItemType =
      type === 'editor' || type === 'viewer' || type === 'survey'
        ? 'web_app'
        : type;

    const payload = {
      type: payloadType,
      title: title.trim(),
      description: description.trim(),
      tags: tagsText
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
      access,
      thumbnailUrl,
      data,
    };

    setSubmitting(true);
    try {
      const res = await fetch('/api/portal/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        setError(
          `Create failed: ${res.status}${body ? ` - ${body}` : ''}`,
        );
        return;
      }
      // Parse defensively - a missing / malformed body used to fall
      // through silently and leave the user stranded on the create
      // page with no redirect and no error.
      let saved: Item | null = null;
      try {
        saved = (await res.json()) as Item;
      } catch (parseErr) {
        console.error('Create succeeded but response was not JSON:', parseErr);
      }
      if (!saved?.id) {
        // API accepted the payload but we can't navigate to the detail
        // page. Fall back to the items list so the user still sees
        // their new item and knows the create worked.
        startTransition(() => router.push('/items'));
        return;
      }

      // Save the credential against the freshly-created item so the
      // proxy works without manual setup (#74). Best-effort: a failure
      // here surfaces as an inline warning but the item still
      // exists, and the credentials card on the detail page can be
      // used to retry. We don't roll back the item on auth-save
      // failure -- that would lose the user's other typed metadata
      // and require restarting the wizard.
      if (pendingCredential) {
        // Snapshot what we're about to send and immediately clear
        // the in-component plaintext copies (#79). Once it's en
        // route to the API the wizard has no further use for it,
        // and not holding it in state means dev tools can't read
        // it off React internals after Create lands.
        const credToSend = pendingCredential;
        setPendingCredential(null);
        setCredentialToken('');
        setCredentialUsername('');
        setCredentialPassword('');
        try {
          const credRes = await fetch(
            `/api/portal/items/${saved.id}/credential`,
            {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(credToSend),
            },
          );
          if (!credRes.ok) {
            // Surface the actual server response so the user (and
            // logs) can see why the save bounced. Earlier we only
            // showed the status code which left bugs invisible
            // (e.g. server-side validation rejecting the payload
            // shape would just show "(400)" with no clue about
            // which field). #79
            const credText = await credRes.text().catch(() => '');
            let reason = '';
            try {
              const body = JSON.parse(credText) as {
                message?: string | string[];
              };
              const msg = body.message;
              if (Array.isArray(msg)) reason = msg.join('; ');
              else if (typeof msg === 'string') reason = msg;
            } catch {
              reason = credText;
            }
            console.error(
              `Saved item ${saved.id} but credential write failed: ${credRes.status} ${credText}`,
            );
            setError(
              `Item created, but the credential did not save (${credRes.status}${
                reason ? `: ${reason.slice(0, 200)}` : ''
              }). Open the item detail page to set it manually.`,
            );
            // Still navigate so the user lands on the new item and
            // can retry the credential save from its detail page.
          }
        } catch (credErr) {
          console.error('Credential save threw:', credErr);
          setError(
            `Item created, but the credential did not save (${
              credErr instanceof Error ? credErr.message : 'network error'
            }). Open the item detail page to set it manually.`,
          );
        }
      }
      // If the wizard was opened from inside a folder ("+ New
      // subfolder" on the folder detail page), append the freshly-
      // created item to that parent folder's childItemIds so the
      // subfolder actually appears under its parent. Without this
      // step the new folder is a sibling at top-level and the
      // parent's contents look unchanged. We do it client-side as a
      // follow-up PATCH rather than baking it into POST /items so
      // the API surface stays simple. Failure is surfaced inline
      // (the new item still exists; the user can manually drag it
      // into the parent later).
      const parentFolderId = searchParams?.get('parentFolderId') ?? null;
      if (parentFolderId) {
        try {
          const pr = await fetch(`/api/portal/items/${parentFolderId}`);
          if (pr.ok) {
            const parent = (await pr.json()) as {
              type: string;
              data: { childItemIds?: unknown } | null;
            };
            if (parent.type === 'folder') {
              const existing = Array.isArray(parent.data?.childItemIds)
                ? (parent.data!.childItemIds as unknown[]).filter(
                    (x): x is string => typeof x === 'string',
                  )
                : [];
              if (!existing.includes(saved.id)) {
                const next = {
                  version: 1,
                  childItemIds: [...existing, saved.id],
                };
                await fetch(`/api/portal/items/${parentFolderId}`, {
                  method: 'PATCH',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ data: next }),
                });
              }
            }
          }
        } catch (parentErr) {
          console.error('Could not append to parent folder:', parentErr);
        }
        // Land the user back on the parent folder detail page so the
        // new subfolder is visible in its parent's contents.
        startTransition(() => router.push(`/items/${parentFolderId}`));
        return;
      }

      // data_layer still wants the ingest panel front and centre.
      // arcgis_service no longer needs #configure-arcgis because we baked
      // the probed config into dataJson above.
      const anchor = type === 'data_layer' ? '#add-data' : '';
      startTransition(() => router.push(`/items/${saved.id}${anchor}`));
    } catch (err) {
      // Network failure or thrown error inside fetch - surface it
      // rather than leaving the user staring at a silent form.
      console.error('Create request failed:', err);
      setError(
        `Create failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (step === 'pick') {
    return (
      <div className="space-y-8">
        {TYPE_GROUPS.map((group) => (
          <section key={group.label}>
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">
              {group.label}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {group.options.map((opt) => {
                const { Icon } = opt;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => pickType(opt.value)}
                    className="flex items-start gap-3 rounded-lg border border-border bg-surface-1 p-4 text-left shadow-card transition-colors hover:border-accent/50 hover:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-accent/30"
                  >
                    <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
                      <Icon className="h-5 w-5" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-ink-0">
                        {opt.label}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted">
                        {opt.desc}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    );
  }

  // step === 'details'
  const typeOption = TYPE_OPTIONS.find((o) => o.value === type);
  const TypeIcon = typeOption?.Icon ?? Sparkles;

  return (
    <div className="space-y-8">
      {/* Selected-type header with back link. Keeps the user oriented
          without forcing a full page nav. */}
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-1 px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-accent/10 text-accent">
            <TypeIcon className="h-5 w-5" />
          </span>
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
              New {typeOption?.label ?? 'item'}
            </p>
            <p className="text-sm text-ink-0">{typeOption?.desc}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={backToPicker}
          className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-surface-1 px-2 text-xs text-muted hover:bg-surface-2 hover:text-ink-1"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Change type
        </button>
      </div>

      {/* Metadata (thumbnail, title, description, tags, visibility) runs
          above the type-specific builder so the item's identity is
          established before diving into schema. Matches the user's
          mental model: "I'm creating a <thing> called <name>" reads
          left-to-right instead of schema-first. */}

      <MetadataXmlImporter
        onApply={({ title: t, description: d, tags: ts }) => {
          if (t) {
            setTitle(t);
            userEditedTitleRef.current = true;
          }
          if (d) {
            setDescription(d);
            userEditedDescRef.current = true;
          }
          if (ts && ts.length > 0) setTagsText(ts.join(', '));
        }}
      />

      <section>
        <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted">
          Thumbnail
        </label>
        <ImageUploader
          kind="item-thumb"
          value={thumbnailUrl}
          onChange={setThumbnailUrl}
          seed={title || 'new-item'}
          label={title || 'New item'}
          size="xl"
          rounded="md"
        />
      </section>

      <section className="space-y-4">
        <div>
          <label
            htmlFor="title"
            className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted"
          >
            Title
          </label>
          <input
            id="title"
            type="text"
            value={title}
            onChange={(e) => {
              userEditedTitleRef.current = true;
              setTitle(e.target.value);
            }}
            placeholder="My layer, report, form..."
            maxLength={200}
            className="h-10 w-full rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </div>

        <div>
          <label
            htmlFor="description"
            className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted"
          >
            Description
          </label>
          <textarea
            id="description"
            value={description}
            onChange={(e) => {
              userEditedDescRef.current = true;
              setDescription(e.target.value);
            }}
            placeholder="What is this, and who's it for?"
            maxLength={5000}
            rows={4}
            className="w-full rounded-md border border-border bg-surface-1 px-3 py-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </div>

        <div>
          <label
            htmlFor="tags"
            className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted"
          >
            Tags
          </label>
          <input
            id="tags"
            type="text"
            value={tagsText}
            onChange={(e) => setTagsText(e.target.value)}
            placeholder="Comma separated, e.g. buildings, parcels, campus"
            className="h-10 w-full rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
          <p className="mt-1 text-xs text-muted">
            Used for search and filtering.
          </p>
        </div>
      </section>

      <section>
        <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted">
          Visibility
        </label>
        <div className="grid grid-cols-3 gap-2" role="radiogroup">
          {ACCESS_OPTIONS.map(({ value, label, desc, Icon }) => {
            const selected = access === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setAccess(value)}
                className={`flex flex-col items-start gap-1 rounded-md border p-3 text-left transition-colors ${
                  selected
                    ? 'border-accent bg-accent/5 ring-2 ring-accent/30'
                    : 'border-border bg-surface-1 hover:bg-surface-2'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Icon
                    className={`h-4 w-4 ${selected ? 'text-accent' : 'text-muted'}`}
                  />
                  <span className="text-sm font-medium text-ink-1">
                    {label}
                  </span>
                </div>
                <span className="text-xs text-muted">{desc}</span>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-muted">
          You can change this later and add explicit shares from the item
          detail page.
        </p>
      </section>

      {/* Type-specific builder / probe / etc. goes at the end of the
          form, closest to the Create button, so the user's last
          interaction before submit is with the thing that's actually
          special about this item type. */}
      {type === 'arcgis_service' ? (
        <ArcgisConfigSection
          urlDraft={arcgisUrlDraft}
          onUrlChange={setArcgisUrlDraft}
          probing={arcgisProbing}
          probeResult={arcgisProbeResult}
          defaultLayerId={arcgisDefaultLayerId}
          onDefaultLayerChange={setArcgisDefaultLayerId}
          selectedLayerIds={arcgisSelectedLayerIds}
          onSelectedLayerIdsChange={setArcgisSelectedLayerIds}
          onProbe={runArcgisProbe}
          onDiscardProbe={() => {
            setArcgisProbeResult(null);
            setArcgisSelectedLayerIds(new Set());
            setNeedsAuth(false);
            setPendingCredential(null);
          }}
          needsAuth={needsAuth}
          credentialKind={credentialKind}
          onCredentialKindChange={setCredentialKind}
          credentialToken={credentialToken}
          onCredentialTokenChange={setCredentialToken}
          credentialUsername={credentialUsername}
          onCredentialUsernameChange={setCredentialUsername}
          credentialPassword={credentialPassword}
          onCredentialPasswordChange={setCredentialPassword}
          onProbeWithCredential={runArcgisProbeWithCredential}
          credentialUsed={pendingCredential !== null}
        />
      ) : null}

      {type === 'data_layer' ? (
        <DataLayerBuilder
          value={featureServiceData}
          onChange={setDataLayerData}
        />
      ) : null}

      {type === 'derived_layer' ? (
        <DerivedLayerBuilder
          value={derivedLayerData}
          onChange={setDerivedLayerData}
        />
      ) : null}

      {type === 'data_collection' ? (
        <DataCollectionBuilder
          value={dataCollectionMapId}
          onChange={setDataCollectionMapId}
        />
      ) : null}

      {type === 'file' ? (
        <FileItemUploader value={fileItemUpload} onChange={setFileItemUpload} />
      ) : null}

      {type === 'basemap' ? (
        <BasemapConfigSection value={basemapDraft} onChange={setBasemapDraft} />
      ) : null}

      {type === 'service' ? (
        <ServiceConfigSection
          urlDraft={serviceUrlDraft}
          onUrlChange={setServiceUrlDraft}
          probing={serviceProbing}
          probeError={serviceProbeError}
          probeResult={serviceProbeResult}
          selectedLayerNames={serviceSelectedLayerNames}
          onSelectedLayerNamesChange={setServiceSelectedLayerNames}
          onProbe={runServiceProbe}
          onDiscardProbe={() => {
            setServiceProbeResult(null);
            setServiceSelectedLayerNames(new Set());
            setServiceProbeError(null);
          }}
        />
      ) : null}

      {type === 'wms_service' || type === 'wfs_service' ? (
        <OgcConfigSection
          kind={type === 'wms_service' ? 'wms' : 'wfs'}
          urlDraft={ogcUrlDraft}
          onUrlChange={setOgcUrlDraft}
          probing={ogcProbing}
          probeError={ogcProbeError}
          probeResult={ogcProbeResult}
          selectedLayerNames={ogcSelectedLayerNames}
          onSelectedLayerNamesChange={setOgcSelectedLayerNames}
          onProbe={runOgcProbe}
          onDiscardProbe={() => {
            setOgcProbeResult(null);
            setOgcSelectedLayerNames(new Set());
            setOgcProbeError(null);
          }}
        />
      ) : null}

      {error ? (
        <div
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
          role="alert"
        >
          {error}
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={backToPicker}
          disabled={submitting}
          className="h-10 rounded-md border border-border bg-surface-1 px-4 text-sm text-ink-1 hover:bg-surface-2 disabled:opacity-50"
        >
          Back
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={submitting}
          className="inline-flex h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
          Create item
        </button>
      </div>
    </div>
  );
}

/**
 * Wizard pane for type='file' (#296). Picks one file from the user's
 * disk, presigns + PUTs it to MinIO, and reports the resulting
 * FileData up to the wizard. Same direct-to-MinIO pattern the form
 * runtime + ImageUploader use, just with the bigger 100 MB cap and
 * the any-MIME relaxation the storage service grants the
 * 'item-file' kind.
 *
 * Once the upload completes the user sees the file metadata + a
 * "Replace" button to reupload. The wizard's submit() blocks until
 * an upload is registered.
 */
function FileItemUploader({
  value,
  onChange,
}: {
  value: FileData | null;
  onChange: (next: FileData | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setError(null);
    setBusy(true);
    try {
      const presignRes = await fetch('/api/portal/storage/presign-upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'item-file',
          contentType: file.type || 'application/octet-stream',
        }),
      });
      if (!presignRes.ok) {
        setError(`Could not start upload: ${presignRes.status}`);
        return;
      }
      const { uploadUrl, publicUrl, key, maxBytes } =
        (await presignRes.json()) as {
          uploadUrl: string;
          publicUrl: string;
          key: string;
          maxBytes: number;
        };
      if (file.size > maxBytes) {
        const maxMb = Math.round(maxBytes / (1024 * 1024));
        setError(`File too large. Max is ${maxMb} MB.`);
        return;
      }

      const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': file.type || 'application/octet-stream' },
        body: file,
      });
      if (!putRes.ok) {
        setError(`Upload failed: ${putRes.status}`);
        return;
      }

      onChange({
        version: 1,
        storageKey: key,
        storageUrl: publicUrl,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        uploadedAt: new Date().toISOString() as ISODateString,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface-1 p-4">
      <h2 className="mb-1 text-sm font-medium text-ink-0">File</h2>
      <p className="mb-3 text-xs text-muted">
        Pick the file to upload. Max 100 MB. Stays on your portal&rsquo;s
        own storage; no third-party services.
      </p>
      {value ? (
        <div className="flex items-start gap-3 rounded-md border border-border bg-surface-2 p-3 text-sm">
          <FileText className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium text-ink-0">
              {value.fileName}
            </div>
            <div className="mt-0.5 text-xs text-muted">
              {humanFileSize(value.sizeBytes)} &middot;{' '}
              <span className="font-mono">{value.mimeType}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              onChange(null);
              inputRef.current?.click();
            }}
            disabled={busy}
            className="h-8 shrink-0 rounded-md border border-border bg-surface-1 px-3 text-xs text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          >
            Replace
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="inline-flex h-10 items-center gap-2 rounded-md border border-dashed border-border bg-surface-2 px-4 text-sm text-ink-1 hover:bg-surface-1 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <FileText className="h-4 w-4" />
          )}
          {busy ? 'Uploading...' : 'Choose a file'}
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          // Reset so re-picking the same file fires onChange again.
          e.target.value = '';
        }}
      />
      {error ? (
        <p className="mt-2 text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Wizard pane for type='service' (#304 slice 3).
 *
 * Single entry point that replaces the four protocol-specific
 * tiles (ArcGIS service, WMS service, WFS service, and the not-yet-
 * shipped WMTS). Auto-detect probe figures out the protocol from
 * the URL response so the user doesn't have to know upfront whether
 * they're pointing at a MapServer, a WMS, or a WMTS endpoint.
 *
 * Two-stage layout: paste URL, click Probe; on success the
 * detected protocol + service title surface in a summary line
 * and the layer picker shows up with all layers checked by
 * default. The user can uncheck individual layers to curate.
 */
function ServiceConfigSection({
  urlDraft,
  onUrlChange,
  probing,
  probeError,
  probeResult,
  selectedLayerNames,
  onSelectedLayerNamesChange,
  onProbe,
  onDiscardProbe,
}: {
  urlDraft: string;
  onUrlChange: (v: string) => void;
  probing: boolean;
  probeError: string | null;
  probeResult: ServiceProbeResult | null;
  selectedLayerNames: Set<string>;
  onSelectedLayerNamesChange: (next: Set<string>) => void;
  onProbe: () => void;
  onDiscardProbe: () => void;
}) {
  const data = probeResult?.data;
  return (
    <section className="rounded-lg border border-border bg-surface-1 p-4">
      <h2 className="mb-1 text-sm font-medium text-ink-0">
        Connected service
      </h2>
      <p className="mb-3 text-xs text-muted">
        Paste the service URL. We&rsquo;ll detect whether it&rsquo;s ArcGIS
        REST, WMS, WFS, or WMTS and load the layer list from the server.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="url"
          inputMode="url"
          value={urlDraft}
          disabled={probing || !!probeResult}
          onChange={(e) => onUrlChange(e.target.value)}
          placeholder="https://example.org/arcgis/rest/services/.../MapServer"
          className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface-1 px-2 text-sm font-mono"
        />
        {probeResult ? (
          <button
            type="button"
            onClick={onDiscardProbe}
            className="h-9 rounded-md border border-border bg-surface-1 px-3 text-xs text-ink-1 hover:bg-surface-2"
          >
            Try a different URL
          </button>
        ) : (
          <button
            type="button"
            onClick={onProbe}
            disabled={probing}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground shadow-card hover:opacity-90 disabled:opacity-50"
          >
            {probing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plug className="h-3.5 w-3.5" />}
            {probing ? 'Probing...' : 'Probe'}
          </button>
        )}
      </div>
      {probeError ? (
        <p className="mt-2 text-xs text-danger" role="alert">
          {probeError}
        </p>
      ) : null}
      {probeResult && data ? (
        <div className="mt-4 rounded-md border border-border bg-surface-2 p-3">
          <div className="mb-2 flex items-center justify-between gap-2 text-xs">
            <div className="text-muted">
              <span className="mr-1 rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">
                {serviceProtocolLabel(data.protocol)}
              </span>
              {data.serviceTitle ? (
                <>
                  <span className="font-medium text-ink-0">{data.serviceTitle}</span>
                  {' · '}
                </>
              ) : null}
              {data.layers.length} layer{data.layers.length === 1 ? '' : 's'}
            </div>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() =>
                  onSelectedLayerNamesChange(
                    new Set(data.layers.map((l) => l.name)),
                  )
                }
                className="h-6 rounded border border-border bg-surface-1 px-2 text-[11px] text-ink-1 hover:bg-surface-2"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={() => onSelectedLayerNamesChange(new Set())}
                className="h-6 rounded border border-border bg-surface-1 px-2 text-[11px] text-ink-1 hover:bg-surface-2"
              >
                Clear
              </button>
            </div>
          </div>
          {data.layers.length === 0 ? (
            <p className="text-xs text-muted">
              The server didn&rsquo;t advertise any named layers.
              Double-check the URL points at the GetCapabilities
              endpoint (or the ArcGIS REST service root).
            </p>
          ) : (
            <ul className="max-h-72 overflow-y-auto rounded border border-border bg-surface-1 text-xs">
              {data.layers.map((l) => {
                const checked = selectedLayerNames.has(l.name);
                return (
                  <li
                    key={l.name}
                    className="flex items-center gap-2 border-b border-border px-2 py-1.5 last:border-0"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        const next = new Set(selectedLayerNames);
                        if (checked) next.delete(l.name);
                        else next.add(l.name);
                        onSelectedLayerNamesChange(next);
                      }}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium text-ink-0">{l.title}</span>
                      {l.title !== l.name ? (
                        <span className="ml-2 font-mono text-muted">{l.name}</span>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Wizard pane for type='wms_service' / 'wfs_service' (#297).
 *
 * Mirrors the ArcGIS probe section but simpler: no auth flow yet
 * (most public WMS / WFS endpoints are anonymous), and the layer ids
 * are strings (Name / typeName), not the integer ids ArcGIS uses.
 *
 * Two-stage layout: paste a URL, click Probe; on success the layer
 * picker appears with all layers checked by default. The user can
 * uncheck individual layers to curate which appear in the item.
 */
function OgcConfigSection({
  kind,
  urlDraft,
  onUrlChange,
  probing,
  probeError,
  probeResult,
  selectedLayerNames,
  onSelectedLayerNamesChange,
  onProbe,
  onDiscardProbe,
}: {
  kind: 'wms' | 'wfs';
  urlDraft: string;
  onUrlChange: (v: string) => void;
  probing: boolean;
  probeError: string | null;
  probeResult: OgcCapabilities | null;
  selectedLayerNames: Set<string>;
  onSelectedLayerNamesChange: (next: Set<string>) => void;
  onProbe: () => void;
  onDiscardProbe: () => void;
}) {
  const protocolLabel = kind === 'wms' ? 'WMS' : 'WFS';
  const layerWord = kind === 'wms' ? 'layer' : 'feature type';
  return (
    <section className="rounded-lg border border-border bg-surface-1 p-4">
      <h2 className="mb-1 text-sm font-medium text-ink-0">
        {protocolLabel} service
      </h2>
      <p className="mb-3 text-xs text-muted">
        Paste the GetCapabilities base URL (no query string). Probe to
        load the {layerWord} list from the server.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="url"
          inputMode="url"
          value={urlDraft}
          disabled={probing || !!probeResult}
          onChange={(e) => onUrlChange(e.target.value)}
          placeholder={
            kind === 'wms'
              ? 'https://example.org/geoserver/wms'
              : 'https://example.org/geoserver/wfs'
          }
          className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface-1 px-2 text-sm font-mono"
        />
        {probeResult ? (
          <button
            type="button"
            onClick={onDiscardProbe}
            className="h-9 rounded-md border border-border bg-surface-1 px-3 text-xs text-ink-1 hover:bg-surface-2"
          >
            Try a different URL
          </button>
        ) : (
          <button
            type="button"
            onClick={onProbe}
            disabled={probing}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground shadow-card hover:opacity-90 disabled:opacity-50"
          >
            {probing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plug className="h-3.5 w-3.5" />}
            {probing ? 'Probing...' : 'Probe'}
          </button>
        )}
      </div>
      {probeError ? (
        <p className="mt-2 text-xs text-danger" role="alert">
          {probeError}
        </p>
      ) : null}
      {probeResult ? (
        <div className="mt-4 rounded-md border border-border bg-surface-2 p-3">
          <div className="mb-2 flex items-center justify-between gap-2 text-xs">
            <div className="text-muted">
              {probeResult.title ? (
                <>
                  <span className="font-medium text-ink-0">{probeResult.title}</span>
                  {' · '}
                </>
              ) : null}
              {protocolLabel} {probeResult.protocolVersion} · {probeResult.layers.length}{' '}
              {layerWord}
              {probeResult.layers.length === 1 ? '' : 's'}
            </div>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() =>
                  onSelectedLayerNamesChange(
                    new Set(probeResult.layers.map((l) => l.name)),
                  )
                }
                className="h-6 rounded border border-border bg-surface-1 px-2 text-[11px] text-ink-1 hover:bg-surface-2"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={() => onSelectedLayerNamesChange(new Set())}
                className="h-6 rounded border border-border bg-surface-1 px-2 text-[11px] text-ink-1 hover:bg-surface-2"
              >
                Clear
              </button>
            </div>
          </div>
          {probeResult.layers.length === 0 ? (
            <p className="text-xs text-muted">
              The server didn&rsquo;t advertise any named {layerWord}s. Double-check
              the URL points at the GetCapabilities endpoint.
            </p>
          ) : (
            <ul className="max-h-72 overflow-y-auto rounded border border-border bg-surface-1 text-xs">
              {probeResult.layers.map((l) => {
                const checked = selectedLayerNames.has(l.name);
                return (
                  <li
                    key={l.name}
                    className="flex items-center gap-2 border-b border-border px-2 py-1.5 last:border-0"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        const next = new Set(selectedLayerNames);
                        if (checked) next.delete(l.name);
                        else next.add(l.name);
                        onSelectedLayerNamesChange(next);
                      }}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium text-ink-0">{l.title}</span>
                      {l.title !== l.name ? (
                        <span className="ml-2 text-muted">
                          <span className="font-mono">{l.name}</span>
                        </span>
                      ) : (
                        <span className="ml-2 font-mono text-muted">{l.name}</span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Basemap authoring pane (#298). Source-aware: the user picks one
 * of three concrete kinds (tile XYZ, MapLibre style URL, WMS) and
 * fills in the URL / config the renderer needs. Phase 1 keeps the
 * fields direct -- no "pick from existing item" yet -- so the
 * authoring flow ships before we build cross-item references for
 * basemaps.
 */
function BasemapConfigSection({
  value,
  onChange,
}: {
  value: BasemapData;
  onChange: (next: BasemapData) => void;
}) {
  // #304 slice 6 / #302: a fourth "source" affordance that picks
  // an existing Connected Service item (or a legacy wms_service /
  // arcgis_service) and resolves it to the right basemap kind +
  // URL automatically. The selected mode here is UI-only -- the
  // saved BasemapData still uses one of the three concrete kinds
  // (tile-url, wms, style-url) so the renderer doesn't need to
  // grow a new branch.
  type SourceMode = 'tile-url' | 'wms' | 'style-url' | 'from-service';
  // Phase 1 doesn't author `composed-map` basemaps from the
  // wizard, so we never start in that mode; if a stale value
  // somehow comes in with kind=composed-map we fall back to
  // tile-url so the user can pick a fresh path.
  const [sourceMode, setSourceMode] = useState<SourceMode>(
    value.kind === 'composed-map' ? 'tile-url' : (value.kind as SourceMode),
  );
  const [serviceItems, setServiceItems] = useState<Item[] | null>(null);
  const [serviceLoading, setServiceLoading] = useState(false);
  const [serviceError, setServiceError] = useState<string | null>(null);

  // Lazy-load the picker list the first time the user clicks
  // "From an existing service item". Filters to the types that can
  // realistically back a basemap: WMS (kind=wms), ArcGIS Map (cached
  // tile or dynamic export), and the unified `service` items that
  // route through one of those protocols. WFS / non-cached services
  // aren't basemap-shaped, so they're filtered out at pick time
  // rather than removed from the list.
  useEffect(() => {
    if (sourceMode !== 'from-service' || serviceItems !== null) return;
    let cancelled = false;
    setServiceLoading(true);
    setServiceError(null);
    void (async () => {
      try {
        const res = await fetch(
          '/api/portal/items?type=service,arcgis_service,wms_service&lite=1',
        );
        if (!res.ok) {
          if (!cancelled) {
            setServiceError(`Could not load services (HTTP ${res.status}).`);
          }
          return;
        }
        const items = (await res.json()) as Item[];
        if (!cancelled) setServiceItems(items);
      } catch (err) {
        if (!cancelled) {
          setServiceError(
            err instanceof Error ? err.message : 'Could not load services.',
          );
        }
      } finally {
        if (!cancelled) setServiceLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceMode, serviceItems]);

  const setKind = (mode: SourceMode) => {
    setSourceMode(mode);
    if (mode === 'from-service') {
      // Don't touch `value` yet -- the actual BasemapData comes from
      // the picked item's data when the user chooses one below.
      return;
    }
    // Reset fields that don't apply to the new kind so we don't
    // leave stale URLs floating in data_json. attribution +
    // thumbnailUrl are kind-agnostic so they survive.
    const base: BasemapData = {
      version: 1,
      kind: mode,
    };
    if (value.attribution) base.attribution = value.attribution;
    if (value.thumbnailUrl) base.thumbnailUrl = value.thumbnailUrl;
    if (mode === 'wms') base.wmsConfig = { layers: '' };
    onChange(base);
  };

  // Hydrate the picked service item and resolve to a BasemapData
  // payload. Only protocols that map cleanly to a renderable
  // basemap source are accepted; others surface a clear error so
  // the user knows why their pick didn't take.
  async function pickServiceItem(itemId: string) {
    setServiceError(null);
    try {
      const res = await fetch(`/api/portal/items/${itemId}`);
      if (!res.ok) {
        setServiceError(`Could not load service (HTTP ${res.status}).`);
        return;
      }
      const item = (await res.json()) as Item;
      const next = serviceItemToBasemapData(item, value);
      if (!next) {
        setServiceError(
          'That service can\'t back a basemap yet (only WMS and cached ArcGIS Map services work today).',
        );
        return;
      }
      onChange(next);
    } catch (err) {
      setServiceError(
        err instanceof Error ? err.message : 'Could not load service.',
      );
    }
  }

  return (
    <section className="rounded-lg border border-border bg-surface-1 p-4">
      <h2 className="mb-1 text-sm font-medium text-ink-0">Basemap source</h2>
      <p className="mb-3 text-xs text-muted">
        Pick how this basemap is served. Maps that reference this
        basemap pull from the source you configure here. You can paste
        a URL directly or pick an existing Connected Service item.
      </p>
      <div className="mb-3 flex flex-wrap gap-2 text-xs">
        {([
          { k: 'from-service', label: 'From a service item' },
          { k: 'tile-url', label: 'XYZ tiles' },
          { k: 'wms', label: 'WMS' },
          { k: 'style-url', label: 'Style URL' },
        ] as const).map((opt) => {
          const active = sourceMode === opt.k;
          return (
            <button
              key={opt.k}
              type="button"
              onClick={() => setKind(opt.k)}
              className={
                'h-8 rounded-md border px-3 ' +
                (active
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border bg-surface-1 text-ink-1 hover:bg-surface-2')
              }
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      {sourceMode === 'from-service' ? (
        <div className="space-y-2">
          {serviceLoading ? (
            <div className="rounded-md border border-border bg-surface-2 p-3 text-xs text-muted">
              Loading services...
            </div>
          ) : serviceItems && serviceItems.length === 0 ? (
            <div className="rounded-md border border-border bg-surface-2 p-3 text-xs text-muted">
              No service items yet. Create a Connected service first, then come back here.
            </div>
          ) : serviceItems ? (
            <ul className="max-h-60 overflow-y-auto rounded-md border border-border bg-surface-2 text-xs">
              {serviceItems.map((it) => {
                const protocol = (it.data as { protocol?: string } | null)
                  ?.protocol;
                const protocolLabel =
                  it.type === 'wms_service'
                    ? 'WMS'
                    : it.type === 'arcgis_service'
                      ? 'ArcGIS'
                      : protocol === 'wms'
                        ? 'WMS'
                        : protocol === 'arcgis_map'
                          ? 'ArcGIS Map'
                          : protocol === 'arcgis_feature'
                            ? 'ArcGIS Feature'
                            : protocol ?? 'Service';
                return (
                  <li
                    key={it.id}
                    className="flex items-center gap-2 border-b border-border px-2 py-1.5 last:border-0"
                  >
                    <button
                      type="button"
                      onClick={() => pickServiceItem(it.id)}
                      className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-surface-1"
                    >
                      <span className="rounded border border-accent/40 bg-accent/10 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">
                        {protocolLabel}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-medium text-ink-0">
                        {it.title}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {serviceError ? (
            <p className="text-xs text-danger" role="alert">
              {serviceError}
            </p>
          ) : null}
          {/* Once a service is picked we render the resolved
              BasemapData below using the same per-kind input boxes
              the direct-URL flow uses, so the user can tweak it
              before hitting Create. */}
          {value.kind === 'wms' && value.wmsUrl ? (
            <div className="rounded-md border border-accent/40 bg-accent/5 p-3 text-xs">
              <p className="text-ink-0">
                Resolved as WMS. URL + layer pre-filled below.
              </p>
            </div>
          ) : null}
          {value.kind === 'tile-url' && value.tileUrl ? (
            <div className="rounded-md border border-accent/40 bg-accent/5 p-3 text-xs">
              <p className="text-ink-0">
                Resolved as XYZ tile template. URL pre-filled below.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
      {value.kind === 'tile-url' ? (
        <label className="block text-xs">
          <span className="text-muted">XYZ tile template</span>
          <input
            type="url"
            inputMode="url"
            value={value.tileUrl ?? ''}
            onChange={(e) => onChange({ ...value, tileUrl: e.target.value })}
            placeholder="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
            className="mt-0.5 h-9 w-full rounded-md border border-border bg-surface-1 px-2 font-mono text-sm"
          />
          <span className="mt-1 block text-[11px] text-muted">
            Use <span className="font-mono">{'{z}/{x}/{y}'}</span> placeholders.
            Works with any standard XYZ raster tile server (OpenStreetMap,
            ArcGIS cached MapServer&rsquo;s <span className="font-mono">/tile/</span>{' '}
            endpoint, custom rasters, etc.).
          </span>
        </label>
      ) : null}
      {value.kind === 'style-url' ? (
        <label className="block text-xs">
          <span className="text-muted">Style JSON URL</span>
          <input
            type="url"
            inputMode="url"
            value={value.styleUrl ?? ''}
            onChange={(e) => onChange({ ...value, styleUrl: e.target.value })}
            placeholder="https://demotiles.maplibre.org/style.json"
            className="mt-0.5 h-9 w-full rounded-md border border-border bg-surface-1 px-2 font-mono text-sm"
          />
          <span className="mt-1 block text-[11px] text-muted">
            A hosted MapLibre style.json. Works with MapTiler, Stadia,
            self-hosted tilesets, etc.
          </span>
        </label>
      ) : null}
      {value.kind === 'wms' ? (
        <div className="space-y-2">
          <label className="block text-xs">
            <span className="text-muted">WMS GetMap URL</span>
            <input
              type="url"
              inputMode="url"
              value={value.wmsUrl ?? ''}
              onChange={(e) => onChange({ ...value, wmsUrl: e.target.value })}
              placeholder="https://example.org/geoserver/wms"
              className="mt-0.5 h-9 w-full rounded-md border border-border bg-surface-1 px-2 font-mono text-sm"
            />
          </label>
          <label className="block text-xs">
            <span className="text-muted">Layer name(s)</span>
            <input
              type="text"
              value={value.wmsConfig?.layers ?? ''}
              onChange={(e) =>
                onChange({
                  ...value,
                  wmsConfig: {
                    ...(value.wmsConfig ?? { layers: '' }),
                    layers: e.target.value,
                  },
                })
              }
              placeholder="topp:states"
              className="mt-0.5 h-9 w-full rounded-md border border-border bg-surface-1 px-2 font-mono text-sm"
            />
            <span className="mt-1 block text-[11px] text-muted">
              Comma-separated WMS layer names. Match what the server
              advertises in GetCapabilities.
            </span>
          </label>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <label className="block">
              <span className="text-muted">Format</span>
              <select
                value={value.wmsConfig?.format ?? 'image/png'}
                onChange={(e) =>
                  onChange({
                    ...value,
                    wmsConfig: {
                      ...(value.wmsConfig ?? { layers: '' }),
                      format: e.target.value,
                    },
                  })
                }
                className="mt-0.5 h-9 w-full rounded-md border border-border bg-surface-1 px-2"
              >
                <option value="image/png">image/png</option>
                <option value="image/jpeg">image/jpeg</option>
              </select>
            </label>
            <label className="block">
              <span className="text-muted">Version</span>
              <select
                value={value.wmsConfig?.version ?? '1.3.0'}
                onChange={(e) =>
                  onChange({
                    ...value,
                    wmsConfig: {
                      ...(value.wmsConfig ?? { layers: '' }),
                      version: e.target.value,
                    },
                  })
                }
                className="mt-0.5 h-9 w-full rounded-md border border-border bg-surface-1 px-2"
              >
                <option value="1.3.0">1.3.0</option>
                <option value="1.1.1">1.1.1</option>
              </select>
            </label>
          </div>
        </div>
      ) : null}
      <label className="mt-3 block text-xs">
        <span className="text-muted">Attribution (optional)</span>
        <input
          type="text"
          value={value.attribution ?? ''}
          onChange={(e) => onChange({ ...value, attribution: e.target.value })}
          placeholder='&copy; OpenStreetMap contributors'
          className="mt-0.5 h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm"
        />
      </label>
    </section>
  );
}

/**
 * Resolve a picked service item (Connected Service, legacy
 * arcgis_service, or legacy wms_service) into a BasemapData payload
 * the renderer can consume (#304 slice 6 / #302). Returns null if
 * the protocol can't reasonably back a basemap (WFS, WMTS pending
 * #305, ArcGIS Feature, etc.).
 *
 * Mapping rules:
 *   - WMS (unified or legacy): kind=wms with wmsUrl + comma-joined
 *     selected layer names.
 *   - ArcGIS Map Service (cached MapServer): kind=tile-url with the
 *     `${url}/tile/{z}/{y}/{x}` template ArcGIS publishes for cached
 *     services. Dynamic-only services would need GetMap-style
 *     export URLs we don't compose today.
 *
 * The previously-typed attribution / thumbnail on `prev` survive
 * because they're kind-agnostic.
 */
function serviceItemToBasemapData(
  item: Item,
  prev: BasemapData,
): BasemapData | null {
  const data = (item.data ?? {}) as Record<string, unknown>;
  const url = typeof data.url === 'string' ? data.url : '';
  if (!url) return null;
  // Identify protocol either from the unified `service` data
  // (`protocol` field) or from the legacy item.type wrapper.
  const protocol =
    item.type === 'service'
      ? typeof data.protocol === 'string'
        ? data.protocol
        : ''
      : item.type === 'wms_service'
        ? 'wms'
        : item.type === 'arcgis_service'
          ? // serviceType on legacy ArcGIS items is 'MapServer' or
            // 'FeatureServer'; only MapServer maps cleanly to a
            // basemap. The Feature path returns null below.
            (data as { serviceType?: string }).serviceType === 'FeatureServer'
            ? 'arcgis_feature'
            : 'arcgis_map'
          : '';
  if (protocol === 'wms') {
    const layersArr = Array.isArray(data.layers)
      ? (data.layers as Array<{ name?: string }>)
      : [];
    const selectedIds = Array.isArray(data.selectedLayerIds)
      ? (data.selectedLayerIds as Array<number | string>).map((i) => Number(i))
      : layersArr.map((_, i) => i);
    const names = selectedIds
      .map((i) => layersArr[i]?.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
    const next: BasemapData = {
      version: 1,
      kind: 'wms',
      wmsUrl: url,
      wmsConfig: {
        layers: names.join(','),
        format: 'image/png',
        transparent: true,
        version: '1.3.0',
        crs: 'EPSG:3857',
      },
    };
    if (prev.attribution) next.attribution = prev.attribution;
    if (prev.thumbnailUrl) next.thumbnailUrl = prev.thumbnailUrl;
    return next;
  }
  if (protocol === 'arcgis_map') {
    // Cached ArcGIS MapServers publish at /tile/{level}/{row}/{col}.
    // We rewrite to MapLibre's {z}/{y}/{x} placeholders since
    // Esri's URL ordering is z/y/x (rows-then-cols), not z/x/y.
    const cleaned = url.replace(/\/+$/, '');
    const tileUrl = `${cleaned}/tile/{z}/{y}/{x}`;
    const next: BasemapData = {
      version: 1,
      kind: 'tile-url',
      tileUrl,
    };
    if (prev.attribution) next.attribution = prev.attribution;
    if (prev.thumbnailUrl) next.thumbnailUrl = prev.thumbnailUrl;
    return next;
  }
  // arcgis_feature, wfs, wmts, image: no basemap mapping today.
  return null;
}

/** Human-friendly size string for the file metadata row. */
function humanFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

interface ArcgisConfigProps {
  urlDraft: string;
  onUrlChange: (v: string) => void;
  probing: boolean;
  probeResult: ArcgisServiceDescription | null;
  defaultLayerId: number | null;
  onDefaultLayerChange: (id: number) => void;
  /** Set of layer ids the user wants to include in this item. */
  selectedLayerIds: Set<number>;
  onSelectedLayerIdsChange: (next: Set<number>) => void;
  onProbe: () => void | Promise<void>;
  onDiscardProbe: () => void;
  /** True when the anonymous probe came back as auth-required and
   *  the user should fill in a credential to proceed. (#74) */
  needsAuth: boolean;
  credentialKind: 'arcgis_token' | 'bearer' | 'basic';
  onCredentialKindChange: (kind: 'arcgis_token' | 'bearer' | 'basic') => void;
  credentialToken: string;
  onCredentialTokenChange: (v: string) => void;
  credentialUsername: string;
  onCredentialUsernameChange: (v: string) => void;
  credentialPassword: string;
  onCredentialPasswordChange: (v: string) => void;
  /** Re-runs probe through the server-side endpoint with the
   *  credential injected. Same response shape as onProbe. (#74) */
  onProbeWithCredential: () => void | Promise<void>;
  /** True after a credentialed probe succeeded; the form shows a
   *  reassurance pill so the user knows the secret is staged for
   *  save-on-create. (#74) */
  credentialUsed: boolean;
}

/**
 * Inline ArcGIS probe UI that replaces the separate post-create config
 * step. The user pastes a URL, probes it, confirms the default sublayer,
 * and the rest of the form works like any other create flow.
 */
function ArcgisConfigSection({
  urlDraft,
  onUrlChange,
  probing,
  probeResult,
  defaultLayerId,
  onDefaultLayerChange,
  selectedLayerIds,
  onSelectedLayerIdsChange,
  onProbe,
  onDiscardProbe,
  needsAuth,
  credentialKind,
  onCredentialKindChange,
  credentialToken,
  onCredentialTokenChange,
  credentialUsername,
  onCredentialUsernameChange,
  credentialPassword,
  onCredentialPasswordChange,
  onProbeWithCredential,
  credentialUsed,
}: ArcgisConfigProps) {
  const toggleLayer = (id: number) => {
    const next = new Set(selectedLayerIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedLayerIdsChange(next);
  };
  const selectAll = () => {
    if (!probeResult) return;
    onSelectedLayerIdsChange(new Set(probeResult.layers.map((l) => l.id)));
  };
  const selectNone = () => onSelectedLayerIdsChange(new Set());
  const selectSpatialOnly = () => {
    if (!probeResult) return;
    onSelectedLayerIdsChange(
      new Set(
        probeResult.layers
          .filter((l) => l.geometryType)
          .map((l) => l.id),
      ),
    );
  };
  return (
    <section className="space-y-3 rounded-lg border border-border bg-surface-1 p-4">
      <div className="flex items-start gap-2">
        <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <div>
          <h2 className="text-sm font-semibold text-ink-0">
            Service endpoint
          </h2>
          <p className="text-xs text-muted">
            Paste the service root ({' '}
            <code className="rounded bg-surface-2 px-1">/MapServer</code> or{' '}
            <code className="rounded bg-surface-2 px-1">/FeatureServer</code>) or
            a specific layer URL. We&apos;ll read the layer list and bake it
            into the item so the map picker has it ready.
          </p>
        </div>
      </div>

      <div className="flex gap-2">
        <input
          type="url"
          value={urlDraft}
          onChange={(e) => onUrlChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void onProbe();
            }
          }}
          placeholder="https://host/arcgis/rest/services/OpenData/Assessor/MapServer"
          className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
        />
        <button
          type="button"
          onClick={() => void onProbe()}
          disabled={probing || !urlDraft.trim()}
          className="inline-flex h-9 items-center gap-1 rounded-md border border-border bg-surface-1 px-3 text-xs font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
        >
          {probing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Search className="h-3.5 w-3.5" />
          )}
          Probe
        </button>
      </div>

      {/* Credential form (#74). Appears when the anonymous probe came
          back as auth-required, OR after a credentialed probe has
          succeeded (so the user can change their mind and re-enter).
          Plaintext lives in component state for the duration of the
          wizard; it gets POSTed to the new item's credential endpoint
          right after Create succeeds. */}
      {needsAuth || credentialUsed ? (
        <div className="rounded-md border border-amber-300/50 bg-amber-50/50 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-amber-900">
            <Lock className="h-3.5 w-3.5" />
            Authentication required
            {credentialUsed ? (
              <span className="ml-1 rounded-full border border-success/40 bg-success/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-success">
                staged
              </span>
            ) : null}
          </div>
          <p className="mb-2 text-[11px] text-amber-900/80">
            The credential is stored encrypted on this item once it&apos;s
            created. Calls from the map go through a server-side proxy
            so the secret never reaches the browser.
          </p>

          <div className="mb-2 grid grid-cols-3 gap-1">
            {(
              ['basic', 'arcgis_token', 'bearer'] as const
            ).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => onCredentialKindChange(k)}
                className={`rounded border px-2 py-1.5 text-left text-xs ${
                  credentialKind === k
                    ? 'border-accent bg-accent/5 text-ink-0 ring-2 ring-accent/30'
                    : 'border-border bg-surface-1 text-muted hover:bg-surface-2'
                }`}
              >
                <div className="font-medium capitalize">
                  {k === 'arcgis_token'
                    ? 'ArcGIS token'
                    : k === 'bearer'
                      ? 'Bearer'
                      : 'Basic'}
                </div>
                <div className="text-[10px] text-muted">
                  {k === 'arcgis_token'
                    ? '?token=... query param'
                    : k === 'bearer'
                      ? 'Authorization: Bearer'
                      : 'Username + password'}
                </div>
              </button>
            ))}
          </div>

          {credentialKind === 'basic' ? (
            <div className="mb-2 grid grid-cols-2 gap-2">
              <input
                type="text"
                autoComplete="off"
                value={credentialUsername}
                onChange={(e) => onCredentialUsernameChange(e.target.value)}
                placeholder="Username"
                className="h-8 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
              />
              <input
                type="password"
                autoComplete="new-password"
                value={credentialPassword}
                onChange={(e) => onCredentialPasswordChange(e.target.value)}
                placeholder="Password"
                className="h-8 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
              />
            </div>
          ) : (
            <input
              type="password"
              autoComplete="new-password"
              value={credentialToken}
              onChange={(e) => onCredentialTokenChange(e.target.value)}
              placeholder={
                credentialKind === 'arcgis_token'
                  ? 'Paste an ArcGIS token (e.g. from generateToken)'
                  : 'Paste a bearer token'
              }
              className="mb-2 h-8 w-full rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
            />
          )}

          <button
            type="button"
            onClick={() => void onProbeWithCredential()}
            disabled={probing}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-amber-400 bg-amber-100 px-3 text-xs font-medium text-amber-900 hover:bg-amber-200 disabled:opacity-50"
          >
            {probing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Search className="h-3.5 w-3.5" />
            )}
            Probe with credential
          </button>
        </div>
      ) : null}

      {probeResult ? (
        <div className="rounded-md border border-success/30 bg-success/5 p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-success">
                <Check className="h-3.5 w-3.5" />
                Service read
              </p>
              <p className="mt-1 truncate text-sm font-medium text-ink-0">
                {probeResult.name || '(unnamed service)'}
              </p>
              <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted">
                <span>{probeResult.serviceType}</span>
                <span aria-hidden="true">·</span>
                <span>
                  {probeResult.layers.length}{' '}
                  {probeResult.layers.length === 1 ? 'layer' : 'layers'}
                </span>
                <span aria-hidden="true">·</span>
                <a
                  href={`${probeResult.url}?f=html`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 underline hover:text-ink-1"
                >
                  Open service <ExternalLink className="h-3 w-3" />
                </a>
              </p>
            </div>
            <button
              type="button"
              onClick={onDiscardProbe}
              className="shrink-0 rounded border border-border bg-surface-1 px-2 py-1 text-[11px] text-muted hover:bg-surface-2"
            >
              Clear
            </button>
          </div>

          {probeResult.layers.length > 0 ? (
            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between gap-2">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
                  Layers to include
                  <span className="ml-1.5 text-muted normal-case tracking-normal">
                    ({selectedLayerIds.size} of{' '}
                    {probeResult.layers.length} selected)
                  </span>
                </p>
                <div className="flex items-center gap-1 text-[11px]">
                  <button
                    type="button"
                    onClick={selectAll}
                    className="rounded border border-border bg-surface-1 px-1.5 py-0.5 text-muted hover:bg-surface-2 hover:text-ink-1"
                  >
                    All
                  </button>
                  <button
                    type="button"
                    onClick={selectNone}
                    className="rounded border border-border bg-surface-1 px-1.5 py-0.5 text-muted hover:bg-surface-2 hover:text-ink-1"
                  >
                    None
                  </button>
                  <button
                    type="button"
                    onClick={selectSpatialOnly}
                    title="Only layers with geometry (skip attribute-only related tables)"
                    className="rounded border border-border bg-surface-1 px-1.5 py-0.5 text-muted hover:bg-surface-2 hover:text-ink-1"
                  >
                    Spatial only
                  </button>
                </div>
              </div>
              <ul className="max-h-56 space-y-0.5 overflow-y-auto rounded border border-border bg-surface-0 p-1">
                {probeResult.layers.map((l) => {
                  const included = selectedLayerIds.has(l.id);
                  const isDefault = l.id === defaultLayerId;
                  return (
                    <li
                      key={l.id}
                      className={`flex items-center gap-2 rounded px-2 py-1.5 text-xs transition-colors ${
                        included
                          ? 'bg-surface-1 text-ink-1'
                          : 'text-muted opacity-60'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={included}
                        onChange={() => toggleLayer(l.id)}
                        className="h-3.5 w-3.5 shrink-0 rounded border-border text-accent focus:ring-accent/30"
                        aria-label={`Include layer ${l.name}`}
                      />
                      <span className="flex-1 truncate">
                        <span className="tabular-nums text-muted">
                          {l.id}
                        </span>{' '}
                        {l.name}
                      </span>
                      <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted">
                        {geometryShort(l.geometryType)}
                      </span>
                      {/* Default-layer star: radio-like, lit only for
                           the layer currently picked as default. Click
                           sets default and, if layer isn't already
                           selected, includes it. */}
                      <button
                        type="button"
                        onClick={() => {
                          if (!included) {
                            const next = new Set(selectedLayerIds);
                            next.add(l.id);
                            onSelectedLayerIdsChange(next);
                          }
                          onDefaultLayerChange(l.id);
                        }}
                        title={
                          isDefault
                            ? 'Default layer for maps consuming this item'
                            : 'Make this the default layer'
                        }
                        aria-pressed={isDefault}
                        className={`shrink-0 rounded px-1 text-[10px] font-semibold ${
                          isDefault
                            ? 'bg-accent/15 text-accent'
                            : 'text-muted hover:bg-surface-2 hover:text-ink-1'
                        }`}
                      >
                        {isDefault ? 'DEFAULT' : 'set default'}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-1 text-[11px] text-muted">
                Unchecked layers stay in the upstream service but this
                item will not expose them. The default layer is loaded
                when a map picks this item without a specific layer
                choice.
              </p>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-[11px] text-muted">
          Probe first - the Create button stays disabled-looking until the
          service is read.
        </p>
      )}
    </section>
  );
}

function geometryShort(g?: string): string {
  if (!g) return 'table';
  const m = g.match(/esriGeometry(\w+)/);
  return (m?.[1] ?? g).toLowerCase();
}
