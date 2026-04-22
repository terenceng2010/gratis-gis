import Link from 'next/link';
import { LogOut } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { AvatarEditor } from './avatar-editor';

interface Me {
  id: string;
  username: string;
  email: string;
  fullName: string;
  orgName: string | null;
  orgRole: string;
  avatarUrl: string | null;
}

export const metadata = { title: 'Profile' };

export default async function ProfilePage() {
  const me = await apiFetch<Me>('/api/users/me');

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <header className="mb-8">
        <p className="text-sm text-muted">You</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Profile</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Your identity in {me.orgName ?? 'this organization'}. Username,
          email, and name are managed by your identity provider. Your
          avatar lives here.
        </p>
      </header>

      <section className="mb-10">
        <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-muted">
          Avatar
        </label>
        <AvatarEditor
          userId={me.id}
          fullName={me.fullName}
          initialAvatarUrl={me.avatarUrl}
        />
      </section>

      <section className="mb-10 space-y-4 rounded-lg border border-border bg-surface-1 p-4 shadow-card">
        <Field label="Name" value={me.fullName} />
        <Field label="Username" value={me.username} />
        <Field label="Email" value={me.email} />
        <Field label="Organization" value={me.orgName ?? '-'} />
        <Field label="Role" value={me.orgRole} />
      </section>

      <section>
        <Link
          href="/api/auth/signout"
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 shadow-card hover:bg-surface-2"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </Link>
      </section>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] items-baseline gap-4 text-sm">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted">
        {label}
      </dt>
      <dd className="text-ink-0">{value}</dd>
    </div>
  );
}
