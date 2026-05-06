import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Hammer, Sparkles } from 'lucide-react';
import type { CustomAppData, Item } from '@gratis-gis/shared-types';
import {
  DEFAULT_CUSTOM_APP,
  isCustomAppItem,
  readCustomAppData,
} from '@gratis-gis/shared-types';
import { apiFetch } from '@/lib/api';

interface Props {
  params: { id: string };
}

/**
 * Custom Web App runtime (#261) - placeholder slice.
 *
 * The full runtime (CSS-grid layout engine + per-widget renderers)
 * lands in a follow-up. This page renders enough today to:
 *
 *   - prove the route resolves and the type guards work
 *   - tell an opener what's coming
 *   - give the author a quick affordance back to the configuration
 *     page so they can wire targets / pages / widgets
 *
 * Rendering "for real" reuses MapCanvas + LayerPanel + AttributeTable
 * primitives the Editor / Viewer runtimes already share, plus a thin
 * Page renderer that walks the widgets list and stamps each into a
 * grid-area-positioned cell.
 */
export default async function CustomAppRuntimePage({ params }: Props) {
  let item: Item<unknown>;
  try {
    item = await apiFetch<Item<unknown>>(`/api/items/${params.id}`);
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) notFound();
    throw err;
  }
  if (!isCustomAppItem(item)) notFound();

  const app: CustomAppData = {
    ...DEFAULT_CUSTOM_APP,
    ...((readCustomAppData(item) ?? {}) as Partial<CustomAppData>),
  };
  const totalWidgets = app.pages.reduce((n, p) => n + p.widgets.length, 0);

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
            <Sparkles className="h-4 w-4 text-amber-500" />
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
          <Hammer className="mx-auto h-8 w-8 text-amber-500" />
          <h2 className="mt-3 text-base font-semibold text-ink-0">
            Custom designer coming soon
          </h2>
          <p className="mt-2 text-sm text-muted">
            This app has {app.pages.length} page
            {app.pages.length === 1 ? '' : 's'} and {totalWidgets} widget
            {totalWidgets === 1 ? '' : 's'} configured. The grid runtime that
            renders them is on the way; until then, head back to{' '}
            <Link
              href={`/items/${item.id}`}
              className="text-accent hover:underline"
            >
              the configuration page
            </Link>{' '}
            to keep building out targets, pages, and widgets.
          </p>
        </div>
      </div>
    </div>
  );
}

export const dynamic = 'force-dynamic';
