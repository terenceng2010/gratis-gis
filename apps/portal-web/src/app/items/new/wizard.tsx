'use client';

import { useCallback, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Building2,
  Check,
  ExternalLink,
  FileText,
  FlaskConical,
  Globe2,
  LayoutDashboard,
  Layers,
  Loader2,
  Lock,
  Map as MapIcon,
  Notebook,
  Plug,
  Search,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import type {
  ArcgisServiceData,
  FeatureServiceDataV3,
  ISODateString,
  Item,
  ItemAccess,
  ItemType,
} from '@gratis-gis/shared-types';
import {
  DEFAULT_ARCGIS_SERVICE,
  DEFAULT_FEATURE_SERVICE_V3,
  DEFAULT_WEB_MAP,
} from '@gratis-gis/shared-types';
import { ImageUploader } from '@/components/image-uploader';
import {
  probeService,
  type ArcgisServiceDescription,
} from '@/lib/arcgis-rest';
import { FeatureServiceBuilder } from './feature-service-builder';

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
  value: ItemType;
  label: string;
  desc: string;
  Icon: LucideIcon;
}

// Ordered most-common first. The grid layout handles responsive columns.
const TYPE_OPTIONS: TypeOption[] = [
  {
    value: 'web_map',
    label: 'Web map',
    desc: 'A basemap with overlay layers and styling.',
    Icon: MapIcon,
  },
  {
    value: 'feature_service',
    label: 'Feature service',
    desc: 'A shareable vector layer backed by PostGIS.',
    Icon: Layers,
  },
  {
    value: 'arcgis_service',
    label: 'ArcGIS service',
    desc: 'Live pointer at a MapServer or FeatureServer.',
    Icon: Plug,
  },
  {
    value: 'form',
    label: 'Form',
    desc: 'A collection form for fieldwork or survey data.',
    Icon: FileText,
  },
  {
    value: 'dashboard',
    label: 'Dashboard',
    desc: 'Live panels showing feature data.',
    Icon: LayoutDashboard,
  },
  {
    value: 'web_app',
    label: 'Web app',
    desc: 'A configurable app built from widgets.',
    Icon: Sparkles,
  },
  {
    value: 'report_template',
    label: 'Report template',
    desc: 'A document template that renders data.',
    Icon: FileText,
  },
  {
    value: 'notebook',
    label: 'Notebook',
    desc: 'A Jupyter notebook hosted in the portal.',
    Icon: Notebook,
  },
  {
    value: 'file',
    label: 'File',
    desc: 'Any uploaded file (PDF, image, zip, etc.).',
    Icon: FileText,
  },
];

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
  const [step, setStep] = useState<Step>('pick');
  const [type, setType] = useState<ItemType | null>(null);

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
  const arcgisAbortRef = useRef<AbortController | null>(null);
  const userEditedTitleRef = useRef(false);
  const userEditedDescRef = useRef(false);

  // Feature-service builder state. Stays in v3 shape from the start so
  // the POST body can be sent as-is.
  const [featureServiceData, setFeatureServiceData] =
    useState<FeatureServiceDataV3>(DEFAULT_FEATURE_SERVICE_V3);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const pickType = useCallback((t: ItemType) => {
    setType(t);
    setStep('details');
    setError(null);
  }, []);

  const backToPicker = useCallback(() => {
    setStep('pick');
    setError(null);
  }, []);

  const runArcgisProbe = useCallback(async () => {
    const raw = arcgisUrlDraft.trim();
    if (!raw) {
      setError('Paste an ArcGIS MapServer or FeatureServer URL.');
      return;
    }
    setError(null);
    arcgisAbortRef.current?.abort();
    const controller = new AbortController();
    arcgisAbortRef.current = controller;
    setArcgisProbing(true);
    try {
      const desc = await probeService(raw, controller.signal);
      if (controller.signal.aborted) return;
      setArcgisProbeResult(desc);
      // Auto-fill title/description from the service only if the user
      // hasn't typed anything of their own — never clobber user input.
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
      // Pre-pick a sensible default sublayer: first one with geometry,
      // or the first layer if everything is attribute-only.
      const firstGeom = desc.layers.find((l) => l.geometryType);
      const pick = firstGeom?.id ?? desc.layers[0]?.id ?? null;
      setArcgisDefaultLayerId(pick);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      setError(
        (err as Error).message ||
          'Could not read that service. Check the URL and CORS config.',
      );
    } finally {
      if (!controller.signal.aborted) setArcgisProbing(false);
    }
  }, [arcgisUrlDraft, title, description]);

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
        ...(arcgisProbeResult.bbox ? { bbox: arcgisProbeResult.bbox } : {}),
        ...(arcgisDefaultLayerId !== null
          ? { defaultLayerId: arcgisDefaultLayerId }
          : {}),
        probedAt: new Date().toISOString() as ISODateString,
      };
      data = staged;
    } else if (type === 'web_map') {
      data = DEFAULT_WEB_MAP;
    } else if (type === 'feature_service') {
      // Gentle validation: require at least one layer, each labeled.
      // Anything beyond that is advisory — a user may legitimately
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
      // Field name uniqueness within a layer — PostGIS won't let two
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
    } else {
      data = {};
    }

    const payload = {
      type,
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
    const res = await fetch('/api/portal/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(`Create failed: ${res.status} ${await res.text()}`);
      return;
    }
    const saved = (await res.json()) as Item;
    // feature_service still wants the ingest panel front and centre.
    // arcgis_service no longer needs #configure-arcgis because we baked
    // the probed config into dataJson above.
    const anchor = type === 'feature_service' ? '#add-data' : '';
    startTransition(() => router.push(`/items/${saved.id}${anchor}`));
  }

  if (step === 'pick') {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {TYPE_OPTIONS.map((opt) => {
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
          onProbe={runArcgisProbe}
          onDiscardProbe={() => setArcgisProbeResult(null)}
        />
      ) : null}

      {type === 'feature_service' ? (
        <FeatureServiceBuilder
          value={featureServiceData}
          onChange={setFeatureServiceData}
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

interface ArcgisConfigProps {
  urlDraft: string;
  onUrlChange: (v: string) => void;
  probing: boolean;
  probeResult: ArcgisServiceDescription | null;
  defaultLayerId: number | null;
  onDefaultLayerChange: (id: number) => void;
  onProbe: () => void | Promise<void>;
  onDiscardProbe: () => void;
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
  onProbe,
  onDiscardProbe,
}: ArcgisConfigProps) {
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
                <span>•</span>
                <span>
                  {probeResult.layers.length}{' '}
                  {probeResult.layers.length === 1 ? 'layer' : 'layers'}
                </span>
                <span>•</span>
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
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
                Default sublayer
              </p>
              <ul className="max-h-48 space-y-0.5 overflow-y-auto rounded border border-border bg-surface-0 p-1">
                {probeResult.layers.map((l) => {
                  const active = l.id === defaultLayerId;
                  return (
                    <li key={l.id}>
                      <button
                        type="button"
                        onClick={() => onDefaultLayerChange(l.id)}
                        className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                          active
                            ? 'bg-accent/10 text-ink-0 ring-1 ring-accent/40'
                            : 'text-ink-1 hover:bg-surface-2'
                        }`}
                      >
                        <span className="truncate">
                          <span className="tabular-nums text-muted">
                            {l.id}
                          </span>{' '}
                          {l.name}
                        </span>
                        <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted">
                          {geometryShort(l.geometryType)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-1 text-[11px] text-muted">
                Maps that pick this item from Portal load this layer by
                default. Authors can override per-map.
              </p>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-[11px] text-muted">
          Probe first — the Create button stays disabled-looking until the
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
