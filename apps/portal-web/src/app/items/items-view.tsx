'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ChevronRight,
  Grid3x3,
  List as ListIcon,
  X,
} from 'lucide-react';
import { ItemCard } from '@gratis-gis/ui';
import type { ItemType, ItemWithShares } from '@gratis-gis/shared-types';
import {
  getItemTypeAccent,
  getItemTypeIcon,
} from '@/lib/item-type-icon';
import { ItemSharingIndicator } from '@/components/item-sharing-indicator';

/**
 * Client-side wrapper around the items list. Owns three bits of UI
 * state that don't warrant a round-trip to the server:
 *
 *   - view mode (card vs list) — persists via localStorage so the
 *     user's preference sticks between visits
 *   - type filters — one or more item types can be toggled on; empty
 *     means "show all"
 *   - group-by — 'none' (flat list), 'type', 'access'. Owner grouping
 *     is an obvious future addition but needs a user/name lookup we
 *     don't carry on the list response today.
 *
 * The server hands us the full item list (with shares joined) so all
 * filtering and grouping is in-memory; that's fine for org-sized
 * lists (up to a few thousand items). If it stops being fine we can
 * push filters back to the API without changing this component's
 * public shape.
 */
interface Props {
  items: ItemWithShares[];
  currentUser: { id: string; orgRole: string };
}

type ViewMode = 'card' | 'list';
type GroupBy = 'none' | 'type' | 'access';
type SortBy =
  | 'updated-desc'
  | 'updated-asc'
  | 'created-desc'
  | 'created-asc'
  | 'title-asc'
  | 'title-desc';

const VIEW_MODE_KEY = 'gg.items.view';
const GROUP_BY_KEY = 'gg.items.groupBy';
const SORT_BY_KEY = 'gg.items.sortBy';

const SORT_LABELS: Record<SortBy, string> = {
  'updated-desc': 'Recently updated',
  'updated-asc': 'Least recently updated',
  'created-desc': 'Newest first',
  'created-asc': 'Oldest first',
  'title-asc': 'Name (A–Z)',
  'title-desc': 'Name (Z–A)',
};

const TYPE_LABELS: Record<ItemType, string> = {
  web_map: 'Web map',
  feature_service: 'Feature service',
  arcgis_service: 'ArcGIS service',
  form: 'Form',
  form_submission_collection: 'Form submissions',
  web_app: 'Web app',
  report_template: 'Report template',
  dashboard: 'Dashboard',
  file: 'File',
  layer_package: 'Layer package',
  notebook: 'Notebook',
  tool: 'Tool',
  widget_package: 'Widget package',
};

const ACCESS_LABELS: Record<string, string> = {
  private: 'Private',
  org: 'Organization',
  public: 'Public',
};

export function ItemsView({ items, currentUser }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>('card');
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [sortBy, setSortBy] = useState<SortBy>('updated-desc');
  const [typeFilter, setTypeFilter] = useState<Set<ItemType>>(new Set());

  // Rehydrate persisted preferences on mount. Running this lazily
  // (not as a useState initializer) keeps the component SSR-safe —
  // the first render always matches the server's ("card", "none").
  useEffect(() => {
    try {
      const vm = localStorage.getItem(VIEW_MODE_KEY);
      if (vm === 'card' || vm === 'list') setViewMode(vm);
      const gb = localStorage.getItem(GROUP_BY_KEY);
      if (gb === 'none' || gb === 'type' || gb === 'access') setGroupBy(gb);
      const sb = localStorage.getItem(SORT_BY_KEY);
      if (sb && sb in SORT_LABELS) setSortBy(sb as SortBy);
    } catch {
      /* no localStorage, fall through to defaults */
    }
  }, []);

  function persistView(next: ViewMode) {
    setViewMode(next);
    try {
      localStorage.setItem(VIEW_MODE_KEY, next);
    } catch {
      /* non-fatal */
    }
  }
  function persistGroup(next: GroupBy) {
    setGroupBy(next);
    try {
      localStorage.setItem(GROUP_BY_KEY, next);
    } catch {
      /* non-fatal */
    }
  }
  function persistSort(next: SortBy) {
    setSortBy(next);
    try {
      localStorage.setItem(SORT_BY_KEY, next);
    } catch {
      /* non-fatal */
    }
  }

  // Present-in-data type counts, sorted by descending count so the
  // most common types sit at the front of the filter bar.
  const typeCounts = useMemo(() => {
    const counts = new Map<ItemType, number>();
    for (const it of items) counts.set(it.type, (counts.get(it.type) ?? 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [items]);

  const filteredItems = useMemo(() => {
    const pool =
      typeFilter.size === 0
        ? items
        : items.filter((it) => typeFilter.has(it.type));
    // Sort on every filter/sort change. copyWithin keeps the original
    // array intact (it's the server prop).
    const sorted = [...pool];
    sorted.sort((a, b) => compareItems(a, b, sortBy));
    return sorted;
  }, [items, typeFilter, sortBy]);

  function toggleType(t: ItemType) {
    setTypeFilter((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  function clearFilters() {
    setTypeFilter(new Set());
  }

  return (
    <div>
      <Toolbar
        viewMode={viewMode}
        onViewMode={persistView}
        groupBy={groupBy}
        onGroupBy={persistGroup}
        sortBy={sortBy}
        onSortBy={persistSort}
        typeFilter={typeFilter}
        typeCounts={typeCounts}
        onToggleType={toggleType}
        onClearFilters={clearFilters}
        totalCount={items.length}
        filteredCount={filteredItems.length}
      />
      <ItemsBody
        items={filteredItems}
        viewMode={viewMode}
        groupBy={groupBy}
        currentUser={currentUser}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Comparator shared by every sort mode. Tie-break on id so the ordering
 * is deterministic when two items have the same sort key.
 */
function compareItems(
  a: ItemWithShares,
  b: ItemWithShares,
  mode: SortBy,
): number {
  switch (mode) {
    case 'title-asc':
      return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
    case 'title-desc':
      return b.title.localeCompare(a.title) || a.id.localeCompare(b.id);
    case 'created-desc':
      return (
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() ||
        a.id.localeCompare(b.id)
      );
    case 'created-asc':
      return (
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
        a.id.localeCompare(b.id)
      );
    case 'updated-asc':
      return (
        new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime() ||
        a.id.localeCompare(b.id)
      );
    case 'updated-desc':
    default:
      return (
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime() ||
        a.id.localeCompare(b.id)
      );
  }
}

interface ToolbarProps {
  viewMode: ViewMode;
  onViewMode: (next: ViewMode) => void;
  groupBy: GroupBy;
  onGroupBy: (next: GroupBy) => void;
  sortBy: SortBy;
  onSortBy: (next: SortBy) => void;
  typeFilter: Set<ItemType>;
  typeCounts: Array<[ItemType, number]>;
  onToggleType: (t: ItemType) => void;
  onClearFilters: () => void;
  totalCount: number;
  filteredCount: number;
}

function Toolbar({
  viewMode,
  onViewMode,
  groupBy,
  onGroupBy,
  sortBy,
  onSortBy,
  typeFilter,
  typeCounts,
  onToggleType,
  onClearFilters,
  totalCount,
  filteredCount,
}: ToolbarProps) {
  return (
    <div className="mb-4 space-y-3">
      {/* Top row: view-mode toggle + group-by + showing-N summary */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex overflow-hidden rounded-md border border-border bg-surface-1">
          <button
            type="button"
            onClick={() => onViewMode('card')}
            aria-pressed={viewMode === 'card'}
            className={`inline-flex h-8 items-center gap-1 px-2 text-xs ${
              viewMode === 'card'
                ? 'bg-accent/10 text-accent'
                : 'text-muted hover:bg-surface-2 hover:text-ink-1'
            }`}
            title="Card view"
          >
            <Grid3x3 className="h-3.5 w-3.5" />
            Cards
          </button>
          <button
            type="button"
            onClick={() => onViewMode('list')}
            aria-pressed={viewMode === 'list'}
            className={`inline-flex h-8 items-center gap-1 border-l border-border px-2 text-xs ${
              viewMode === 'list'
                ? 'bg-accent/10 text-accent'
                : 'text-muted hover:bg-surface-2 hover:text-ink-1'
            }`}
            title="List view"
          >
            <ListIcon className="h-3.5 w-3.5" />
            List
          </button>
        </div>

        <label className="inline-flex items-center gap-1.5 text-xs text-muted">
          Group by
          <select
            value={groupBy}
            onChange={(e) => onGroupBy(e.target.value as GroupBy)}
            className="h-8 rounded-md border border-border bg-surface-1 px-2 text-xs text-ink-1 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
          >
            <option value="none">None</option>
            <option value="type">Type</option>
            <option value="access">Access</option>
          </select>
        </label>

        <label className="inline-flex items-center gap-1.5 text-xs text-muted">
          Sort
          <select
            value={sortBy}
            onChange={(e) => onSortBy(e.target.value as SortBy)}
            className="h-8 rounded-md border border-border bg-surface-1 px-2 text-xs text-ink-1 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
          >
            {(Object.entries(SORT_LABELS) as Array<[SortBy, string]>).map(
              ([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ),
            )}
          </select>
        </label>

        <p className="ml-auto text-xs text-muted">
          {filteredCount === totalCount
            ? `${totalCount} item${totalCount === 1 ? '' : 's'}`
            : `${filteredCount} of ${totalCount}`}
        </p>
      </div>

      {/* Filter chips. Only surface types that are actually present
          in the data so a fresh org doesn't see 13 greyed-out chips. */}
      {typeCounts.length > 1 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted">
            Filter
          </span>
          {typeCounts.map(([t, count]) => {
            const active = typeFilter.has(t);
            const Icon = getItemTypeIcon(t);
            const accent = getItemTypeAccent(t);
            return (
              <button
                key={t}
                type="button"
                onClick={() => onToggleType(t)}
                aria-pressed={active}
                className={`inline-flex h-7 items-center gap-1 rounded-full border px-2 text-[11px] transition-colors ${
                  active
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-border bg-surface-1 text-ink-1 hover:bg-surface-2'
                }`}
              >
                <Icon className={`h-3 w-3 ${active ? '' : accent}`} />
                {TYPE_LABELS[t] ?? t}
                <span className="text-muted">({count})</span>
              </button>
            );
          })}
          {typeFilter.size > 0 ? (
            <button
              type="button"
              onClick={onClearFilters}
              className="inline-flex h-7 items-center gap-1 rounded-full border border-transparent px-2 text-[11px] text-muted hover:bg-surface-2 hover:text-ink-1"
            >
              <X className="h-3 w-3" />
              Clear
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface BodyProps {
  items: ItemWithShares[];
  viewMode: ViewMode;
  groupBy: GroupBy;
  currentUser: { id: string; orgRole: string };
}

function ItemsBody({ items, viewMode, groupBy, currentUser }: BodyProps) {
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-surface-1 px-6 py-10 text-center text-sm text-muted">
        No items match your filters.
      </div>
    );
  }

  if (groupBy === 'none') {
    return (
      <ItemGrid
        items={items}
        viewMode={viewMode}
        currentUser={currentUser}
      />
    );
  }

  // Group and render a section per bucket. Buckets are ordered by
  // size descending so the user's most-common bucket leads.
  const buckets = new Map<string, ItemWithShares[]>();
  for (const it of items) {
    const key = groupBy === 'type' ? it.type : it.access;
    const arr = buckets.get(key) ?? [];
    arr.push(it);
    buckets.set(key, arr);
  }
  const ordered = Array.from(buckets.entries()).sort(
    (a, b) => b[1].length - a[1].length,
  );

  return (
    <div className="space-y-6">
      {ordered.map(([key, group]) => {
        const label =
          groupBy === 'type'
            ? (TYPE_LABELS[key as ItemType] ?? key)
            : (ACCESS_LABELS[key] ?? key);
        return (
          <section key={key}>
            <h2 className="mb-2 flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted">
              {label}
              <span className="text-muted">({group.length})</span>
            </h2>
            <ItemGrid
              items={group}
              viewMode={viewMode}
              currentUser={currentUser}
            />
          </section>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface GridProps {
  items: ItemWithShares[];
  viewMode: ViewMode;
  currentUser: { id: string; orgRole: string };
}

function ItemGrid({ items, viewMode, currentUser }: GridProps) {
  if (viewMode === 'card') {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => {
          const canManage =
            currentUser.id === item.ownerId || currentUser.orgRole === 'admin';
          const Icon = getItemTypeIcon(item.type);
          return (
            <ItemCard
              key={item.id}
              item={item}
              href={`/items/${item.id}`}
              fallbackIcon={<Icon />}
              headerExtra={
                <ItemSharingIndicator
                  itemId={item.id}
                  itemTitle={item.title}
                  access={item.access}
                  shares={item.shares}
                  canManage={canManage}
                  currentUserId={currentUser.id}
                  stopParentLink
                />
              }
            />
          );
        })}
      </div>
    );
  }

  // List view: compact rows in a CSS grid so every column (icon,
  // title/desc, type, updated-at, sharing, chevron) aligns vertically
  // across rows. Previously each row was flexbox with ad-hoc widths,
  // which made dates and sharing chips wander across rows.
  //
  // overflow-visible on the <ul> so the sharing popover can escape the
  // card (the list's rounded-lg corners are kept crisp by clipping
  // only the top and bottom rows individually).
  return (
    <ul className="divide-y divide-border rounded-lg border border-border bg-surface-1">
      {/* Header row: surfaces the columns so the list reads like a
          table, which matters once there are many rows. */}
      <li className="hidden grid-cols-[auto_minmax(0,1fr)_8rem_7rem_9rem_auto] items-center gap-3 border-b border-border bg-surface-2 px-4 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted sm:grid">
        <span />
        <span>Title</span>
        <span>Type</span>
        <span>Updated</span>
        <span>Sharing</span>
        <span />
      </li>
      {items.map((item) => {
        const canManage =
          currentUser.id === item.ownerId || currentUser.orgRole === 'admin';
        const Icon = getItemTypeIcon(item.type);
        const accent = getItemTypeAccent(item.type);
        return (
          <li key={item.id} className="group">
            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 hover:bg-surface-2 sm:grid-cols-[auto_minmax(0,1fr)_8rem_7rem_9rem_auto]">
              <Link
                href={`/items/${item.id}`}
                className="contents"
                aria-label={item.title}
              >
                <Icon className={`h-4 w-4 shrink-0 ${accent}`} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink-0">
                    {item.title}
                  </p>
                  {item.description ? (
                    <p className="truncate text-xs text-muted">
                      {item.description}
                    </p>
                  ) : null}
                </div>
                <p className="hidden truncate text-[11px] text-muted sm:block">
                  {TYPE_LABELS[item.type] ?? item.type}
                </p>
                <p className="hidden text-[11px] text-muted sm:block">
                  {new Date(item.updatedAt).toLocaleDateString()}
                </p>
              </Link>
              {/* Sharing + chevron sit outside the Link so their click
                  handlers don't propagate a navigation. */}
              <div className="hidden sm:block">
                <ItemSharingIndicator
                  itemId={item.id}
                  itemTitle={item.title}
                  access={item.access}
                  shares={item.shares}
                  canManage={canManage}
                  currentUserId={currentUser.id}
                  stopParentLink
                />
              </div>
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100" />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
