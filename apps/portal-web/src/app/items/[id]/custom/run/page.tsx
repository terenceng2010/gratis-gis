import { notFound } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  BarChart3,
  Hammer,
  Image as ImageIcon,
  Layers as LayersIcon,
  ListTree,
  Map as MapIcon,
  MousePointer2,
  Printer,
  Search,
  Sparkles,
  Square,
  Table2,
  Type as TypeIcon,
} from 'lucide-react';
import type {
  CustomAppData,
  CustomWidget,
  CustomWidgetKind,
  Item,
} from '@gratis-gis/shared-types';
import {
  DEFAULT_CUSTOM_APP,
  isCustomAppItem,
  readCustomAppData,
} from '@gratis-gis/shared-types';
import { apiFetch } from '@/lib/api';

interface Props {
  params: { id: string };
}

const ROW_HEIGHT_PX = 48;

/**
 * Custom Web App runtime (#261). Slice 5 (#341) replaces the
 * placeholder cards below with real widget renderers (Map = real
 * MapLibre, LayerList = wired to the bound map, etc.). Until that
 * lands, this page already renders the designed page's layout
 * faithfully -- same 12-column grid, same widget cards in their
 * configured positions -- so the author can verify the layout
 * end-to-end without waiting on the renderer.
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
  const page = app.pages[0]!;
  const totalWidgets = app.pages.reduce((n, p) => n + p.widgets.length, 0);
  const usedRows = page.widgets.reduce(
    (n, w) => Math.max(n, w.layout.row + w.layout.rowSpan - 1),
    0,
  );
  const totalRows = Math.max(8, usedRows + 2);

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
        <div className="inline-flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800">
            <Hammer className="h-3 w-3" />
            Layout preview
          </span>
          <Link
            href={`/items/${item.id}`}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-1 px-2 py-1 text-xs font-medium text-ink-1 hover:bg-surface-2"
          >
            Configure
          </Link>
        </div>
      </header>

      <div className="flex-1 overflow-auto bg-surface-0 p-4">
        {totalWidgets === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="max-w-md rounded-lg border border-dashed border-border bg-surface-1 p-8 text-center shadow-card">
              <Hammer className="mx-auto h-8 w-8 text-amber-500" />
              <h2 className="mt-3 text-base font-semibold text-ink-0">
                Empty app
              </h2>
              <p className="mt-2 text-sm text-muted">
                Head back to{' '}
                <Link
                  href={`/items/${item.id}`}
                  className="text-accent hover:underline"
                >
                  the configuration page
                </Link>{' '}
                to drag a widget onto the canvas.
              </p>
            </div>
          </div>
        ) : (
          <div
            className="grid w-full"
            style={{
              gridTemplateColumns: 'repeat(12, minmax(0, 1fr))',
              gridAutoRows: `${ROW_HEIGHT_PX}px`,
              minHeight: `${totalRows * ROW_HEIGHT_PX}px`,
              gap: '8px',
            }}
          >
            {page.widgets.map((w) => (
              <RenderedWidget key={w.id} widget={w} />
            ))}
          </div>
        )}
      </div>

      {totalWidgets > 0 && (
        <footer className="shrink-0 border-t border-border bg-surface-1 px-4 py-2 text-[11px] text-muted">
          Placeholder render. Real Map / Layer-List / Attribute-Table /
          Search / Print / Select / Basemap-Gallery wired to bound data
          ships in #341.
        </footer>
      )}
    </div>
  );
}

const KIND_LABEL: Record<CustomWidgetKind, string> = {
  map: 'Map',
  legend: 'Legend',
  'layer-list': 'Layers',
  'attribute-table': 'Attribute Table',
  text: 'Text',
  chart: 'Chart',
  search: 'Search',
  print: 'Print',
  select: 'Select',
  'basemap-gallery': 'Basemaps',
};

function iconFor(kind: CustomWidgetKind) {
  switch (kind) {
    case 'map':
      return MapIcon;
    case 'legend':
      return ListTree;
    case 'layer-list':
      return LayersIcon;
    case 'attribute-table':
      return Table2;
    case 'text':
      return TypeIcon;
    case 'chart':
      return BarChart3;
    case 'search':
      return Search;
    case 'print':
      return Printer;
    case 'select':
      return MousePointer2;
    case 'basemap-gallery':
      return ImageIcon;
    default:
      return Square;
  }
}

function RenderedWidget({ widget }: { widget: CustomWidget }) {
  const Icon = iconFor(widget.kind);
  const label = KIND_LABEL[widget.kind] ?? widget.kind;
  return (
    <section
      style={{
        gridColumn: `${widget.layout.col} / span ${widget.layout.colSpan}`,
        gridRow: `${widget.layout.row} / span ${widget.layout.rowSpan}`,
      }}
      className="flex h-full w-full flex-col overflow-hidden rounded-md border border-border bg-surface-1 shadow-card"
    >
      <header className="flex shrink-0 items-center gap-1.5 border-b border-border bg-surface-2/40 px-2 py-1 text-[11px]">
        <Icon className="h-3.5 w-3.5 text-accent" />
        <span className="font-semibold text-ink-0">{label}</span>
      </header>
      <div className="flex flex-1 items-center justify-center p-3 text-xs italic text-muted">
        {widget.kind === 'text' && widget.config.kind === 'text' ? (
          <span className="not-italic text-ink-1">
            {widget.config.markdown}
          </span>
        ) : (
          <span>Renderer ships in #341</span>
        )}
      </div>
    </section>
  );
}

export const dynamic = 'force-dynamic';
