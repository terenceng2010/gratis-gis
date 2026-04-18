'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Check,
  Loader2,
  Plus,
  Trash2,
  Users as UsersIcon,
  User as UserIcon,
} from 'lucide-react';
import type { Group, ItemShare, SharePermission } from '@gratis-gis/shared-types';

interface Props {
  itemId: string;
  initialShares: ItemShare[];
  groups: Pick<Group, 'id' | 'title'>[];
}

/**
 * Owner-only sharing controls. Lists current ItemShare rows, lets the owner
 * add a share to a group or a specific user (by user id for now; a user
 * picker component will replace the raw input once /api/users/search exists)
 * and remove existing shares.
 *
 * Mutations go through /api/items/:id/share (POST/DELETE). The page is a
 * server component, so after each mutation we call router.refresh() to
 * re-fetch the server-rendered shares list.
 */
type RowSaveState = 'idle' | 'saving' | 'saved' | 'error';

export function SharingPanel({ itemId, initialShares, groups }: Props) {
  const router = useRouter();
  const [shares, setShares] = useState(initialShares);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Per-row save state, keyed by "<principalType>:<principalId>".
  // Lets us show a spinner / check next to exactly the row being saved,
  // so the rest of the list doesn't flicker on a single-row edit.
  const [rowState, setRowState] = useState<Record<string, RowSaveState>>({});

  const [mode, setMode] = useState<'group' | 'user'>('group');
  const [groupId, setGroupId] = useState<string>(groups[0]?.id ?? '');
  const [userId, setUserId] = useState<string>('');
  const [permission, setPermission] = useState<SharePermission>('view');

  const keyOf = (s: Pick<ItemShare, 'principalType' | 'principalId'>) =>
    `${s.principalType}:${s.principalId}`;

  async function updateSharePermission(
    share: ItemShare,
    nextPermission: SharePermission,
  ) {
    if (nextPermission === share.permission) return;
    const k = keyOf(share);
    setRowState((m) => ({ ...m, [k]: 'saving' }));
    // Optimistic update so the dropdown stays on the new value while the
    // request is in flight; we revert if it fails.
    setShares((cur) =>
      cur.map((s) =>
        keyOf(s) === k ? { ...s, permission: nextPermission } : s,
      ),
    );
    const res = await fetch(`/api/portal/items/${itemId}/share`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        principalType: share.principalType,
        principalId: share.principalId,
        permission: nextPermission,
      }),
    });
    if (!res.ok) {
      setRowState((m) => ({ ...m, [k]: 'error' }));
      // Revert optimistic change
      setShares((cur) =>
        cur.map((s) =>
          keyOf(s) === k ? { ...s, permission: share.permission } : s,
        ),
      );
      setError(`Update failed: ${res.status} ${await res.text()}`);
      return;
    }
    setRowState((m) => ({ ...m, [k]: 'saved' }));
    // Fade the saved indicator after a moment.
    setTimeout(
      () => setRowState((m) => (m[k] === 'saved' ? { ...m, [k]: 'idle' } : m)),
      1500,
    );
    startTransition(() => router.refresh());
  }

  async function addShare() {
    setError(null);
    const body = {
      principalType: mode,
      principalId: mode === 'group' ? groupId : userId,
      permission,
    };
    if (!body.principalId) {
      setError(`Pick a ${mode} first.`);
      return;
    }
    const res = await fetch(`/api/portal/items/${itemId}/share`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      setError(`Share failed: ${res.status} ${await res.text()}`);
      return;
    }
    const added: ItemShare = await res.json();
    setShares((cur) => {
      const filtered = cur.filter(
        (s) =>
          !(
            s.principalType === added.principalType &&
            s.principalId === added.principalId
          ),
      );
      return [...filtered, added];
    });
    setUserId('');
    startTransition(() => router.refresh());
  }

  async function removeShare(share: ItemShare) {
    setError(null);
    const res = await fetch(`/api/portal/items/${itemId}/share`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        principalType: share.principalType,
        principalId: share.principalId,
      }),
    });
    if (!res.ok) {
      setError(`Unshare failed: ${res.status} ${await res.text()}`);
      return;
    }
    setShares((cur) =>
      cur.filter(
        (s) =>
          !(
            s.principalType === share.principalType &&
            s.principalId === share.principalId
          ),
      ),
    );
    startTransition(() => router.refresh());
  }

  return (
    <div className="rounded-lg border border-border bg-surface-1 shadow-card">
      {shares.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted">
          Not shared with anyone yet. This item is governed by its baseline
          access above.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {shares.map((share) => {
            const groupTitle = groups.find(
              (g) => g.id === share.principalId,
            )?.title;
            return (
              <li
                key={`${share.principalType}:${share.principalId}`}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  {share.principalType === 'group' ? (
                    <UsersIcon className="h-4 w-4 shrink-0 text-muted" />
                  ) : (
                    <UserIcon className="h-4 w-4 shrink-0 text-muted" />
                  )}
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-ink-1">
                      {share.principalType === 'group'
                        ? (groupTitle ?? share.principalId.slice(0, 8))
                        : share.principalId.slice(0, 8)}
                    </div>
                    <div className="text-xs text-muted">
                      {share.principalType}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <select
                    value={share.permission}
                    onChange={(e) =>
                      updateSharePermission(
                        share,
                        e.target.value as SharePermission,
                      )
                    }
                    disabled={pending}
                    aria-label="Change permission"
                    className="h-8 rounded-md border border-border bg-surface-1 px-2 text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-50"
                  >
                    <option value="view">can view</option>
                    <option value="edit">can edit</option>
                    <option value="admin">can admin</option>
                  </select>
                  <span
                    className="inline-flex h-5 w-5 items-center justify-center"
                    aria-live="polite"
                  >
                    {rowState[keyOf(share)] === 'saving' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" />
                    ) : rowState[keyOf(share)] === 'saved' ? (
                      <Check className="h-3.5 w-3.5 text-success" />
                    ) : null}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeShare(share)}
                    disabled={pending}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-danger disabled:opacity-50"
                    aria-label="Remove share"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="border-t border-border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border border-border bg-surface-2">
            <button
              type="button"
              onClick={() => setMode('group')}
              className={`px-3 py-1.5 text-sm ${mode === 'group' ? 'bg-accent text-accent-foreground rounded-md' : 'text-muted'}`}
            >
              Group
            </button>
            <button
              type="button"
              onClick={() => setMode('user')}
              className={`px-3 py-1.5 text-sm ${mode === 'user' ? 'bg-accent text-accent-foreground rounded-md' : 'text-muted'}`}
            >
              User
            </button>
          </div>

          {mode === 'group' ? (
            <select
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              className="h-9 min-w-[12rem] rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            >
              {groups.length === 0 ? (
                <option value="">(no groups yet)</option>
              ) : (
                groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title}
                  </option>
                ))
              )}
            </select>
          ) : (
            <input
              type="text"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="user id (uuid)"
              className="h-9 min-w-[18rem] rounded-md border border-border bg-surface-1 px-3 font-mono text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
          )}

          <select
            value={permission}
            onChange={(e) => setPermission(e.target.value as SharePermission)}
            className="h-9 rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          >
            <option value="view">can view</option>
            <option value="edit">can edit</option>
            <option value="admin">can admin</option>
          </select>

          <button
            type="button"
            onClick={addShare}
            disabled={pending}
            className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            Add share
          </button>
        </div>
        {error ? (
          <p className="mt-3 text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
