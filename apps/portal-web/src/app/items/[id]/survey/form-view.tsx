'use client';

import { useEffect, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Loader2,
  X,
} from 'lucide-react';
import type { FormSchema, Question } from '@gratis-gis/form-schema';
import type { MapLayer, PickListData } from '@gratis-gis/shared-types';

interface Props {
  open: boolean;
  /** The form this survey is bound to. Drives the question order
   *  and how each row's value is rendered. */
  schema: FormSchema | null;
  /** Resolved pick lists referenced by select-one / select-many
   *  questions, indexed by pick_list item id. The Survey runtime
   *  page server-side fetches these so we can render labels here
   *  without an extra round-trip. */
  pickLists: Record<string, PickListData>;
  /** Map layer the table is currently focused on. We pull the row's
   *  property values straight off feature.properties. */
  layer: MapLayer | null;
  /** Currently-selected feature properties bag. The runtime resolves
   *  which feature is "active" (first selected; cycled by prev/next)
   *  and hands its properties to us. null = nothing selected, render
   *  the empty state. */
  activeProperties: Record<string, unknown> | null;
  /** Total selected count, for the "n of N" pager. */
  selectedCount: number;
  /** 0-based index of the currently-displayed feature in the
   *  selection set. */
  activeIndex: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}

/**
 * Form-view side panel for the Survey Response Viewer (#260 / #320).
 *
 * Renders the selected submission as the form, not as a row of
 * columns. Walks the FormSchema's questions list in order, looks up
 * each question's bound column on the row's properties, and renders
 * the value with a question-type-aware widget.
 *
 * Why a side panel instead of the existing click-popup: popups are
 * ephemeral and crowded; the Data-tab pattern lets the user scan
 * many submissions in sequence (prev / next) without losing context
 * of the form structure.
 *
 * Phase 1 covers the core question types (text, choice, date, group,
 * page); audio / video / sketch / signature show a "captured" badge
 * with a download link rather than embedded playback. The rest land
 * as the runtime grows.
 */
export function FormView({
  open,
  schema,
  pickLists,
  layer: _layer,
  activeProperties,
  selectedCount,
  activeIndex,
  onPrev,
  onNext,
  onClose,
}: Props) {
  // Look up _submitted_at / _created_at and _submitted_by / _created_by
  // off the row. Forms write the canonical "submitted" pair via the
  // form-mirror path (#284) but feature-tracking columns also exist
  // on every v3 row (#39). Prefer the form-specific names where
  // available, fall back to the editor-tracking ones.
  const submittedAt =
    (activeProperties?.['submitted_at'] as string | undefined) ||
    (activeProperties?.['_created_at'] as string | undefined) ||
    null;
  const submittedBy =
    (activeProperties?.['submitted_by'] as string | undefined) ||
    (activeProperties?.['_created_by'] as string | undefined) ||
    null;

  // #331: resolve a submitted_by UUID into a human display name.
  // Cached across renders so prev/next walks through a selection
  // don't re-fetch the same name; cleared lazily as new submitter
  // ids appear. The fetcher hits the same /api/portal/users?ids=
  // endpoint the share popover uses.
  const [userNames, setUserNames] = useState<Record<string, string>>({});
  useEffect(() => {
    const looksLikeUuid =
      typeof submittedBy === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        submittedBy,
      );
    if (!looksLikeUuid) return;
    if (userNames[submittedBy as string]) return;
    let abort = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/portal/users?ids=${encodeURIComponent(submittedBy as string)}`,
        );
        if (!res.ok) return;
        const rows = (await res.json()) as Array<{
          id: string;
          fullName: string | null;
          username: string;
        }>;
        if (abort) return;
        setUserNames((prev) => {
          const next = { ...prev };
          for (const u of rows) {
            next[u.id] = u.fullName?.trim() || u.username;
          }
          return next;
        });
      } catch {
        /* non-fatal -- the UUID stays visible as a fallback */
      }
    })();
    return () => {
      abort = true;
    };
  }, [submittedBy, userNames]);

  if (!open) return null;

  const submittedByDisplay =
    submittedBy !== null ? userNames[submittedBy] ?? submittedBy : null;

  return (
    <div className="flex h-full w-full flex-col">
      {/* Header: nav arrows + position counter + close */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-surface-1 px-3 py-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onPrev}
            disabled={selectedCount <= 1}
            className="inline-flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-ink-0 disabled:cursor-not-allowed disabled:opacity-40"
            title="Previous submission"
            aria-label="Previous submission"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onNext}
            disabled={selectedCount <= 1}
            className="inline-flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-ink-0 disabled:cursor-not-allowed disabled:opacity-40"
            title="Next submission"
            aria-label="Next submission"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          {selectedCount > 0 ? (
            <span className="ml-1 text-xs tabular-nums text-muted">
              {activeIndex + 1} of {selectedCount}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-ink-0"
          aria-label="Close form view"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {!schema ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-xs italic text-muted">
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            Loading form schema...
          </div>
        ) : !activeProperties ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-xs italic text-muted">
            <span>
              Select a submission on the map or in the table to view its
              answers.
            </span>
          </div>
        ) : (
          <div className="space-y-4 p-4">
            {/* Title + submission metadata */}
            <div>
              <h2 className="inline-flex items-center gap-2 text-base font-semibold text-ink-0">
                <ClipboardList className="h-4 w-4 text-violet-600" />
                {schema.title || 'Submission'}
              </h2>
              {(submittedBy || submittedAt) && (
                <dl className="mt-2 space-y-1 rounded-md border border-border bg-surface-2 px-3 py-2 text-xs">
                  {submittedBy && (
                    <div className="flex gap-2">
                      <dt className="text-muted">Submitted by</dt>
                      <dd className="font-medium text-ink-1">
                        {submittedByDisplay}
                      </dd>
                    </div>
                  )}
                  {submittedAt && (
                    <div className="flex gap-2">
                      <dt className="text-muted">Submitted at</dt>
                      <dd className="font-medium text-ink-1">
                        {formatDateTime(submittedAt)}
                      </dd>
                    </div>
                  )}
                </dl>
              )}
            </div>

            {/* Walk the question tree. */}
            <div className="space-y-3 text-sm">
              {schema.questions.map((q) => (
                <QuestionAnswer
                  key={q.id}
                  question={q}
                  values={activeProperties}
                  pickLists={pickLists}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One question + its rendered value. Recurses into group / page so
 * nested questions render under their parent's heading.
 */
function QuestionAnswer({
  question,
  values,
  pickLists,
}: {
  question: Question;
  values: Record<string, unknown>;
  pickLists: Record<string, PickListData>;
}) {
  // Page / group: render label as a section header + walk children.
  if (question.type === 'page' || question.type === 'group') {
    const children =
      'children' in question && Array.isArray(question.children)
        ? (question.children as Question[])
        : [];
    return (
      <section className="space-y-2 border-l-2 border-violet-200 pl-3">
        {question.label && (
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
            {question.label}
          </h3>
        )}
        <div className="space-y-3">
          {children.map((c) => (
            <QuestionAnswer
              key={c.id}
              question={c}
              values={values}
              pickLists={pickLists}
            />
          ))}
        </div>
      </section>
    );
  }

  // Static / no-value question types.
  if (
    question.type === 'note' ||
    question.type === 'divider' ||
    question.type === 'image-display' ||
    question.type === 'hidden'
  ) {
    return null;
  }

  // Pull the value off the row. The bind column is the question's
  // bindTo.column when set, else the question id (matches how the
  // form mirror writes properties, #294).
  const column =
    'bindTo' in question && question.bindTo && 'column' in question.bindTo
      ? (question.bindTo.column as string | undefined) || question.id
      : question.id;
  const raw = values[column];

  return (
    <div>
      <div className="text-xs text-muted">{question.label || question.id}</div>
      <div className="text-sm text-ink-0">
        {renderValue(question, raw, pickLists)}
      </div>
    </div>
  );
}

/**
 * Question-type-aware value renderer. Keep simple: empty -> em-dash,
 * coded values -> labels, dates -> locale-formatted, booleans ->
 * Yes/No, attachments -> "captured" badge (a future slice can wire
 * the actual thumbnail / playback).
 */
function renderValue(
  q: Question,
  value: unknown,
  pickLists: Record<string, PickListData>,
): JSX.Element {
  if (value === null || value === undefined || value === '') {
    return <span className="italic text-muted">No answer</span>;
  }

  switch (q.type) {
    case 'boolean':
      return <span>{value ? 'Yes' : 'No'}</span>;
    case 'geopoint':
    case 'geotrace':
    case 'geoshape': {
      // Form runtime stores a geopoint as { lat, lng, accuracy? } and
      // line/polygon answers as arrays of those. Render the point as
      // "33.96942, -116.96896 (±105m)" instead of the default
      // String(value) which prints "[object Object]".
      const v = value as
        | { lat?: unknown; lng?: unknown; accuracy?: unknown }
        | unknown[];
      if (Array.isArray(v)) {
        return (
          <span className="font-mono text-xs">
            {v.length} vertices
          </span>
        );
      }
      if (
        v &&
        typeof v === 'object' &&
        typeof (v as { lat?: unknown }).lat === 'number' &&
        typeof (v as { lng?: unknown }).lng === 'number'
      ) {
        const { lat, lng, accuracy } = v as {
          lat: number;
          lng: number;
          accuracy?: number;
        };
        const acc =
          typeof accuracy === 'number'
            ? ` (±${Math.round(accuracy)}m)`
            : '';
        return (
          <span className="font-mono text-xs">
            {lat.toFixed(5)}, {lng.toFixed(5)}
            {acc}
          </span>
        );
      }
      return <span className="italic text-muted">No answer</span>;
    }
    case 'select-one':
      return <span>{labelForCode(q, value, pickLists) ?? String(value)}</span>;
    case 'select-many': {
      // Stored as comma-separated string by the mirror; split + label-up.
      const parts = Array.isArray(value)
        ? value.map(String)
        : String(value).split(',').map((s) => s.trim());
      const labels = parts.map(
        (v) => labelForCode(q, v, pickLists) ?? v,
      );
      return <span>{labels.join(', ')}</span>;
    }
    case 'date':
    case 'time':
    case 'datetime':
      return <span>{formatDateTime(String(value))}</span>;
    case 'photo':
    case 'video':
    case 'audio':
    case 'sketch':
    case 'signature':
    case 'file': {
      // Phase 1: show a "captured" badge with a link if the value
      // is a URL, else a plain marker. Real attachment thumbnails /
      // playback land in a follow-up that hooks #267.
      const s = String(value);
      if (s.startsWith('http')) {
        return (
          <a
            href={s}
            target="_blank"
            rel="noreferrer"
            className="text-accent hover:underline"
          >
            View attachment
          </a>
        );
      }
      return <span className="italic text-muted">Captured</span>;
    }
    default:
      return <span className="whitespace-pre-wrap">{String(value)}</span>;
  }
}

function labelForCode(
  q: Question,
  code: unknown,
  pickLists: Record<string, PickListData>,
): string | null {
  if (
    !('options' in q) &&
    !('pickListItemId' in (q as { pickListItemId?: unknown }))
  ) {
    return null;
  }
  // Inline options take precedence: select-one with `options:[]`.
  const inline = (q as { options?: Array<{ code: string; label: string }> })
    .options;
  if (Array.isArray(inline)) {
    const hit = inline.find((o) => o.code === String(code));
    if (hit) return hit.label;
  }
  // Pick-list ref: look up the resolved PickListData.
  const pickListId = (q as { pickListItemId?: string }).pickListItemId;
  if (pickListId && pickLists[pickListId]) {
    const pl = pickLists[pickListId]!;
    const hit = pl.entries.find((v) => v.code === String(code));
    if (hit) return hit.label;
  }
  return null;
}

function formatDateTime(s: string): string {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString();
}
