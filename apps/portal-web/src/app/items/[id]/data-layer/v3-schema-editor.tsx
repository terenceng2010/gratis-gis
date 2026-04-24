'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, Save } from 'lucide-react';
import type { DataLayerDataV3 } from '@gratis-gis/shared-types';
import { DataLayerBuilder } from '@/app/items/new/data-layer-builder';
import { V3LayerDataPanel } from './v3-layer-data-panel';

/**
 * Detail-page schema editor for v3 data_layer items.
 *
 * Mounts the same multi-layer builder the /items/new wizard uses,
 * pre-filled with the item's current v3 config, and PATCHes the
 * updated blob back to the API. Provides the "path back in" for
 * adjusting schema, coded-value domains, and constraints after create.
 *
 * Persistence note: until Phase C lands, the server stores the v3
 * blob opaquely. Saves here update item.data but don't yet reshape
 * real PostGIS tables. Once Phase C is wired, the same save path
 * will trigger column adds/drops on the materialized tables.
 */
interface Props {
  itemId: string;
  initial: DataLayerDataV3;
  canEdit: boolean;
}

export function DataLayerV3SchemaEditor({
  itemId,
  initial,
  canEdit,
}: Props) {
  const router = useRouter();
  const [data, setData] = useState<DataLayerDataV3>(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Simple dirty check. Reference inequality is fine here: the builder
  // replaces the whole value on every edit, so `data !== initial`
  // tracks any mutation the user has made.
  const dirty = data !== initial;

  async function save() {
    setError(null);

    // Re-run the same lightweight validation the wizard does so the
    // user gets the same error surface regardless of entry point.
    const labelMissing = data.layers.find(
      (l) => !l.label.trim() || !l.name.trim(),
    );
    if (labelMissing) {
      setError('Every layer needs a label and a table name.');
      return;
    }
    for (const layer of data.layers) {
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

    setSaving(true);
    try {
      const res = await fetch(`/api/portal/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data }),
      });
      if (!res.ok) {
        setError(`Save failed: ${res.status} ${await res.text()}`);
        return;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      // router.refresh re-pulls the server-rendered item so the header
      // stats (layer counts, timestamps) reflect the updated schema.
      startTransition(() => router.refresh());
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-ink-1">
        <p className="font-medium">Multi-layer feature service (v3)</p>
        <p className="mt-0.5 text-muted">
          The builder below edits schema; the panel above imports data
          into whichever layer you pick. Saving the schema re-runs table
          reconciliation on the backend (new columns added, dropped
          layers removed).
        </p>
      </div>

      {/* Data-import panel first: for most authors the first thing they
          want to do on the detail page is actually load data into the
          layer tables that were provisioned at create time. */}
      <V3LayerDataPanel
        itemId={itemId}
        layers={data.layers}
        canEdit={canEdit}
      />

      <fieldset
        disabled={!canEdit}
        className={canEdit ? undefined : 'pointer-events-none opacity-60'}
      >
        <DataLayerBuilder value={data} onChange={setData} />
      </fieldset>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {canEdit ? (
        <div className="flex items-center justify-end gap-2">
          {saved ? (
            <span className="inline-flex items-center gap-1 text-xs text-success">
              <Check className="h-3.5 w-3.5" /> Saved
            </span>
          ) : null}
          <button
            type="button"
            onClick={save}
            disabled={saving || !dirty}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save schema
          </button>
        </div>
      ) : null}
    </div>
  );
}
