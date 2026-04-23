import Link from 'next/link';
import { createElement } from 'react';
import { Plus, Layers } from 'lucide-react';
import { ItemCard } from '@gratis-gis/ui';
import type { ItemWithShares } from '@gratis-gis/shared-types';
import { apiFetch } from '@/lib/api';
import { EmptyState } from '@/components/empty-state';
import { getItemTypeIcon } from '@/lib/item-type-icon';
import { ItemSharingIndicator } from '@/components/item-sharing-indicator';

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
  // Fetch the viewer once so the sharing popover can gate on canManage
  // (owner or org admin) without re-fetching per card.
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
          {items.map((item) => {
            const canManage =
              me.id === item.ownerId || me.orgRole === 'admin';
            return (
              <ItemCard
                key={item.id}
                item={item}
                href={`/items/${item.id}`}
                // Per-type lucide icon on a type-colored tile when there's
                // no custom thumbnail. createElement keeps this a server
                // component friendly render path.
                fallbackIcon={createElement(getItemTypeIcon(item.type))}
                // Sharing indicator chip sits next to the type badge;
                // stopParentLink prevents the card's <a> from navigating
                // when the chip/popover is clicked.
                headerExtra={createElement(ItemSharingIndicator, {
                  itemId: item.id,
                  itemTitle: item.title,
                  access: item.access,
                  shares: item.shares,
                  canManage,
                  currentUserId: me.id,
                  stopParentLink: true,
                })}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
