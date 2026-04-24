'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Check,
  ExternalLink,
  Loader2,
  Save,
} from 'lucide-react';
import type { BrandingConfig } from './page';

/**
 * Admin form for the five Organization landing-page knobs.
 *
 * Sends a sparse PATCH so only changed fields round-trip; omitted
 * fields are left untouched server-side. Featured items picker is
 * deliberately deferred — the current release accepts a comma-
 * separated list of UUIDs for power users, and a proper item picker
 * lands as a follow-up once a reusable cross-page item picker
 * exists.
 */
interface Props {
  initial: BrandingConfig;
}

export function BrandingForm({ initial }: Props) {
  const router = useRouter();
  const [title, setTitle] = useState(initial.landingTitle ?? '');
  const [subtitle, setSubtitle] = useState(initial.landingSubtitle ?? '');
  const [heroImageUrl, setHeroImageUrl] = useState(
    initial.landingHeroImageUrl ?? '',
  );
  const [showPublicItems, setShowPublicItems] = useState(
    initial.landingShowPublicItems,
  );
  const [featuredIdsText, setFeaturedIdsText] = useState(
    initial.landingFeaturedItemIds.join(', '),
  );

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Reference-equality-ish dirty check. Comparing strings + booleans +
  // arrays covers every field. Feature ids compared as a normalized
  // space-less string so 'a, b' vs 'a,b' reads as no change.
  const dirty = useMemo(() => {
    if ((title.trim() || null) !== (initial.landingTitle ?? null)) return true;
    if ((subtitle.trim() || null) !== (initial.landingSubtitle ?? null))
      return true;
    if ((heroImageUrl.trim() || null) !== (initial.landingHeroImageUrl ?? null))
      return true;
    if (showPublicItems !== initial.landingShowPublicItems) return true;
    const parsed = parseIds(featuredIdsText);
    const saved = initial.landingFeaturedItemIds;
    if (parsed.length !== saved.length) return true;
    for (let i = 0; i < parsed.length; i += 1) {
      if (parsed[i] !== saved[i]) return true;
    }
    return false;
  }, [
    title,
    subtitle,
    heroImageUrl,
    showPublicItems,
    featuredIdsText,
    initial,
  ]);

  async function save() {
    setError(null);
    const parsedIds = parseIds(featuredIdsText);
    // Shallow UUID sanity check — catches obvious paste mistakes
    // before round-tripping to the backend, where invalid ids would
    // be filtered silently.
    const bad = parsedIds.filter((id) => !UUID_RE.test(id));
    if (bad.length > 0) {
      setError(
        `Featured item ids contain invalid UUIDs: ${bad
          .slice(0, 3)
          .join(', ')}${bad.length > 3 ? '…' : ''}`,
      );
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        landingTitle: title.trim() || null,
        landingSubtitle: subtitle.trim() || null,
        landingHeroImageUrl: heroImageUrl.trim() || null,
        landingShowPublicItems: showPublicItems,
        landingFeaturedItemIds: parsedIds,
      };
      const res = await fetch('/api/portal/admin/branding', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(`Save failed: ${res.status} ${await res.text()}`);
        return;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      startTransition(() => router.refresh());
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className="space-y-4 rounded-lg border border-border bg-surface-1 p-5">
        <div>
          <label
            htmlFor="landing-title"
            className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted"
          >
            Title
          </label>
          <input
            id="landing-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={initial.name}
            maxLength={200}
            className="h-10 w-full rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
          <p className="mt-1 text-[11px] text-muted">
            Shown as the hero heading. Leave blank to fall back to the
            organization name (&ldquo;{initial.name}&rdquo;).
          </p>
        </div>

        <div>
          <label
            htmlFor="landing-subtitle"
            className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted"
          >
            Subtitle
          </label>
          <input
            id="landing-subtitle"
            type="text"
            value={subtitle}
            onChange={(e) => setSubtitle(e.target.value)}
            placeholder="Public geospatial content for our community"
            maxLength={500}
            className="h-10 w-full rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
          <p className="mt-1 text-[11px] text-muted">
            One-line tagline under the title. Optional.
          </p>
        </div>

        <div>
          <label
            htmlFor="landing-hero"
            className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted"
          >
            Hero image URL
          </label>
          <input
            id="landing-hero"
            type="url"
            value={heroImageUrl}
            onChange={(e) => setHeroImageUrl(e.target.value)}
            placeholder="https://…"
            maxLength={2048}
            className="h-10 w-full rounded-md border border-border bg-surface-1 px-3 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
          <p className="mt-1 text-[11px] text-muted">
            Full image URL (aim for 1920x640 or larger, jpg/png). Paste
            from your own hosting. Dedicated uploader lands in a later
            release. Leave blank for a muted fill.
          </p>
        </div>
      </section>

      <section className="space-y-4 rounded-lg border border-border bg-surface-1 p-5">
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={showPublicItems}
            onChange={(e) => setShowPublicItems(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-border text-accent focus:ring-accent/30"
          />
          <span>
            <span className="font-medium text-ink-0">
              Show public items on the landing page
            </span>
            <span className="mt-0.5 block text-[11px] text-muted">
              When off, the landing page shows only the title, optional
              hero, and a Sign-in button. Pick this for a clean logo-only
              page if you don&apos;t want the public browse grid.
            </span>
          </span>
        </label>

        <div>
          <label
            htmlFor="featured-ids"
            className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted"
          >
            Featured item ids (advanced)
          </label>
          <textarea
            id="featured-ids"
            value={featuredIdsText}
            onChange={(e) => setFeaturedIdsText(e.target.value)}
            placeholder="Comma or newline separated item UUIDs"
            rows={3}
            className="w-full rounded-md border border-border bg-surface-1 px-3 py-2 font-mono text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
          <p className="mt-1 text-[11px] text-muted">
            Ordered list of item ids to feature at the top of the grid.
            Leave blank to show all public items newest-first. Ids must
            belong to public items in your org. A proper in-app item
            picker lands in a follow-up; for now, copy ids from the URL
            of the item detail page.
          </p>
        </div>
      </section>

      {error ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="flex items-center justify-between">
        <a
          href="/"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink-1"
        >
          <ExternalLink className="h-3 w-3" />
          Open landing page in a new tab
        </a>
        <div className="flex items-center gap-2">
          {saved ? (
            <span className="inline-flex items-center gap-1 text-xs text-success">
              <Check className="h-3.5 w-3.5" /> Saved
            </span>
          ) : null}
          <button
            type="button"
            onClick={save}
            disabled={saving || !dirty}
            className="inline-flex h-10 items-center gap-1.5 rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseIds(text: string): string[] {
  return text
    .split(/[,\n\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
