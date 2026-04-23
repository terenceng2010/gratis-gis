import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { NewItemWizard } from './wizard';

export const metadata = { title: 'New item' };

export default function NewItemPage() {
  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10">
      <Link
        href="/items"
        className="mb-6 inline-flex items-center gap-1 text-sm text-muted hover:text-ink-0"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to items
      </Link>

      <header className="mb-8">
        <p className="text-sm text-muted">Content</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">
          Create a new item
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Pick what you&apos;re creating, then fill in the details. For services
          and uploads, we&apos;ll gather what we need on the next screen so the
          item lands ready to use.
        </p>
      </header>

      <NewItemWizard />
    </div>
  );
}
