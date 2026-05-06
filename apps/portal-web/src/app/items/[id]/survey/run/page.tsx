import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, FileText, Hammer } from 'lucide-react';
import type { Item, SurveyData } from '@gratis-gis/shared-types';
import {
  DEFAULT_SURVEY,
  isSurveyItem,
  readSurveyData,
} from '@gratis-gis/shared-types';
import { apiFetch } from '@/lib/api';

interface Props {
  params: { id: string };
}

/**
 * Survey Response Viewer runtime (#260) -- placeholder slice.
 *
 * The full runtime (paired-data_layer fetch, form-shaped popup,
 * date-range filter chip, hideSubmitter aware attribute table) lands
 * in a follow-up. This page renders enough today to:
 *   - prove the route resolves and the type guards work
 *   - tell an opener what's coming
 *   - give the author a quick affordance back to the configuration
 *     page so they can bind a form / pick a map
 *
 * Rendering "for real" reuses the EditorRuntime substrate the same
 * way ViewerRuntime does, but synthesizes its targets from the
 * paired data_layer instead of the survey's own targets list. That
 * dispatch + pairing hop is the next slice.
 */
export default async function SurveyRuntimePage({ params }: Props) {
  let item: Item<unknown>;
  try {
    item = await apiFetch<Item<unknown>>(`/api/items/${params.id}`);
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) notFound();
    throw err;
  }
  if (!isSurveyItem(item)) notFound();

  const survey: SurveyData = {
    ...DEFAULT_SURVEY,
    ...((readSurveyData(item) ?? {}) as Partial<SurveyData>),
  };

  return (
    <div className="flex h-full min-h-[calc(100vh-3.5rem)] flex-col bg-surface-0">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-surface-1 px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/items"
            className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink-0"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to items
          </Link>
          <span className="text-muted">/</span>
          <span className="inline-flex items-center gap-1.5 text-base font-semibold text-ink-0">
            <FileText className="h-4 w-4 text-orange-500" />
            {item.title}
          </span>
        </div>
        <Link
          href={`/items/${item.id}`}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-1 px-2 py-1 text-xs font-medium text-ink-1 hover:bg-surface-2"
        >
          Configure
        </Link>
      </header>
      <div className="flex flex-1 items-center justify-center p-10">
        <div className="max-w-md rounded-lg border border-dashed border-border bg-surface-1 p-8 text-center shadow-card">
          <Hammer className="mx-auto h-8 w-8 text-amber-500" />
          <h2 className="mt-3 text-base font-semibold text-ink-0">
            Survey runtime coming soon
          </h2>
          <p className="mt-2 text-sm text-muted">
            This survey app is bound to{' '}
            {survey.formId ? (
              <span className="font-medium text-ink-1">a form</span>
            ) : (
              <span className="font-medium text-rose-700">no form yet</span>
            )}
            . The runtime will render submissions as map features with
            click-through to a form-shaped receipt. Until that ships,
            head back to{' '}
            <Link
              href={`/items/${item.id}`}
              className="text-accent hover:underline"
            >
              the configuration page
            </Link>{' '}
            to finish setup.
          </p>
        </div>
      </div>
    </div>
  );
}

export const dynamic = 'force-dynamic';
