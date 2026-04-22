'use client';

import { useMemo, useRef } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import type { WebMapLayerPopup } from '@gratis-gis/shared-types';
import type { LayerMetadata } from './layer-metadata';

interface Props {
  value: WebMapLayerPopup;
  metadata: LayerMetadata;
  onChange: (next: WebMapLayerPopup) => void;
}

/**
 * Click-popup editor with three body modes:
 *
 *   - All fields: list every property on the feature (zero config).
 *   - Picked fields: ordered allow-list of fields.
 *   - Template: hand-written Handlebars-lite string with {{field}}
 *     interpolation and optional `| formatter` pipes. A live preview
 *     renders against a real feature pulled from layer metadata.
 *
 * Mixed-mode popups (custom title + picked body, etc.) fall out
 * naturally from the independent title template + body mode knobs.
 */
export function PopupEditor({ value, metadata, onChange }: Props) {
  function patch(p: Partial<WebMapLayerPopup>) {
    onChange({ ...value, ...p });
  }

  return (
    <div className="space-y-3">
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
          className="h-3.5 w-3.5 rounded border-border text-accent focus:ring-accent/30"
        />
        <span className="text-ink-1">Click shows popup</span>
      </label>

      {value.enabled ? (
        <>
          <TitleEditor value={value} metadata={metadata} onPatch={patch} />

          <div>
            <label className="mb-2 block text-[10px] uppercase tracking-wide text-muted">
              Body
            </label>
            <div className="grid grid-cols-3 gap-2">
              <ModeBtn
                active={value.mode === 'all'}
                onClick={() => patch({ mode: 'all' })}
                label="All fields"
              />
              <ModeBtn
                active={value.mode === 'picked'}
                onClick={() => patch({ mode: 'picked' })}
                label="Picked"
              />
              <ModeBtn
                active={value.mode === 'template'}
                onClick={() => patch({ mode: 'template' })}
                label="Template"
              />
            </div>
          </div>

          {value.mode === 'picked' ? (
            <PickedEditor value={value} metadata={metadata} onPatch={patch} />
          ) : null}
          {value.mode === 'template' ? (
            <TemplateEditor value={value} metadata={metadata} onPatch={patch} />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function TitleEditor({
  value,
  metadata,
  onPatch,
}: {
  value: WebMapLayerPopup;
  metadata: LayerMetadata;
  onPatch: (p: Partial<WebMapLayerPopup>) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);

  function insertField(field: string) {
    const input = ref.current;
    if (!input) return;
    const token = `{{${field}}}`;
    const start = input.selectionStart ?? value.titleTemplate.length;
    const end = input.selectionEnd ?? value.titleTemplate.length;
    const next =
      value.titleTemplate.slice(0, start) +
      token +
      value.titleTemplate.slice(end);
    onPatch({ titleTemplate: next });
    requestAnimationFrame(() => {
      input.focus();
      const caret = start + token.length;
      input.setSelectionRange(caret, caret);
    });
  }

  return (
    <div>
      <label className="mb-1 block text-[10px] uppercase tracking-wide text-muted">
        Title template
      </label>
      <div className="flex gap-2">
        <input
          ref={ref}
          type="text"
          value={value.titleTemplate}
          onChange={(e) => onPatch({ titleTemplate: e.target.value })}
          placeholder={`{{name}}  (defaults to layer title)`}
          className="h-8 min-w-0 flex-1 rounded border border-border bg-surface-1 px-2 font-mono text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
        />
        {metadata.fields.length > 0 ? (
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) insertField(e.target.value);
              e.target.value = '';
            }}
            className="h-8 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
          >
            <option value="">Insert field...</option>
            {metadata.fields.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        ) : null}
      </div>
    </div>
  );
}

function PickedEditor({
  value,
  metadata,
  onPatch,
}: {
  value: WebMapLayerPopup;
  metadata: LayerMetadata;
  onPatch: (p: Partial<WebMapLayerPopup>) => void;
}) {
  function moveField(idx: number, dir: -1 | 1) {
    const target = idx + dir;
    if (target < 0 || target >= value.fields.length) return;
    const next = [...value.fields];
    const tmp = next[idx]!;
    next[idx] = next[target]!;
    next[target] = tmp;
    onPatch({ fields: next });
  }
  function removeField(idx: number) {
    onPatch({ fields: value.fields.filter((_, i) => i !== idx) });
  }
  function addField(name: string) {
    if (!name || value.fields.includes(name)) return;
    onPatch({ fields: [...value.fields, name] });
  }
  const unpicked = metadata.fields.filter((f) => !value.fields.includes(f));

  return (
    <div className="space-y-2 rounded-md border border-border bg-surface-1 p-2">
      {value.fields.length === 0 ? (
        <p className="text-[11px] text-muted">
          No fields yet. Add one from the dropdown below.
        </p>
      ) : (
        <ul className="space-y-1">
          {value.fields.map((f, i) => (
            <li key={f} className="flex items-center gap-1">
              <span className="flex-1 truncate text-xs">{f}</span>
              <button
                type="button"
                onClick={() => moveField(i, -1)}
                disabled={i === 0}
                aria-label="Move up"
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2 disabled:opacity-30"
              >
                <ArrowUp className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={() => moveField(i, 1)}
                disabled={i === value.fields.length - 1}
                aria-label="Move down"
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2 disabled:opacity-30"
              >
                <ArrowDown className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={() => removeField(i)}
                aria-label="Remove"
                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-danger"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        {metadata.fields.length > 0 ? (
          <select
            value=""
            onChange={(e) => {
              addField(e.target.value);
              e.target.value = '';
            }}
            disabled={unpicked.length === 0}
            className="h-8 min-w-0 flex-1 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30 disabled:opacity-50"
          >
            <option value="">
              {unpicked.length === 0 ? 'All fields added' : 'Add a field...'}
            </option>
            {unpicked.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            placeholder="field name"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                addField((e.target as HTMLInputElement).value.trim());
                (e.target as HTMLInputElement).value = '';
              }
            }}
            className="h-8 min-w-0 flex-1 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
          />
        )}
        {metadata.loading ? (
          <span className="self-center text-[11px] text-muted">loading...</span>
        ) : null}
      </div>
    </div>
  );
}

function TemplateEditor({
  value,
  metadata,
  onPatch,
}: {
  value: WebMapLayerPopup;
  metadata: LayerMetadata;
  onPatch: (p: Partial<WebMapLayerPopup>) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  function insert(text: string) {
    const el = ref.current;
    if (!el) return;
    const start = el.selectionStart ?? value.bodyTemplate.length;
    const end = el.selectionEnd ?? value.bodyTemplate.length;
    const next =
      value.bodyTemplate.slice(0, start) + text + value.bodyTemplate.slice(end);
    onPatch({ bodyTemplate: next });
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + text.length;
      el.setSelectionRange(caret, caret);
    });
  }

  // Live preview: render the body against a sample feature, falling
  // back to a synthetic one if the layer hasn't loaded any yet.
  const sample = useMemo(
    () => metadata.sampleProperties ?? synthesizeSample(metadata),
    [metadata],
  );
  const preview = useMemo(
    () => renderPreview(value.bodyTemplate, sample),
    [value.bodyTemplate, sample],
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {metadata.fields.length > 0 ? (
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) insert(`{{${e.target.value}}}`);
              e.target.value = '';
            }}
            className="h-8 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
          >
            <option value="">Insert field...</option>
            {metadata.fields.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        ) : null}
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) insert(e.target.value);
            e.target.value = '';
          }}
          className="h-8 rounded border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
        >
          <option value="">Insert formatter...</option>
          <option value="| upper">| upper</option>
          <option value="| lower">| lower</option>
          <option value="| number">| number</option>
          <option value="| currency:USD">| currency:USD</option>
          <option value="| date:short">| date:short</option>
          <option value="| date:medium">| date:medium</option>
        </select>
        <button
          type="button"
          onClick={() => insert('<br>')}
          className="h-8 rounded border border-border bg-surface-1 px-2 text-[11px] text-ink-1 hover:bg-surface-2"
        >
          +line break
        </button>
      </div>

      <textarea
        ref={ref}
        value={value.bodyTemplate}
        onChange={(e) => onPatch({ bodyTemplate: e.target.value })}
        placeholder={`<strong>{{name}}</strong><br>\nCategory: {{category}}<br>\nFloors: {{floors | number}}`}
        rows={6}
        className="w-full rounded border border-border bg-surface-0 px-2 py-1.5 font-mono text-xs focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
      />

      <div>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted">
          Preview
        </div>
        <div
          className="gg-popup rounded border border-dashed border-border bg-surface-1 p-3"
          /* eslint-disable-next-line react/no-danger */
          dangerouslySetInnerHTML={{ __html: preview }}
        />
      </div>

      <p className="text-[11px] text-muted">
        <code className="rounded bg-surface-2 px-1">{`{{field}}`}</code> reads
        a property;{' '}
        <code className="rounded bg-surface-2 px-1">{`{{field | fmt}}`}</code>{' '}
        formats it. Field values are always HTML-escaped; wrap them in
        your own markup for styling.
      </p>
    </div>
  );
}

function ModeBtn({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border p-2 text-xs font-medium transition-colors ${
        active
          ? 'border-accent bg-accent/5 text-ink-0 ring-2 ring-accent/30'
          : 'border-border bg-surface-1 text-muted hover:bg-surface-2'
      }`}
    >
      {label}
    </button>
  );
}

function synthesizeSample(metadata: LayerMetadata): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of metadata.fields) {
    out[f] = metadata.valuesByField[f]?.[0] ?? `<${f}>`;
  }
  return out;
}

/**
 * Render a template string against sample properties, mirroring the
 * canvas's runtime renderer so preview matches what the user will see
 * at click time. Kept small and dependency-free.
 */
function renderPreview(
  template: string,
  props: Record<string, unknown>,
): string {
  if (!template) return '<em class="gg-popup-empty">(empty template)</em>';
  return template.replace(
    /\{\{\s*([\w.-]+)\s*(?:\|\s*([\w.-]+)(?:\s*:\s*([^}]+))?\s*)?\}\}/g,
    (_, key: string, formatter?: string, arg?: string) => {
      const raw = props[key];
      if (raw === undefined || raw === null) return '';
      const str = String(raw);
      const fmt = formatter?.toLowerCase();
      let out = str;
      if (fmt === 'upper') out = str.toUpperCase();
      else if (fmt === 'lower') out = str.toLowerCase();
      else if (fmt === 'number') {
        const n = Number(str);
        if (!Number.isNaN(n)) out = n.toLocaleString();
      } else if (fmt === 'currency') {
        const n = Number(str);
        if (!Number.isNaN(n)) {
          try {
            out = n.toLocaleString(undefined, {
              style: 'currency',
              currency: arg?.trim() || 'USD',
            });
          } catch {
            out = n.toLocaleString();
          }
        }
      } else if (fmt === 'date') {
        const d = new Date(str);
        if (!Number.isNaN(d.getTime())) {
          const style =
            (arg?.trim() as 'short' | 'long' | 'full' | undefined) ?? 'medium';
          try {
            out = d.toLocaleDateString(undefined, { dateStyle: style });
          } catch {
            out = d.toLocaleDateString();
          }
        }
      }
      return escapeHtml(out);
    },
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
