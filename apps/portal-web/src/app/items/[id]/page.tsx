import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  Building2,
  Calendar,
  Globe2,
  Lock,
  Pencil,
  User,
  Users,
} from 'lucide-react';
import type {
  Item,
  ItemShare,
  Group,
  User as UserT,
  ArcgisServiceData,
  FeatureServiceData,
  WebMapData,
} from '@gratis-gis/shared-types';
import {
  DEFAULT_ARCGIS_SERVICE,
  DEFAULT_FEATURE_SERVICE,
  DEFAULT_WEB_MAP,
} from '@gratis-gis/shared-types';
import { EntityBadge } from '@gratis-gis/ui';
import { apiFetch } from '@/lib/api';
import { SharingPanel } from './sharing-panel';
import { DeleteItemButton } from './delete-button';
import { MapEditor } from './web-map/map-editor';
import { FeatureServiceEditor } from './feature-service/editor';
import { ArcgisServiceEditor } from './arcgis-service/editor';
import { ComingSoon } from './coming-soon';

interface Props {
  params: { id: string };
}

type ItemWithShares = Item & { shares: ItemShare[] };

const typeBadge: Record<string, string> = {
  web_map: 'bg-emerald-100 text-emerald-800',
  feature_service: 'bg-sky-100 text-sky-800',
  arcgis_service: 'bg-cyan-100 text-cyan-800',
  form: 'bg-violet-100 text-violet-800',
  web_app: 'bg-amber-100 text-amber-800',
  report_template: 'bg-rose-100 text-rose-800',
  dashboard: 'bg-indigo-100 text-indigo-800',
  file: 'bg-slate-100 text-slate-800',
  notebook: 'bg-fuchsia-100 text-fuchsia-800',
  tool: 'bg-teal-100 text-teal-800',
};

const accessIcon = {
  private: <Lock className="h-3.5 w-3.5" />,
  org: <Building2 className="h-3.5 w-3.5" />,
  public: <Globe2 className="h-3.5 w-3.5" />,
};

export default async function ItemDetailPage({ params }: Props) {
  let item: ItemWithShares;
  try {
    item = await apiFetch<ItemWithShares>(`/api/items/${params.id}`);
  } catch (err) {
    // apiFetch throws on non-2xx. 404 from the API means "not found or not
    // visible to you" (same response to prevent enumeration). Show notFound.
    if (err instanceof Error && err.message.includes('404')) notFound();
    throw err;
  }

  // Fetch the currently-signed-in user so we can show owner/admin-only UI.
  const me = await apiFetch<{ id: string; orgRole: string }>('/api/users/me');
  const canManage = me.id === item.ownerId || me.orgRole === 'admin';

  // Load groups (for the share picker) and any referenced users.
  // Visible-groups are already scoped to this user on the API side.
  const groups = canManage ? await apiFetch<Group[]>('/api/groups') : [];

  const badgeClass = typeBadge[item.type] ?? 'bg-slate-100 text-slate-800';

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <Link
        href="/items"
        className="mb-6 inline-flex items-center gap-1 text-sm text-muted hover:text-ink-0"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to items
      </Link>

      <header className="mb-8 flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-4">
          <EntityBadge
            label={item.title}
            seed={item.id}
            imageUrl={item.thumbnailUrl}
            size="xl"
            rounded="md"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span
                className={`rounded px-2 py-0.5 text-xs font-medium ${badgeClass}`}
              >
                {item.type}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-xs text-muted">
                {accessIcon[item.access]}
                {item.access}
              </span>
            </div>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">
              {item.title}
            </h1>
            {item.description ? (
              <p className="mt-2 max-w-3xl text-sm text-muted">
                {item.description}
              </p>
            ) : null}
            <div className="mt-3 flex items-center gap-4 text-xs text-muted">
              <span className="inline-flex items-center gap-1">
                <Calendar className="h-3.5 w-3.5" />
                Updated {new Date(item.updatedAt).toLocaleString()}
              </span>
              <span className="inline-flex items-center gap-1">
                <User className="h-3.5 w-3.5" />
                Owner: {item.ownerId === me.id ? 'you' : item.ownerId.slice(0, 8)}
              </span>
            </div>
          </div>
        </div>

        {canManage ? (
          <div className="flex shrink-0 items-center gap-2">
            <Link
              href={`/items/${item.id}/edit`}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 text-sm font-medium text-ink-1 shadow-card hover:bg-surface-2"
            >
              <Pencil className="h-4 w-4" />
              Edit
            </Link>
            <DeleteItemButton itemId={item.id} itemTitle={item.title} />
          </div>
        ) : null}
      </header>

      {item.tags.length > 0 ? (
        <section className="mb-8">
          <h2 className="mb-2 text-sm font-medium text-muted">Tags</h2>
          <div className="flex flex-wrap gap-2">
            {item.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full border border-border bg-surface-1 px-3 py-1 text-xs"
              >
                {tag}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {item.type === 'web_map' ? (
        <section className="mb-8">
          <h2 className="mb-2 text-sm font-medium text-muted">Map</h2>
          <MapEditor
            itemId={item.id}
            initial={{ ...DEFAULT_WEB_MAP, ...((item.data ?? {}) as Partial<WebMapData>) }}
            canEdit={canManage}
          />
        </section>
      ) : item.type === 'feature_service' ? (
        <section className="mb-8">
          <h2 className="mb-2 text-sm font-medium text-muted">Feature service</h2>
          <FeatureServiceEditor
            itemId={item.id}
            initial={
              // For v2 items, item.data is already the correct shape.
              // For v1 items (or brand-new items with no data), merge
              // defaults so the editor always receives a complete object.
              (item.data as FeatureServiceData | null)?.version === 2
                ? (item.data as FeatureServiceData)
                : ({
                    ...DEFAULT_FEATURE_SERVICE,
                    ...((item.data ?? {}) as Partial<FeatureServiceData>),
                  } as FeatureServiceData)
            }
            canEdit={canManage}
          />
        </section>
      ) : item.type === 'arcgis_service' ? (
        <section className="mb-8">
          <h2 className="mb-2 text-sm font-medium text-muted">ArcGIS service</h2>
          <ArcgisServiceEditor
            itemId={item.id}
            initial={{
              ...DEFAULT_ARCGIS_SERVICE,
              ...((item.data ?? {}) as Partial<ArcgisServiceData>),
            }}
            canEdit={canManage}
          />
        </section>
      ) : (
        <section className="mb-8">
          <ComingSoon type={item.type} data={item.data} />
        </section>
      )}

      {canManage ? (
        <section className="mb-8">
          <h2 className="mb-4 flex items-center gap-2 text-sm font-medium text-muted">
            <Users className="h-4 w-4" />
            Sharing
          </h2>
          <SharingPanel
            itemId={item.id}
            initialAccess={item.access}
            initialShares={item.shares}
            groups={groups}
            orgLabel="Your organization"
          />
        </section>
      ) : null}
    </div>
  );
}
