import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Users, Lock, Building2, Globe2 } from 'lucide-react';
import type { Group, GroupMember, User } from '@gratis-gis/shared-types';
import { apiFetch } from '@/lib/api';
import { MembersPanel } from './members-panel';

interface Props {
  params: { id: string };
}

const accessIcon = {
  private: <Lock className="h-3.5 w-3.5" />,
  org: <Building2 className="h-3.5 w-3.5" />,
  public: <Globe2 className="h-3.5 w-3.5" />,
};

type MemberWithUser = GroupMember & { user: Pick<User, 'id' | 'username' | 'fullName'> };

export default async function GroupDetailPage({ params }: Props) {
  let group: Group;
  let members: MemberWithUser[];
  try {
    [group, members] = await Promise.all([
      apiFetch<Group>(`/api/groups/${params.id}`),
      apiFetch<MemberWithUser[]>(`/api/groups/${params.id}/members`),
    ]);
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) notFound();
    throw err;
  }

  const me = await apiFetch<{ id: string; orgRole: string }>('/api/users/me');
  const canManage = me.id === group.ownerId || me.orgRole === 'admin';

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <Link
        href="/groups"
        className="mb-6 inline-flex items-center gap-1 text-sm text-muted hover:text-ink-0"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to groups
      </Link>

      <header className="mb-8">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-xs text-muted">
            {accessIcon[group.access]}
            {group.access}
          </span>
        </div>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{group.title}</h1>
        {group.description ? (
          <p className="mt-2 max-w-3xl text-sm text-muted">{group.description}</p>
        ) : null}
        <div className="mt-3 text-xs text-muted">
          Owner: {group.ownerId === me.id ? 'you' : group.ownerId.slice(0, 8)}
        </div>
      </header>

      <section className="mb-8">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-medium text-muted">
          <Users className="h-4 w-4" />
          Members
        </h2>
        <MembersPanel
          groupId={group.id}
          initialMembers={members}
          canManage={canManage}
        />
      </section>
    </div>
  );
}
