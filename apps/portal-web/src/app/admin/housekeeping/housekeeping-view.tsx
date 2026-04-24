'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  ChevronRight,
  Clock,
  Database,
  Loader2,
  Trash2,
  User as UserIcon,
  UserX,
  Users,
  X,
} from 'lucide-react';
import type { ItemType } from '@gratis-gis/shared-types';
import { getItemTypeAccent, getItemTypeIcon } from '@/lib/item-type-icon';

/**
 * Wire shapes returned by /admin/housekeeping endpoints. Kept
 * local to this file so the server page and the client view stay
 * in lock-step without a third file to sync.
 */
export interface HousekeepingBundle {
  summary: {
    staleItemDays: number;
    staleUserDays: number;
    staleItemCount: number;
    staleUserCount: number;
    totalItemCount: number;
    totalUserCount: number;
  };
  staleItems: Array<{
    id: string;
    title: string;
    type: ItemType;
    access: string;
    updatedAt: string;
    ownerId: string;
    ownerLabel: string;
  }>;
  staleUsers: Array<{
    id: string;
    username: string;
    fullName: string;
    email: string;
    orgRole: string;
    createdAt: string;
    lastSeenAt: string | null;
    ownedItemCount: number;
  }>;
  largeItems: Array<{
    id: string;
    title: string;
    type: string;
    ownerId: string;
    ownerLabel: string;
    sizeBytes: number;
    updatedAt: string;
  }>;
}

interface Props {
  bundle: HousekeepingBundle;
}

export function HousekeepingView({ bundle }: Props) {
  const router = useRouter();
  const { summary, staleItems, staleUsers, largeItems } = bundle;

  // One selection set per table — items and users live in different
  // domains so mixing them would make the bulk-action copy
  // ambiguous. Each set is the id of a ticked row.
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'items' | 'users' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  // Users with owned items are opt-out on the bulk-disable action:
  // disabling their Keycloak login while they still own items would
  // orphan those items and surface "can't edit" errors for anyone
  // trying to interact with them. Admin has to reassign first.
  const disableableUserIds = new Set(
    staleUsers.filter((u) => u.ownedItemCount === 0).map((u) => u.id),
  );

  async function bulkTrashItems() {
    if (selectedItems.size === 0) return;
    setBusy('items');
    setError(null);
    try {
      // One DELETE per item. The /items/:id endpoint soft-deletes
      // into the recycle bin; there's no bulk endpoint today, and
      // this runs on at most ~20 rows per page so the N-round-trips
      // cost is fine. Concurrency set to 4 to keep the UI responsive
      // without hammering the API.
      const ids = Array.from(selectedItems);
      await runBatched(ids, 4, async (id) => {
        const res = await fetch(`/api/portal/items/${id}`, {
          method: 'DELETE',
        });
        if (!res.ok) throw new Error(`Item ${id.slice(0, 8)}: HTTP ${res.status}`);
      });
      setSelectedItems(new Set());
      setFlash(`Moved ${ids.length} item${ids.length === 1 ? '' : 's'} to the recycle bin.`);
      setTimeout(() => setFlash(null), 4000);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not move items to trash.');
    } finally {
      setBusy(null);
    }
  }

  async function bulkDisableUsers() {
    // Intersect the selection with disableable (0-owned-items) users
    // as a belt-and-braces safety — the UI shouldn't let the other
    // kind into the set but we also don't want to PATCH a user whose
    // items would then be orphaned.
    const ids = Array.from(selectedUsers).filter((id) =>
      disableableUserIds.has(id),
    );
    if (ids.length === 0) return;
    setBusy('users');
    setError(null);
    try {
      await runBatched(ids, 4, async (id) => {
        const res = await fetch(`/api/portal/admin/users/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: false }),
        });
        if (!res.ok) throw new Error(`User ${id.slice(0, 8)}: HTTP ${res.status}`);
      });
      setSelectedUsers(new Set());
      setFlash(
        `Disabled sign-in for ${ids.length} user${ids.length === 1 ? '' : 's'}.`,
      );
      setTimeout(() => setFlash(null), 4000);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not disable users.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <SummaryBar summary={summary} />

      {flash ? (
        <div className="rounded-md border border-emerald-400 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
          <CheckCircle2 className="mr-1 inline h-3.5 w-3.5" />
          {flash}
        </div>
      ) : null}
      {error ? (
        <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
          <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
          {error}
        </div>
      ) : null}

      <Section
        icon={<Clock className="h-4 w-4" />}
        title={`Items nobody's touched for ${summary.staleItemDays}+ days`}
        empty="No stale items — every item in your org has been updated recently or is still being shared."
        caption={
          <>
            {staleItems.length === 0
              ? null
              : `Showing the ${staleItems.length} oldest untouched items with zero shares. `}
            Tick the ones you want to retire and use "Move to trash"
            below. Items go to the recycle bin first (30 day
            retention), so a mistake is easy to undo.
          </>
        }
        bulkBar={
          selectedItems.size > 0 ? (
            <BulkBar
              count={selectedItems.size}
              label="item"
              busy={busy === 'items'}
              onClear={() => setSelectedItems(new Set())}
              actions={[
                {
                  label: 'Move to trash',
                  icon: <Trash2 className="h-3.5 w-3.5" />,
                  tone: 'danger',
                  onClick: bulkTrashItems,
                },
              ]}
            />
          ) : null
        }
      >
        {staleItems.length === 0 ? null : (
          <StaleItemsTable
            rows={staleItems}
            selected={selectedItems}
            onToggle={(id) => {
              setSelectedItems((s) => {
                const next = new Set(s);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              });
            }}
            onToggleAll={() => {
              setSelectedItems((s) => {
                const all = staleItems.every((r) => s.has(r.id));
                return all ? new Set() : new Set(staleItems.map((r) => r.id));
              });
            }}
          />
        )}
      </Section>

      <Section
        icon={<Users className="h-4 w-4" />}
        title={`Users quiet for ${summary.staleUserDays}+ days`}
        empty="Nobody looks idle. Admins are deliberately excluded from this check so a break-glass account never shows up."
        caption="Admins are excluded. Users with owned items can't be ticked for bulk disable — reassign their items first (from /admin/users or the item detail page), then they'll be selectable here."
        bulkBar={
          selectedUsers.size > 0 ? (
            <BulkBar
              count={selectedUsers.size}
              label="user"
              busy={busy === 'users'}
              onClear={() => setSelectedUsers(new Set())}
              actions={[
                {
                  label: 'Disable sign-in',
                  icon: <UserX className="h-3.5 w-3.5" />,
                  tone: 'warn',
                  onClick: bulkDisableUsers,
                },
              ]}
            />
          ) : null
        }
      >
        {staleUsers.length === 0 ? null : (
          <StaleUsersTable
            rows={staleUsers}
            selected={selectedUsers}
            disableableIds={disableableUserIds}
            onToggle={(id) => {
              if (!disableableUserIds.has(id)) return;
              setSelectedUsers((s) => {
                const next = new Set(s);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              });
            }}
            onToggleAll={() => {
              setSelectedUsers((s) => {
                const eligible = staleUsers
                  .filter((u) => disableableUserIds.has(u.id))
                  .map((u) => u.id);
                const all = eligible.every((id) => s.has(id));
                return all ? new Set() : new Set(eligible);
              });
            }}
          />
        )}
      </Section>

      <Section
        icon={<Database className="h-4 w-4" />}
        title="Largest items by stored size"
        empty="No items yet."
        caption="Bytes of the serialised item.data blob. A proxy, not exact — feature-service rows in PostGIS and MinIO attachments are separate. Rough signal for 'which item is heaviest in the DB.'"
      >
        {largeItems.length === 0 ? null : (
          <LargeItemsTable rows={largeItems} />
        )}
      </Section>
    </div>
  );
}

/**
 * Run a function over a list of ids with a concurrency cap. We
 * await each batch before starting the next so a slow server
 * doesn't stack N requests in flight. No retry on failure — first
 * error throws and the caller decides what to do.
 */
async function runBatched<T>(
  ids: T[],
  concurrency: number,
  fn: (id: T) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < ids.length; i += concurrency) {
    const batch = ids.slice(i, i + concurrency);
    await Promise.all(batch.map((id) => fn(id)));
  }
}

/** Sticky bulk-action bar shown above the table when 1+ rows are ticked. */
function BulkBar({
  count,
  label,
  busy,
  actions,
  onClear,
}: {
  count: number;
  label: string;
  busy: boolean;
  actions: Array<{
    label: string;
    icon: React.ReactNode;
    tone: 'danger' | 'warn';
    onClick: () => void;
  }>;
  onClear: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-accent/20 bg-accent/5 px-4 py-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-white">
          {count}
        </span>
        <span className="font-medium text-accent">
          {label}
          {count === 1 ? '' : 's'} selected
        </span>
        <button
          type="button"
          onClick={onClear}
          disabled={busy}
          className="inline-flex items-center gap-1 text-muted hover:text-ink-1 disabled:opacity-50"
        >
          <X className="h-3 w-3" />
          Clear
        </button>
      </div>
      <div className="flex items-center gap-2">
        {actions.map((a) => (
          <button
            key={a.label}
            type="button"
            onClick={a.onClick}
            disabled={busy}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${
              a.tone === 'danger'
                ? 'border-danger bg-danger/10 text-danger hover:bg-danger/20'
                : 'border-amber-400 bg-amber-50 text-amber-900 hover:bg-amber-100'
            }`}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : a.icon}
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------
// Summary strip
// ---------------------------------------------------------------

function SummaryBar({
  summary,
}: {
  summary: HousekeepingBundle['summary'];
}) {
  return (
    <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <StatCard
        icon={<Archive className="h-4 w-4 text-muted" />}
        label="Total items"
        value={summary.totalItemCount.toLocaleString()}
      />
      <StatCard
        icon={<Clock className="h-4 w-4 text-amber-700" />}
        label={`Stale (${summary.staleItemDays}d+ no edit, zero shares)`}
        value={summary.staleItemCount.toLocaleString()}
        tone={summary.staleItemCount > 0 ? 'warn' : 'ok'}
      />
      <StatCard
        icon={<UserIcon className="h-4 w-4 text-muted" />}
        label={`Quiet users (${summary.staleUserDays}d+ no sign-in)`}
        value={summary.staleUserCount.toLocaleString()}
        tone={summary.staleUserCount > 0 ? 'warn' : 'ok'}
      />
    </section>
  );
}

function StatCard({
  icon,
  label,
  value,
  tone = 'ok',
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: 'ok' | 'warn';
}) {
  return (
    <div
      className={`rounded-lg border px-4 py-3 ${
        tone === 'warn'
          ? 'border-amber-300 bg-amber-50'
          : 'border-border bg-surface-1'
      }`}
    >
      <p className="mb-0.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted">
        {icon}
        {label}
      </p>
      <p className="text-2xl font-semibold text-ink-0">{value}</p>
    </div>
  );
}

// ---------------------------------------------------------------
// Section shell
// ---------------------------------------------------------------

function Section({
  icon,
  title,
  empty,
  caption,
  bulkBar,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  empty: string;
  caption?: React.ReactNode;
  bulkBar?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-surface-1">
      <header className="border-b border-border px-4 py-3">
        <h2 className="inline-flex items-center gap-2 text-sm font-medium text-ink-0">
          {icon}
          {title}
        </h2>
        {caption ? (
          <p className="mt-0.5 text-xs text-muted">{caption}</p>
        ) : null}
      </header>
      {bulkBar}
      {children ? (
        <div>{children}</div>
      ) : (
        <p className="px-4 py-6 text-center text-sm text-muted">{empty}</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------
// Tables
// ---------------------------------------------------------------

function StaleItemsTable({
  rows,
  selected,
  onToggle,
  onToggleAll,
}: {
  rows: HousekeepingBundle['staleItems'];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
}) {
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  return (
    <table className="w-full text-sm">
      <thead className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-muted">
        <tr>
          <th className="w-8 px-4 py-2">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={onToggleAll}
              className="h-3.5 w-3.5 cursor-pointer"
              aria-label="Select all stale items"
            />
          </th>
          <th className="px-4 py-2">Title</th>
          <th className="px-4 py-2">Type</th>
          <th className="px-4 py-2">Owner</th>
          <th className="px-4 py-2">Last updated</th>
          <th className="px-4 py-2" />
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map((r) => {
          const Icon = getItemTypeIcon(r.type);
          const accent = getItemTypeAccent(r.type);
          const isSelected = selected.has(r.id);
          return (
            <tr key={r.id} className={isSelected ? 'bg-accent/5' : ''}>
              <td className="w-8 px-4 py-2">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => onToggle(r.id)}
                  className="h-3.5 w-3.5 cursor-pointer"
                  aria-label={`Select ${r.title}`}
                />
              </td>
              <td className="px-4 py-2">
                <Link
                  href={`/items/${r.id}`}
                  className="inline-flex items-center gap-2 text-ink-0 hover:text-accent"
                >
                  <Icon className={`h-4 w-4 ${accent}`} />
                  {r.title}
                </Link>
              </td>
              <td className="px-4 py-2 text-muted">{r.type}</td>
              <td className="px-4 py-2 text-muted">{r.ownerLabel}</td>
              <td className="px-4 py-2 text-muted">
                {new Date(r.updatedAt).toLocaleDateString()}
              </td>
              <td className="px-4 py-2 text-right">
                <Link
                  href={`/items/${r.id}`}
                  className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
                >
                  Review
                  <ChevronRight className="h-3 w-3" />
                </Link>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function StaleUsersTable({
  rows,
  selected,
  disableableIds,
  onToggle,
  onToggleAll,
}: {
  rows: HousekeepingBundle['staleUsers'];
  selected: Set<string>;
  disableableIds: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
}) {
  const eligibleIds = rows.filter((r) => disableableIds.has(r.id)).map((r) => r.id);
  const allEligibleSelected =
    eligibleIds.length > 0 && eligibleIds.every((id) => selected.has(id));
  return (
    <table className="w-full text-sm">
      <thead className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-muted">
        <tr>
          <th className="w-8 px-4 py-2">
            {eligibleIds.length > 0 ? (
              <input
                type="checkbox"
                checked={allEligibleSelected}
                onChange={onToggleAll}
                className="h-3.5 w-3.5 cursor-pointer"
                aria-label="Select all eligible users"
              />
            ) : null}
          </th>
          <th className="px-4 py-2">User</th>
          <th className="px-4 py-2">Role</th>
          <th className="px-4 py-2">Last seen</th>
          <th className="px-4 py-2">Joined</th>
          <th className="px-4 py-2">Owns items</th>
          <th className="px-4 py-2" />
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map((r) => {
          const canSelect = disableableIds.has(r.id);
          const isSelected = selected.has(r.id);
          return (
            <tr key={r.id} className={isSelected ? 'bg-accent/5' : ''}>
              <td className="w-8 px-4 py-2">
                <input
                  type="checkbox"
                  checked={isSelected}
                  disabled={!canSelect}
                  onChange={() => onToggle(r.id)}
                  className="h-3.5 w-3.5 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                  title={
                    canSelect
                      ? `Select ${r.fullName?.trim() || r.username}`
                      : `${r.fullName?.trim() || r.username} owns ${r.ownedItemCount} item${r.ownedItemCount === 1 ? '' : 's'}; reassign them before disabling this account.`
                  }
                />
              </td>
              <td className="px-4 py-2">
                <div className="flex flex-col">
                  <span className="text-ink-0">
                    {r.fullName?.trim() || r.username}
                  </span>
                  <span className="text-[11px] text-muted">{r.email}</span>
                </div>
              </td>
              <td className="px-4 py-2 text-muted">{r.orgRole}</td>
              <td className="px-4 py-2 text-muted">
                {r.lastSeenAt
                  ? new Date(r.lastSeenAt).toLocaleDateString()
                  : 'Never signed in'}
              </td>
              <td className="px-4 py-2 text-muted">
                {new Date(r.createdAt).toLocaleDateString()}
              </td>
              <td className="px-4 py-2 text-muted">
                {r.ownedItemCount > 0 ? (
                  <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-900">
                    {r.ownedItemCount} to reassign
                  </span>
                ) : (
                  '0'
                )}
              </td>
              <td className="px-4 py-2 text-right">
                <Link
                  href="/admin/users"
                  className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
                >
                  Open
                  <ChevronRight className="h-3 w-3" />
                </Link>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function LargeItemsTable({
  rows,
}: {
  rows: HousekeepingBundle['largeItems'];
}) {
  return (
    <table className="w-full text-sm">
      <thead className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-muted">
        <tr>
          <th className="px-4 py-2">Title</th>
          <th className="px-4 py-2">Type</th>
          <th className="px-4 py-2">Owner</th>
          <th className="px-4 py-2">Size</th>
          <th className="px-4 py-2">Last updated</th>
          <th className="px-4 py-2" />
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map((r) => (
          <tr key={r.id}>
            <td className="px-4 py-2">
              <Link
                href={`/items/${r.id}`}
                className="text-ink-0 hover:text-accent"
              >
                {r.title}
              </Link>
            </td>
            <td className="px-4 py-2 text-muted">{r.type}</td>
            <td className="px-4 py-2 text-muted">{r.ownerLabel}</td>
            <td className="px-4 py-2 font-mono text-ink-0">
              {formatBytes(r.sizeBytes)}
            </td>
            <td className="px-4 py-2 text-muted">
              {new Date(r.updatedAt).toLocaleDateString()}
            </td>
            <td className="px-4 py-2 text-right">
              <Link
                href={`/items/${r.id}`}
                className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
              >
                Open
                <ChevronRight className="h-3 w-3" />
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
