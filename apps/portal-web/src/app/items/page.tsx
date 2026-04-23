import Link from 'next/link';
import { Plus, Layers } from 'lucide-react';
import type { ItemWithShares } from '@gratis-gis/shared-types';
import { apiFetch } from '@/lib/api';
import { EmptyState } from '@/components/empty-state';
import { ItemsView } from './items-view';

interface Props {
  searchParams: { mine?: string; q?: string };
}

export default async function ItemsPage({ searchParams }: Props) {
  const qs = new URLSearchParams();
  if (searchParams.mine === 'true') qs.set('mine', 'true');
  if (searchParams.q) qs.set('q', searchParams.q);

  // Items come back with their shares joined so the sharing indicator
  // on each card has the data it needs without a second round-trip.
  const items = await apiFetch<ItemWithShares[]>(
    `/api/items${qs.toString() ? `?${qs}` : ''}`,
  );
  // Viewer is fetched once; all per-card canManage checks run off it.
  const me = await apiFetch<{ id: string; orgRole: string }>(
    '/api/users/me',
  );
  const isMine = searchParams.mine === 'true';

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <header className="mb-6 flex items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted">Content</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {isMine ? 'My items' : 'All items'}
          </h1>
        </div>

        <Link
          href="/items/new"
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          New item
        </Link>
      </header>

      {items.length === 0 ? (
        <EmptyState
          icon={<Layers className="h-5 w-5" />}
          title={isMine ? 'No items yet' : 'Nothing shared with you yet'}
          description={
            isMine
              ? 'Create your first web map, form, or feature service to get started.'
              : 'When a teammate shares content with you or your group, it will show up here.'
          }
          action={
            isMine ? (
              <Link
                href="/items/new"
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90"
              >
                <Plus className="h-4 w-4" />
                Create an item
              </Link>
            ) : null
          }
        />
      ) : (
        <ItemsView items={items} currentUser={me} />
      )}
    </div>
  );
}
