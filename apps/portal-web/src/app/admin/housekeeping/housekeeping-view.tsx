'use client';

import Link from 'next/link';
import {
  Archive,
  BarChart3,
  ChevronRight,
  Clock,
  Database,
  User as UserIcon,
  Users,
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
  const { summary, staleItems, staleUsers, largeItems } = bundle;
  return (
    <div className="space-y-6">
      <SummaryBar summary={summary} />

      <Section
        icon={<Clock className="h-4 w-4" />}
        title={`Items nobody's touched for ${summary.staleItemDays}+ days`}
        empty="No stale items — every item in your org has been updated recently or is still being shared."
        caption={
          <>
            {staleItems.length === 0
              ? null
              : `Showing the ${staleItems.length} oldest untouched items with zero shares. `}
            Click through to review. If something is still useful,
            open it (the updated-at refreshes). If not, delete or
            reassign from the detail page.
          </>
        }
      >
        {staleItems.length === 0 ? null : (
          <StaleItemsTable rows={staleItems} />
        )}
      </Section>

      <Section
        icon={<Users className="h-4 w-4" />}
        title={`Users quiet for ${summary.staleUserDays}+ days`}
        empty="Nobody looks idle. Admins are deliberately excluded from this check so a break-glass account never shows up."
        caption="Admins are excluded. Users with owned items are shown so you can think about reassignment before disabling the account."
      >
        {staleUsers.length === 0 ? null : <StaleUsersTable rows={staleUsers} />}
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
  children,
}: {
  icon: React.ReactNode;
  title: string;
  empty: string;
  caption?: React.ReactNode;
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
}: {
  rows: HousekeepingBundle['staleItems'];
}) {
  return (
    <table className="w-full text-sm">
      <thead className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-muted">
        <tr>
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
          return (
            <tr key={r.id}>
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
}: {
  rows: HousekeepingBundle['staleUsers'];
}) {
  return (
    <table className="w-full text-sm">
      <thead className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-muted">
        <tr>
          <th className="px-4 py-2">User</th>
          <th className="px-4 py-2">Role</th>
          <th className="px-4 py-2">Last seen</th>
          <th className="px-4 py-2">Joined</th>
          <th className="px-4 py-2">Owns items</th>
          <th className="px-4 py-2" />
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map((r) => (
          <tr key={r.id}>
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
        ))}
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
