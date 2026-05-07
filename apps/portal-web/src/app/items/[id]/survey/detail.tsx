// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Clock,
  ExternalLink,
  FileText,
  Loader2,
  Map as MapIcon,
  Play,
  UserCircle,
  Wrench,
  X,
} from 'lucide-react';
import type { Item, SurveyData, ViewerTool, WebAppData } from '@gratis-gis/shared-types';
import { DEFAULT_SURVEY_TOOLS } from '@gratis-gis/shared-types';
import { PickMapDialog } from '../editor/pick-map-dialog';
import { ConvertToCustomButton } from '../convert-to-custom';

interface Props {
  itemId: string;
  initial: SurveyData;
  canEdit: boolean;
}

/**
 * Survey Response Viewer detail page (#260).
 *
 * Mirrors ViewerDetail's structure but trades target-layer
 * configuration for form binding: a Survey app browses one form's
 * submissions, so it has a single "form" reference instead of a
 * list of layer targets. The runtime resolves the paired data_layer
 * (form.data.linkedLayerId; see #283 / #284) at render time and
 * uses that as its single map source.
 *
 * Authoring surfaces:
 *   1. Form pointer: required. The runtime can't render anything
 *      without a form to read submissions from. Picker lists
 *      existing form items in the org.
 *   2. Optional reference map (basemap + viewport) + tool palette,
 *      both shaped exactly like ViewerData.
 *   3. defaultLookbackDays + hideSubmitter: small response-flavored
 *      knobs.
 *
 * Persistence: PATCH /api/portal/items/<id> with the canonical
 * WebAppData wrapper around SurveyData.
 */
export function SurveyDetail({ itemId, initial, canEdit }: Props) {
  const [survey, setSurvey] = useState<SurveyData>(() => ({
    ...initial,
    tools:
      initial.tools && initial.tools.length > 0
        ? initial.tools
        : DEFAULT_SURVEY_TOOLS,
  }));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickingForm, setPickingForm] = useState(false);
  const [pickingMap, setPickingMap] = useState(false);

  // Resolved form item title for the bound formId.
  const [formTitle, setFormTitle] = useState<string | null>(null);
  const [formMissing, setFormMissing] = useState(false);
  useEffect(() => {
    if (!survey.formId) {
      setFormTitle(null);
      setFormMissing(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/portal/items/${survey.formId}`);
        if (cancelled) return;
        if (!res.ok) {
          setFormTitle(null);
          setFormMissing(true);
          return;
        }
        const item = (await res.json()) as Item;
        setFormTitle(item.title);
        setFormMissing(false);
      } catch {
        if (!cancelled) {
          setFormTitle(null);
          setFormMissing(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [survey.formId]);

  // Resolved referenced map title (optional).
  const [mapTitle, setMapTitle] = useState<string | null>(null);
  useEffect(() => {
    if (!survey.mapId) {
      setMapTitle(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/portal/items/${survey.mapId}`);
        if (cancelled) return;
        if (!res.ok) return;
        const item = (await res.json()) as Item;
        setMapTitle(item.title);
      } catch {
        // Silent: missing map means the runtime falls back to its
        // default basemap + auto-fit camera.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [survey.mapId]);

  function markDirty() {
    setDirty(true);
    setSaved(false);
  }

  function pickForm(formId: string | null) {
    setSurvey((cur) => {
      const next = { ...cur };
      if (formId === null) delete next.formId;
      else next.formId = formId;
      return next;
    });
    markDirty();
  }

  function pickMap(mapId: string | null) {
    setSurvey((cur) => {
      const next = { ...cur };
      if (mapId === null) delete next.mapId;
      else next.mapId = mapId;
      return next;
    });
    markDirty();
  }

  function toggleTool(tool: ViewerTool, on: boolean) {
    setSurvey((cur) => ({
      ...cur,
      tools: on
        ? [...cur.tools.filter((t) => t !== tool), tool]
        : cur.tools.filter((t) => t !== tool),
    }));
    markDirty();
  }

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    const payload: WebAppData = {
      version: 1,
      template: 'survey',
      config: { template: 'survey', survey },
    };
    try {
      const res = await fetch(`/api/portal/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: payload }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${body}`);
      }
      setDirty(false);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [itemId, survey]);

  function cancel() {
    setSurvey({
      ...initial,
      tools:
        initial.tools && initial.tools.length > 0
          ? initial.tools
          : DEFAULT_SURVEY_TOOLS,
    });
    setDirty(false);
    setSaved(false);
    setError(null);
  }

  return (
    <div>
      <header className="mb-4 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-ink-0">
            Survey Response Viewer
          </h1>
          <p className="text-xs text-muted">
            Browse responses to a form on a map, with click-through to
            the full form receipt.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {error ? (
            <span className="text-[11px] text-rose-700">{error}</span>
          ) : dirty ? (
            <span className="text-[11px] text-amber-700">
              Unsaved changes
            </span>
          ) : canEdit && saved ? (
            <span className="text-[11px] text-emerald-700">Saved</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`/items/${itemId}/survey/run`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-1 px-3 py-1.5 text-sm font-medium hover:bg-surface-2"
            title="Open this survey in a new tab"
          >
            <Play className="h-3.5 w-3.5" />
            Open survey
          </a>
          {canEdit ? (
            <>
              <ConvertToCustomButton
                itemId={itemId}
                sourceTemplate="survey"
                {...(survey.formId
                  ? // Survey has no editor-target list of its own;
                    // the runtime synthesizes a single target from
                    // the bound form's paired data_layer at render
                    // time. We can't resolve that synchronously
                    // here without an extra fetch, so the conversion
                    // ships with empty targets and the user can
                    // re-add them in the designer. mapId carries
                    // over directly.
                    {}
                  : {})}
                {...(survey.mapId ? { sourceMapId: survey.mapId } : {})}
                sourceTargets={[]}
              />
              <button
                type="button"
                onClick={cancel}
                disabled={!dirty || saving}
                className="rounded-md border border-border bg-surface-1 px-3 py-1.5 text-sm hover:bg-surface-2 disabled:opacity-50"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={!dirty || saving}
                className="inline-flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : null}
                Save
              </button>
            </>
          ) : null}
        </div>
      </header>

      {/* Form binding card. Required: without a formId the runtime
          has no submissions to render. */}
      <section className="mb-4 rounded-lg border border-border bg-surface-1 shadow-card">
        <div className="border-b border-border px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-0">
            <FileText className="h-4 w-4 text-orange-600" />
            Form
          </h2>
          <p className="text-xs text-muted">
            The form whose submissions this survey app browses.
          </p>
        </div>
        <div className="px-4 py-4 text-sm">
          {survey.formId ? (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-ink-0">
                  {formTitle ?? survey.formId.slice(0, 8)}
                </p>
                {formMissing ? (
                  <p className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-rose-700">
                    <AlertTriangle className="h-3 w-3" />
                    Form not found or not visible to you
                  </p>
                ) : (
                  <p className="text-[11px] text-muted">
                    Submissions read from the paired data layer.
                  </p>
                )}
              </div>
              {canEdit ? (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setPickingForm(true)}
                    className="rounded-md border border-border bg-surface-1 px-2 py-1 text-xs hover:bg-surface-2"
                  >
                    Change
                  </button>
                  <button
                    type="button"
                    onClick={() => pickForm(null)}
                    className="rounded-md border border-border bg-surface-1 px-2 py-1 text-xs hover:bg-surface-2"
                    aria-label="Clear bound form"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted">
                No form bound yet. Pick the form whose responses this
                viewer will surface.
              </p>
              {canEdit ? (
                <button
                  type="button"
                  onClick={() => setPickingForm(true)}
                  className="rounded-md border border-border bg-surface-1 px-3 py-1.5 text-xs font-medium hover:bg-surface-2"
                >
                  Pick form
                </button>
              ) : null}
            </div>
          )}
        </div>
      </section>

      {/* Reference map (optional) + reset. */}
      <section className="mb-4 rounded-lg border border-border bg-surface-1 shadow-card">
        <div className="border-b border-border px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-0">
            <MapIcon className="h-4 w-4 text-sky-600" />
            Reference map
          </h2>
          <p className="text-xs text-muted">
            Optional. Inherits basemap + viewport. Leave blank to fall
            back to the survey&apos;s submission extent.
          </p>
        </div>
        <div className="px-4 py-4 text-sm">
          {survey.mapId ? (
            <div className="flex items-center justify-between gap-3">
              <span className="truncate font-medium text-ink-0">
                {mapTitle ?? survey.mapId.slice(0, 8)}
              </span>
              {canEdit ? (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setPickingMap(true)}
                    className="rounded-md border border-border bg-surface-1 px-2 py-1 text-xs hover:bg-surface-2"
                  >
                    Change
                  </button>
                  <button
                    type="button"
                    onClick={() => pickMap(null)}
                    className="rounded-md border border-border bg-surface-1 px-2 py-1 text-xs hover:bg-surface-2"
                    aria-label="Clear referenced map"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ) : null}
            </div>
          ) : canEdit ? (
            <button
              type="button"
              onClick={() => setPickingMap(true)}
              className="rounded-md border border-border bg-surface-1 px-3 py-1.5 text-xs font-medium hover:bg-surface-2"
            >
              Pick map
            </button>
          ) : (
            <p className="text-xs text-muted">No reference map.</p>
          )}
        </div>
      </section>

      {/* Tool palette. */}
      <section className="mb-4 rounded-lg border border-border bg-surface-1 shadow-card">
        <div className="border-b border-border px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-0">
            <Wrench className="h-4 w-4 text-muted" />
            Toolbar
          </h2>
          <p className="text-xs text-muted">
            Read-side tools available in the survey runtime.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-3">
          {ALL_TOOLS.map(({ key, label, hint }) => {
            const on = survey.tools.includes(key);
            return (
              <label key={key} className="flex items-start gap-2 text-sm" title={hint}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={!canEdit}
                  onChange={(e) => toggleTool(key, e.target.checked)}
                  className="mt-0.5 h-4 w-4 cursor-pointer"
                />
                <span>
                  <span className="font-medium text-ink-1">{label}</span>
                  <span className="block text-[11px] text-muted">{hint}</span>
                </span>
              </label>
            );
          })}
        </div>
      </section>

      {/* Survey-flavored knobs. */}
      <section className="mb-4 rounded-lg border border-border bg-surface-1 shadow-card">
        <div className="border-b border-border px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-0">
            <Clock className="h-4 w-4 text-muted" />
            Response options
          </h2>
        </div>
        <div className="space-y-3 px-4 py-3 text-sm">
          <label className="flex items-center justify-between gap-3">
            <span>
              <span className="block font-medium text-ink-1">
                Default look-back window
              </span>
              <span className="block text-[11px] text-muted">
                Pre-filter submissions to this many days back from now
                when the survey opens. Leave blank to show all.
              </span>
            </span>
            <input
              type="number"
              min={0}
              step={1}
              disabled={!canEdit}
              value={survey.defaultLookbackDays ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                setSurvey((cur) => {
                  const next = { ...cur };
                  if (v === '') delete next.defaultLookbackDays;
                  else next.defaultLookbackDays = Math.max(0, parseInt(v, 10) || 0);
                  return next;
                });
                markDirty();
              }}
              className="h-8 w-24 rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
          </label>

          <label className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1.5">
              <UserCircle className="h-3.5 w-3.5 text-muted" />
              <span>
                <span className="block font-medium text-ink-1">
                  Hide submitter column
                </span>
                <span className="block text-[11px] text-muted">
                  Don&apos;t show who submitted each response. For
                  anonymous-feedback workflows.
                </span>
              </span>
            </span>
            <input
              type="checkbox"
              disabled={!canEdit}
              checked={survey.hideSubmitter ?? false}
              onChange={(e) => {
                setSurvey((cur) => {
                  const next = { ...cur };
                  if (e.target.checked) next.hideSubmitter = true;
                  else delete next.hideSubmitter;
                  return next;
                });
                markDirty();
              }}
              className="h-4 w-4 cursor-pointer"
            />
          </label>
        </div>
      </section>

      {/* Form-picker reuses the existing items endpoint with a
          ?type=form filter. Today the picker is a barebones dropdown
          server-rendered list; a richer picker dialog can replace
          this in a follow-up. */}
      {pickingForm ? (
        <FormPickerDialog
          onClose={() => setPickingForm(false)}
          onPick={(formId) => {
            pickForm(formId);
            setPickingForm(false);
          }}
        />
      ) : null}

      <PickMapDialog
        open={pickingMap}
        onClose={() => setPickingMap(false)}
        onPick={(m) => {
          pickMap(m.id);
          setPickingMap(false);
        }}
      />
    </div>
  );
}

/**
 * Minimal in-component picker for `form` items. Lists the org's
 * forms and emits the picked id. A richer dialog (with search,
 * thumbnails, recent-first ordering) can replace this; for now the
 * narrow surface keeps the slice small.
 */
function FormPickerDialog({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (formId: string) => void;
}) {
  const [forms, setForms] = useState<Array<{ id: string; title: string }> | null>(
    null,
  );
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/portal/items?type=form&lite=1');
        if (!res.ok) {
          if (!cancelled) setForms([]);
          return;
        }
        const rows = (await res.json()) as Array<{
          id: string;
          title: string;
        }>;
        if (!cancelled) setForms(rows);
      } catch {
        if (!cancelled) setForms([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      role="dialog"
      aria-label="Pick a form"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border bg-surface-1 p-5 shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-3 text-sm font-semibold text-ink-0">Pick a form</h3>
        {forms === null ? (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading forms...
          </div>
        ) : forms.length === 0 ? (
          <p className="text-sm text-muted">
            No forms in this organization yet. Create a form first; the
            survey app then browses its submissions.
          </p>
        ) : (
          <ul className="max-h-80 space-y-1 overflow-auto rounded-md border border-border bg-surface-0 p-2">
            {forms.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  onClick={() => onPick(f.id)}
                  className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-surface-2"
                >
                  <span className="truncate text-ink-1">{f.title}</span>
                  <ExternalLink className="h-3 w-3 text-muted" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border bg-surface-1 px-3 py-1.5 text-sm hover:bg-surface-2"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

const ALL_TOOLS: Array<{ key: ViewerTool; label: string; hint: string }> = [
  { key: 'select', label: 'Select', hint: 'Pick responses to inspect.' },
  { key: 'query', label: 'Query', hint: 'Filter submissions by attribute or extent.' },
  { key: 'measure', label: 'Measure', hint: 'Distance + area.' },
  {
    key: 'attribute-table',
    label: 'Attribute table',
    hint: 'Tabular browse of every submission.',
  },
  { key: 'legend', label: 'Legend', hint: 'Symbology key from the bound layer.' },
  { key: 'print', label: 'Print', hint: 'Print the current view.' },
];
