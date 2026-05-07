// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { GroupForm } from '../group-form';

export const metadata = { title: 'New group' };

export default function NewGroupPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <Link
        href="/groups"
        className="mb-6 inline-flex items-center gap-1 text-sm text-muted hover:text-ink-0"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to groups
      </Link>

      <header className="mb-8">
        <p className="text-sm text-muted">Collaboration</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">
          Create a new group
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Groups are how teams share content in bulk. Anything shared to
          the group is instantly visible to every member, so membership
          is how access flows through the portal.
        </p>
      </header>

      <GroupForm mode={{ kind: 'create' }} />
    </div>
  );
}
