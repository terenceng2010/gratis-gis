import Link from 'next/link';
import { Trash2 } from 'lucide-react';
import type { Group, Item } from '@gratis-gis/shared-types';
import { apiFetch } from '@/lib/api';
import { EmptyState } from '@/components/empty-state';
import { ItemRow } from './item-row';
import { GroupRow } from './group-row';

// Retention window shown in the UI. The backend auto-purge job reads
// the same value from RECYCLE_BIN_RETENTION_DAYS; we default to 30 here
// to match docs/soft-delete.md. When the endpoint that exposes this
// setting lands we should read it from the server instead of hard-coding.
const RETENTION_DAYS = 30;

// Explicit kind union. Future kinds (users, reports) slot in here.
type Kind = 'items' | 'groups';
const KINDS: { value: Kind; label: string }[] = [
  { value: 'items', label: 'Items' },
  { value: 'groups', label: 'Groups' },
];

interface Props {
  searchParams: { kind?: string };
}

export const metadata = { title: 'Recently deleted' };

export default async function RecentlyDeletedPage({ searchParams }: Props) {
  // Normalize the query param to a known kind; unknown values fall back
  // to items so a stale bookmark never 500s.
  const kind: Kind =
    searchParams.kind === 'groups' ? 'groups' : 'items';

  // Fetch only the kind the user is looking at. Keeps latency predictable
  // and avoids fetching content the user might not have permission to see
  // (trash is scoped per-kind on the backend).
  const [items, groups] =
    kind === 'items'
      ? [await apiFetch<Item[]>('/api/items/trash'), [] as Group[]]
      : [[] as Item[], await apiFetch<Group[]>('/api/groups/trash')];

  const activeList = kind === 'items' ? items : groups;

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <header className="mb-6">
        <p className="text-sm text-muted">Safety net</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Recently deleted
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Content you delete lives here for {RETENTION_DAYS} days so you can
          bring it back if you change your mind. After that it is
          permanently removed.
        </p>
      </header>

      <nav
        aria-label="Recently deleted categories"
        className="mb-6 flex gap-1 border-b border-border"
      >
        {KINDS.map((k) => {
          const active = k.value === kind;
          return (
            <Link
              key={k.value}
              href={`/recently-deleted?kind=${k.value}`}
              aria-current={active ? 'page' : undefined}
              className={
                active
                  ? 'relative -mb-px border-b-2 border-accent px-3 py-2 text-sm font-medium text-ink-0'
                  : 'border-b-2 border-transparent px-3 py-2 text-sm text-muted hover:text-ink-1'
              }
            >
              {k.label}
            </Link>
          );
        })}
      </nav>

      {activeList.length === 0 ? (
        <EmptyState
          icon={<Trash2 className="h-5 w-5" />}
          title={
            kind === 'items'
              ? 'No items to recover'
              : 'No groups to recover'
          }
          description={`Deleted ${kind} will appear here for ${RETENTION_DAYS} days before permanent removal.`}
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-surface-1 shadow-card">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-surface-2 text-xs uppercase tracking-wide text-muted">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  {kind === 'items' ? 'Item' : 'Group'}
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Deleted
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Auto-purge
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="[&>tr>td]:px-4">
              {kind === 'items'
                ? items.map((item) => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      retentionDays={RETENTION_DAYS}
                    />
                  ))
                : groups.map((group) => (
                    <GroupRow
                      key={group.id}
                      group={group}
                      retentionDays={RETENTION_DAYS}
                    />
                  ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
