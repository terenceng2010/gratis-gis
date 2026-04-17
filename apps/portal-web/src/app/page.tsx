import Link from 'next/link';
import { getServerSession } from 'next-auth';
import { ArrowRight, Map as MapIcon, Layers, Users, FileSpreadsheet } from 'lucide-react';
import { authOptions } from '@/lib/auth';

export default async function HomePage() {
  const session = await getServerSession(authOptions);
  const name = session?.user?.name?.split(' ')[0] ?? 'there';

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <header className="mb-10">
        <p className="text-sm text-muted">
          {session ? `Hey ${name},` : 'Welcome to GratisGIS.'}
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">
          {session ? 'What would you like to do?' : 'Sign in to get started.'}
        </h1>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          href="/items?mine=true"
          title="My items"
          desc="Everything you own: maps, forms, apps, reports."
          icon={<Layers className="h-5 w-5" />}
        />
        <Tile
          href="/items"
          title="Browse"
          desc="Items shared with you and your groups."
          icon={<MapIcon className="h-5 w-5" />}
        />
        <Tile
          href="/groups"
          title="Groups"
          desc="Collaborate with teammates and share content."
          icon={<Users className="h-5 w-5" />}
        />
        <Tile
          href="/reports"
          title="Reports"
          desc="Turn your data into shareable documents."
          icon={<FileSpreadsheet className="h-5 w-5" />}
        />
      </section>

      {!session ? (
        <div className="mt-10">
          <Link
            href="/api/auth/signin"
            className="inline-flex h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90"
          >
            Sign in
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function Tile({
  href,
  title,
  desc,
  icon,
}: {
  href: string;
  title: string;
  desc: string;
  icon: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col rounded-lg border border-border bg-surface-1 p-5 shadow-card transition-all hover:-translate-y-0.5 hover:shadow-raised"
    >
      <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-md bg-accent/10 text-accent">
        {icon}
      </div>
      <div className="font-medium text-ink-1">{title}</div>
      <div className="mt-1 text-sm text-muted">{desc}</div>
      <div className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-accent opacity-0 transition-opacity group-hover:opacity-100">
        Open <ArrowRight className="h-3.5 w-3.5" />
      </div>
    </Link>
  );
}
