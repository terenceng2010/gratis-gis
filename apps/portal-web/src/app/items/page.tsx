import Link from 'next/link';
import { Plus, Layers } from 'lucide-react';
import { ItemCard } from '@gratis-gis/ui';
import type { Item } from '@gratis-gis/shared-types';
import { apiFetch } from '@/lib/api';
import { EmptyState } from '@/components/empty-state';

interface Props {
  searchParams: { mine?: string; q?: string };
}

export default async function ItemsPage({ searchParams }: Props) {
  const qs = new URLSearchParams();
  if (searchParams.mine === 'true') qs.set('mine', 'true');
  if (searchParams.q) qs.set('q', searchParams.q);

  const items = await apiFetch<Item[]>(`/api/items${qs.toString() ? `?${qs}` : ''}`);
  const isMine = searchParams.mine === 'true';

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <header className="mb-6 flex items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted">Content</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {isMine ? 'My items' : 'All items'}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {items.length} item{items.length === 1 ? '' : 's'}
          </p>
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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <ItemCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
