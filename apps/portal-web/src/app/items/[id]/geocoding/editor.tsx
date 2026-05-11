// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Check,
  GripVertical,
  Loader2,
  Save,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import type {
  DataLayerDataV3,
  GeocodingServiceData,
  Item,
} from '@gratis-gis/shared-types';

/**
 * Detail-page editor for geocoding_service items (#74). Lets the
 * author point the geocoder at a source data_layer + sublayer, pick
 * which fields to search against (with per-field weights), and
 * configure the label template + spatial bbox constraint.
 *
 * The editor stages a draft locally; Save PATCHes
 * /api/portal/items/{id} with `{ data: draft }`. Validation server-
 * side checks that every search field exists in the source schema
 * and that the field names are safe-character (the SQL path embeds
 * them as bound params but the strict-name check catches typos
 * early).
 *
 * A small Test panel lets the author try a query against the
 * geocoder before saving so they can verify the config produces
 * sensible candidates.
 */
interface Props {
  itemId: string;
  initial: GeocodingServiceData;
  canEdit: boolean;
}

/** Compact shape for the source-layer picker. We pull the lite
 *  variant (no full schema) and load the schema on-demand once a
 *  layer is picked. */
interface DataLayerListEntry {
  id: string;
  title: string;
}

/** Schema field row pulled from the chosen data_layer's data. We
 *  only care about name + a coarse type for the picker UX (filter
 *  to string-like fields where similarity makes sense). */
interface SchemaFieldRow {
  name: string;
  type: string;
  label?: string;
}

export function GeocodingServiceEditor({ itemId, initial, canEdit }: Props) {
  const router = useRouter();
  const [draft, setDraft] = useState<GeocodingServiceData>(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // #74 perf followup: per-field GIN trigram indexes are rebuilt
  // synchronously after save. For 1M-row layers this can take a
  // few minutes; the UI surfaces an explicit "Building search
  // indexes..." status so the user knows the save itself
  // succeeded and the wait is on indexing.
  const [indexBuilding, setIndexBuilding] = useState(false);
  const [indexSummary, setIndexSummary] = useState<{
    created: string[];
    kept: string[];
    dropped: string[];
    rowCount: number;
    durationMs: number;
  } | null>(null);

  // Available source data_layer items. Loaded once when the editor
  // mounts so the source-picker dropdown is populated.
  const [sourceLayers, setSourceLayers] = useState<DataLayerListEntry[] | null>(
    null,
  );
  // Schema of the currently-selected source layer's chosen sublayer.
  // Used to populate the search-field picker and the result-fields
  // multiselect.
  const [schemaFields, setSchemaFields] = useState<SchemaFieldRow[] | null>(
    null,
  );
  const [sublayers, setSublayers] = useState<Array<{ id: string; label: string }> | null>(null);
  const [sourceLoadError, setSourceLoadError] = useState<string | null>(null);

  // Test-query state. Stored locally; firing the search hits the
  // runtime /geocode endpoint, which runs as the current user (so
  // authz behaves the same way it will for end users of this item).
  const [testText, setTestText] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState<
    Array<{ featureId: string; score: number; label: string }>
  | null
  >(null);
  const [testError, setTestError] = useState<string | null>(null);

  const initialJson = JSON.stringify(initial);
  const draftJson = JSON.stringify(draft);
  const hasChanges = initialJson !== draftJson;

  // Load the list of data_layer items the caller can pick from.
  // Source items the user can't read are filtered server-side
  // (?type=data_layer&lite=1 returns only readable rows).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/portal/items?type=data_layer&lite=1');
        if (!res.ok) {
          if (!cancelled) {
            setSourceLoadError(`Could not load layers (HTTP ${res.status}).`);
          }
          return;
        }
        const items = (await res.json()) as Item[];
        if (!cancelled) {
          setSourceLayers(items.map((it) => ({ id: it.id, title: it.title })));
        }
      } catch (err) {
        if (!cancelled) {
          setSourceLoadError(
            err instanceof Error ? err.message : 'Could not load layers.',
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Whenever the chosen source layer changes, pull its full
  // item.data so we can populate the sublayer + schema field
  // pickers. Cleared when no source is selected.
  useEffect(() => {
    if (!draft.sourceLayerId) {
      setSublayers(null);
      setSchemaFields(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/portal/items/${draft.sourceLayerId}`);
        if (!res.ok) {
          if (!cancelled) {
            setSourceLoadError(
              `Could not load source layer (HTTP ${res.status}).`,
            );
          }
          return;
        }
        const item = (await res.json()) as Item<DataLayerDataV3>;
        const data = item.data;
        if (data?.version !== 3 || !Array.isArray(data.layers)) {
          if (!cancelled) {
            setSourceLoadError(
              "That data layer's structure isn't supported yet. Only v3 (multi-layer) sources work as geocoder sources.",
            );
          }
          return;
        }
        if (cancelled) return;
        const subs = data.layers.map((l) => ({
          id: l.id,
          label: l.label || l.name || l.id,
        }));
        setSublayers(subs);
        // Auto-pick the first sublayer if none is set yet.
        const pickedId = draft.sourceSublayerId ?? subs[0]?.id;
        if (pickedId && pickedId !== draft.sourceSublayerId) {
          setDraft((d) => ({ ...d, sourceSublayerId: pickedId }));
        }
        const picked = data.layers.find((l) => l.id === pickedId);
        if (picked && Array.isArray(picked.fields)) {
          setSchemaFields(
            picked.fields.map((f) => ({
              name: f.name,
              type: f.type,
              label: f.label,
            })),
          );
        } else {
          setSchemaFields([]);
        }
        setSourceLoadError(null);
      } catch (err) {
        if (!cancelled) {
          setSourceLoadError(
            err instanceof Error ? err.message : 'Could not load source layer.',
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [draft.sourceLayerId, draft.sourceSublayerId]);

  function toggleSearchField(name: string) {
    setDraft((d) => {
      const exists = d.searchFields.find((f) => f.name === name);
      if (exists) {
        return { ...d, searchFields: d.searchFields.filter((f) => f.name !== name) };
      }
      return { ...d, searchFields: [...d.searchFields, { name, weight: 1 }] };
    });
  }

  function setFieldWeight(name: string, weight: number) {
    setDraft((d) => ({
      ...d,
      searchFields: d.searchFields.map((f) =>
        f.name === name ? { ...f, weight } : f,
      ),
    }));
  }

  async function save() {
    if (!canEdit || !hasChanges) return;
    if (!draft.sourceLayerId) {
      setError('Pick a source data layer.');
      return;
    }
    if (draft.searchFields.length === 0) {
      setError('Pick at least one field to search against.');
      return;
    }
    setError(null);
    setSaving(true);
    setSaved(false);
    setIndexBuilding(false);
    try {
      const res = await fetch(`/api/portal/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: draft }),
      });
      if (!res.ok) {
        let msg = `Save failed (HTTP ${res.status}).`;
        try {
          const body = (await res.text()) ?? '';
          const parsed = JSON.parse(body) as { message?: unknown };
          if (typeof parsed.message === 'string') msg = parsed.message;
        } catch {
          /* keep HTTP fallback */
        }
        setError(msg);
        return;
      }
      // Trigger the index rebuild (#74 perf followup). For
      // sub-100K-row source layers this finishes in seconds; for
      // 1M-row layers (WV parcels et al.) it can take 1-3 minutes
      // one-time setup. UI surfaces a distinct "Building search
      // indexes..." indicator so the user knows the save itself
      // already succeeded -- the wait is on index creation, not
      // on the geocoder config.
      setIndexBuilding(true);
      try {
        const idxRes = await fetch(
          `/api/portal/geocode/${itemId}/rebuild-indexes`,
          { method: 'POST' },
        );
        if (!idxRes.ok) {
          let msg = `Index build failed (HTTP ${idxRes.status}).`;
          try {
            const body = (await idxRes.text()) ?? '';
            const parsed = JSON.parse(body) as { message?: unknown };
            if (typeof parsed.message === 'string') msg = parsed.message;
          } catch {
            /* keep HTTP fallback */
          }
          // Surface as a warning rather than a save failure. The
          // geocoder config DID save; queries just won't be
          // index-accelerated. The next save (or a manual
          // rebuild call) can retry.
          setError(
            `${msg} Your changes were saved, but queries against this geocoder will be slow until the index build succeeds.`,
          );
        } else {
          const summary = (await idxRes.json()) as {
            created: string[];
            kept: string[];
            dropped: string[];
            rowCount: number;
            durationMs: number;
          };
          setIndexSummary(summary);
        }
      } catch (err) {
        setError(
          `Index build failed: ${err instanceof Error ? err.message : String(err)}. Your changes were saved, but queries against this geocoder will be slow until the index build succeeds.`,
        );
      } finally {
        setIndexBuilding(false);
      }
      setSaved(true);
      router.refresh();
      window.setTimeout(() => setSaved(false), 2400);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    setDraft(initial);
    setError(null);
    setSaved(false);
  }

  async function runTest() {
    if (!testText.trim()) {
      setTestError('Type something to test.');
      return;
    }
    if (hasChanges) {
      setTestError(
        'Save your changes first so the test runs against the current config.',
      );
      return;
    }
    setTestError(null);
    setTesting(true);
    try {
      const res = await fetch(
        `/api/portal/geocode/${itemId}?text=${encodeURIComponent(testText.trim())}&limit=5`,
      );
      if (!res.ok) {
        let msg = `Test failed (HTTP ${res.status}).`;
        try {
          const body = (await res.json()) as { message?: unknown };
          if (typeof body.message === 'string') msg = body.message;
        } catch {
          /* fall through */
        }
        setTestError(msg);
        return;
      }
      const body = (await res.json()) as {
        candidates: Array<{ featureId: string; score: number; label: string }>;
      };
      setTestResults(body.candidates);
    } catch (err) {
      setTestError(err instanceof Error ? err.message : 'Test failed.');
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="space-y-4">
      <section className="overflow-hidden rounded-lg border border-border bg-surface-1 shadow-card">
        <div className="border-b border-border bg-surface-2 px-4 py-3">
          <h3 className="text-sm font-medium text-ink-0">Source data layer</h3>
          <p className="mt-0.5 text-xs text-muted">
            Pick the data layer this geocoder searches. Only v3 (multi-
            layer) data layers are supported as sources today.
          </p>
        </div>
        <div className="space-y-3 p-4">
          <label className="block text-xs">
            <span className="text-muted">Data layer</span>
            <select
              value={draft.sourceLayerId}
              disabled={!canEdit}
              onChange={(e) => {
                // exactOptionalPropertyTypes: omit sourceSublayerId
                // rather than setting it to undefined when the user
                // re-picks a layer (we'll set it again when the new
                // layer's sublayers load).
                const next = { ...draft, sourceLayerId: e.target.value, searchFields: [] };
                delete next.sourceSublayerId;
                setDraft(next);
              }}
              className="mt-0.5 h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm"
            >
              <option value="">(pick a layer)</option>
              {sourceLayers?.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.title}
                </option>
              ))}
            </select>
          </label>
          {sublayers && sublayers.length > 1 ? (
            <label className="block text-xs">
              <span className="text-muted">Sublayer</span>
              <select
                value={draft.sourceSublayerId ?? ''}
                disabled={!canEdit}
                onChange={(e) => {
                  const next = { ...draft, searchFields: [] };
                  if (e.target.value) {
                    next.sourceSublayerId = e.target.value;
                  } else {
                    delete next.sourceSublayerId;
                  }
                  setDraft(next);
                }}
                className="mt-0.5 h-9 w-full rounded-md border border-border bg-surface-1 px-2 text-sm"
              >
                {sublayers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {sourceLoadError ? (
            <p className="text-xs text-danger" role="alert">
              {sourceLoadError}
            </p>
          ) : null}
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-border bg-surface-1 shadow-card">
        <div className="border-b border-border bg-surface-2 px-4 py-3">
          <h3 className="text-sm font-medium text-ink-0">Search fields</h3>
          <p className="mt-0.5 text-xs text-muted">
            Which fields should the geocoder match against? Each
            field gets a weight (1-10); higher means a match there
            contributes more to the candidate score. A parcel that
            hits both street and owner ranks above a parcel that hits
            only owner when street has a higher weight.
          </p>
        </div>
        <div className="p-4">
          {!schemaFields ? (
            <p className="text-xs text-muted">
              Pick a source layer to see its fields.
            </p>
          ) : schemaFields.length === 0 ? (
            <p className="text-xs text-muted">
              That sublayer has no fields configured.
            </p>
          ) : (
            <ul className="space-y-1">
              {schemaFields.map((f) => {
                const picked = draft.searchFields.find((s) => s.name === f.name);
                return (
                  <li
                    key={f.name}
                    className={`flex items-center gap-3 rounded border px-3 py-2 text-xs ${picked ? 'border-accent bg-accent/5' : 'border-border bg-surface-2'}`}
                  >
                    <input
                      type="checkbox"
                      checked={!!picked}
                      disabled={!canEdit}
                      onChange={() => toggleSearchField(f.name)}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-ink-0">
                        {f.label || f.name}
                      </p>
                      <p className="font-mono text-[11px] text-muted">
                        {f.name} <span className="opacity-60">({f.type})</span>
                      </p>
                    </div>
                    {picked ? (
                      <label className="flex items-center gap-1 text-[11px] text-muted">
                        Weight
                        <input
                          type="number"
                          min={1}
                          max={10}
                          value={picked.weight ?? 1}
                          disabled={!canEdit}
                          onChange={(e) =>
                            setFieldWeight(
                              f.name,
                              Math.max(
                                1,
                                Math.min(10, Number(e.target.value) || 1),
                              ),
                            )
                          }
                          className="h-7 w-12 rounded border border-border bg-surface-1 px-1 text-center font-mono"
                        />
                      </label>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-border bg-surface-1 shadow-card">
        <div className="border-b border-border bg-surface-2 px-4 py-3">
          <h3 className="text-sm font-medium text-ink-0">Options</h3>
        </div>
        <div className="grid grid-cols-1 gap-3 p-4 text-xs sm:grid-cols-2">
          <label className="block">
            <span className="text-muted">Candidate limit (1-50)</span>
            <input
              type="number"
              min={1}
              max={50}
              value={draft.candidateLimit ?? 10}
              disabled={!canEdit}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  candidateLimit: Math.max(
                    1,
                    Math.min(50, Number(e.target.value) || 10),
                  ),
                }))
              }
              className="mt-0.5 h-8 w-full rounded-md border border-border bg-surface-1 px-2 font-mono"
            />
          </label>
          <label className="block">
            <span className="text-muted">Minimum score (0.0-1.0)</span>
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={draft.minScore ?? 0.1}
              disabled={!canEdit}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  minScore: Math.max(0, Math.min(1, Number(e.target.value) || 0)),
                }))
              }
              className="mt-0.5 h-8 w-full rounded-md border border-border bg-surface-1 px-2 font-mono"
            />
          </label>
          <label className="block sm:col-span-2">
            <span className="text-muted">Spatial constraint</span>
            <select
              value={typeof draft.bboxFilter === 'string' ? draft.bboxFilter : 'wsen'}
              disabled={!canEdit}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  bboxFilter: e.target.value as 'layer-bbox' | 'none',
                }))
              }
              className="mt-0.5 h-8 w-full rounded-md border border-border bg-surface-1 px-2"
            >
              <option value="layer-bbox">
                Constrain to source layer&rsquo;s bbox (recommended)
              </option>
              <option value="none">
                No spatial constraint (search anywhere)
              </option>
            </select>
          </label>
          <label className="block sm:col-span-2">
            <span className="text-muted">
              Label template (use{' '}
              <span className="font-mono">{'{fieldName}'}</span> placeholders)
            </span>
            <input
              type="text"
              value={draft.labelTemplate ?? ''}
              disabled={!canEdit}
              placeholder="{owner_name} ({street_address})"
              onChange={(e) => {
                const next = { ...draft };
                if (e.target.value) {
                  next.labelTemplate = e.target.value;
                } else {
                  delete next.labelTemplate;
                }
                setDraft(next);
              }}
              className="mt-0.5 h-8 w-full rounded-md border border-border bg-surface-1 px-2 font-mono"
            />
            <span className="mt-1 block text-[11px] text-muted">
              Leave blank to join the search-field values with commas.
            </span>
          </label>
        </div>
      </section>

      {/* Save / discard footer */}
      {canEdit ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 px-4 py-3">
          <div className="min-w-0 flex-1 text-xs">
            {indexBuilding ? (
              <p className="inline-flex items-center gap-1 text-muted">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Building search indexes (this can take a few minutes
                for large layers)...
              </p>
            ) : error ? (
              <p className="text-danger" role="alert">
                {error}
              </p>
            ) : saved ? (
              <p className="inline-flex items-center gap-1 text-accent">
                <Check className="h-3.5 w-3.5" />
                Saved
                {indexSummary && indexSummary.rowCount > 0 ? (
                  <span className="text-muted">
                    {' '}
                    &middot; indexed{' '}
                    {indexSummary.rowCount.toLocaleString()} rows in{' '}
                    {(indexSummary.durationMs / 1000).toFixed(1)}s
                  </span>
                ) : null}
              </p>
            ) : hasChanges ? (
              <p className="text-muted">Unsaved changes.</p>
            ) : (
              <p className="text-muted">No changes.</p>
            )}
          </div>
          <button
            type="button"
            onClick={discard}
            disabled={!hasChanges || saving || indexBuilding}
            className="inline-flex h-9 items-center rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!hasChanges || saving || indexBuilding}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
          >
            {saving || indexBuilding ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {indexBuilding ? 'Indexing...' : saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      ) : null}

      {/* Test panel. Runs against the current saved config so the
          author can validate before sharing the geocoder. */}
      <section className="overflow-hidden rounded-lg border border-border bg-surface-1 shadow-card">
        <div className="border-b border-border bg-surface-2 px-4 py-3">
          <h3 className="text-sm font-medium text-ink-0">Test geocoder</h3>
          <p className="mt-0.5 text-xs text-muted">
            Try a search against the saved config. Runs as you, so
            your own authz / share-geo-limits apply.
          </p>
        </div>
        <div className="space-y-3 p-4">
          <div className="flex gap-2">
            <input
              type="text"
              value={testText}
              onChange={(e) => setTestText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void runTest();
                }
              }}
              placeholder="Type a search term and hit Enter"
              className="h-9 min-w-0 flex-1 rounded-md border border-border bg-surface-1 px-2 text-sm"
            />
            <button
              type="button"
              onClick={() => void runTest()}
              disabled={testing || testText.trim().length === 0}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-sm hover:bg-surface-2 disabled:opacity-50"
            >
              {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              Test
            </button>
          </div>
          {testError ? (
            <p className="text-xs text-danger" role="alert">
              {testError}
            </p>
          ) : null}
          {testResults ? (
            testResults.length === 0 ? (
              <p className="text-xs text-muted">
                No candidates above the minimum score. Try lowering
                minScore or adding more search fields.
              </p>
            ) : (
              <ul className="space-y-1 text-xs">
                {testResults.map((c) => (
                  <li
                    key={c.featureId}
                    className="flex items-baseline justify-between gap-3 rounded border border-border bg-surface-2 px-3 py-2"
                  >
                    <span className="min-w-0 flex-1 truncate text-ink-0">
                      {c.label}
                    </span>
                    <span className="font-mono text-[11px] text-muted">
                      score {c.score.toFixed(3)}
                    </span>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </div>
      </section>
    </div>
  );
}
