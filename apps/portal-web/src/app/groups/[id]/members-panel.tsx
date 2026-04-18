'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2, User as UserIcon } from 'lucide-react';
import type { GroupMember, User } from '@gratis-gis/shared-types';

type MemberWithUser = GroupMember & {
  user?: Pick<User, 'id' | 'username' | 'fullName'>;
};

interface Props {
  groupId: string;
  initialMembers: MemberWithUser[];
  canManage: boolean;
}

/**
 * Membership management for a group. Admins and group owners can add or
 * remove members; everyone else sees a read-only roster.
 *
 * The backend endpoints already exist:
 *   POST   /api/groups/:id/members      { userId, role? }
 *   DELETE /api/groups/:id/members/:userId
 *
 * User id input is a raw UUID for now; replace with a user picker once
 * /api/users (org directory) is exposed.
 */
export function MembersPanel({ groupId, initialMembers, canManage }: Props) {
  const router = useRouter();
  const [members, setMembers] = useState(initialMembers);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');

  async function addMember() {
    setError(null);
    if (!userId) {
      setError('Enter a user id first.');
      return;
    }
    const res = await fetch(`/api/portal/groups/${groupId}/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId, role }),
    });
    if (!res.ok) {
      setError(`Add failed: ${res.status} ${await res.text()}`);
      return;
    }
    const added: GroupMember = await res.json();
    setMembers((cur) => {
      const filtered = cur.filter((m) => m.userId !== added.userId);
      return [...filtered, { ...added }];
    });
    setUserId('');
    startTransition(() => router.refresh());
  }

  async function removeMember(member: MemberWithUser) {
    setError(null);
    const res = await fetch(
      `/api/portal/groups/${groupId}/members/${member.userId}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      setError(`Remove failed: ${res.status} ${await res.text()}`);
      return;
    }
    setMembers((cur) => cur.filter((m) => m.userId !== member.userId));
    startTransition(() => router.refresh());
  }

  return (
    <div className="rounded-lg border border-border bg-surface-1 shadow-card">
      {members.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted">
          No members yet.
          {canManage ? ' Add one below.' : ''}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {members.map((m) => (
            <li
              key={m.userId}
              className="flex items-center justify-between px-4 py-3"
            >
              <div className="flex items-center gap-3">
                <UserIcon className="h-4 w-4 text-muted" />
                <div>
                  <div className="text-sm font-medium text-ink-1">
                    {m.user?.fullName ??
                      m.user?.username ??
                      m.userId.slice(0, 8)}
                  </div>
                  <div className="text-xs text-muted">{m.role}</div>
                </div>
              </div>
              {canManage ? (
                <button
                  type="button"
                  onClick={() => removeMember(m)}
                  disabled={pending}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-danger disabled:opacity-50"
                  aria-label="Remove member"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        <div className="border-t border-border p-4">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="user id (uuid)"
              className="h-9 min-w-[18rem] flex-1 rounded-md border border-border bg-surface-1 px-3 font-mono text-xs focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as 'member' | 'admin')}
              className="h-9 rounded-md border border-border bg-surface-1 px-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            >
              <option value="member">member</option>
              <option value="admin">admin</option>
            </select>
            <button
              type="button"
              onClick={addMember}
              disabled={pending}
              className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90 disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              Add member
            </button>
          </div>
          {error ? (
            <p className="mt-3 text-sm text-danger" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
