import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { ItemForm } from '../item-form';

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
          Items are the shared unit of content in the portal: maps, feature
          layers, forms, apps, dashboards, notebooks. Pick a type, name it,
          decide who can see it, and refine the content from the item page
          once it exists.
        </p>
      </header>

      <ItemForm mode={{ kind: 'create' }} />
    </div>
  );
}
