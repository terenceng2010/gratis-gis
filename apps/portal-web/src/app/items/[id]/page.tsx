import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  Building2,
  Calendar,
  ChevronDown,
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
import { ItemTypeBadge } from '@/lib/item-type-icon';
import { apiFetch } from '@/lib/api';
import { SharingPanel } from './sharing-panel';
import { DeleteItemButton } from './delete-button';
import { MapEditor } from './web-map/map-editor';
import { FeatureServiceEditor } from './feature-service/editor';
import { FeatureServiceV3SchemaEditor } from './feature-service/v3-schema-editor';
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
  // "Workspace" item types are content-heavy (map, feature service,
  // arcgis service). For those, we collapse the metadata header so the
  // actual editor is the first thing the user sees. Other types keep
  // the standard, richer header because their "content" is basically
  // metadata + some small payload anyway.
  const isWorkspace =
    item.type === 'web_map' ||
    item.type === 'feature_service' ||
    item.type === 'arcgis_service';
  // Bump the container up for workspace types so the map gets more
  // horizontal room; other pages keep the old 6xl width.
  const containerWidth = isWorkspace ? 'max-w-7xl' : 'max-w-6xl';

  return (
    <div className={`mx-auto w-full ${containerWidth} px-6 py-6`}>
      <Link
        href="/items"
        className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-ink-0"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to items
      </Link>

      {/* Compact header: single row with badge, title, chips, and
          actions. Description / owner / updated / tags collapse into
          a `<details>` disclosure below so they're one click away
          without eating the fold. */}
      <header className="mb-4 flex items-center gap-3">
        {/* Thumbnail: user-uploaded image wins; otherwise a per-type
            icon tile so the header visually matches the card on the
            list page instead of showing letter-initials. */}
        {item.thumbnailUrl ? (
          <EntityBadge
            label={item.title}
            seed={item.id}
            imageUrl={item.thumbnailUrl}
            size="md"
            rounded="md"
          />
        ) : (
          <ItemTypeBadge type={item.type} size="md" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-xl font-semibold tracking-tight">
              {item.title}
            </h1>
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${badgeClass}`}
            >
              {item.type}
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">
              {accessIcon[item.access]}
              {item.access}
            </span>
          </div>
        </div>
        {canManage ? (
          <div className="flex shrink-0 items-center gap-2">
            <Link
              href={`/items/${item.id}/edit`}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2.5 text-xs font-medium text-ink-1 shadow-card hover:bg-surface-2"
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit
            </Link>
            <DeleteItemButton itemId={item.id} itemTitle={item.title} />
          </div>
        ) : null}
      </header>

      {/* Collapsed details: description + owner + updated + tags.
          Uses the native <details> element so it works without any
          client-side JS and stays accessible. Shown only when the
          user has something worth seeing (description OR tags). */}
      {item.description || item.tags.length > 0 ? (
        <details className="group mb-4 rounded-md border border-border bg-surface-1">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-xs text-muted hover:text-ink-1">
            <span className="inline-flex items-center gap-3">
              <span className="inline-flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                Updated {new Date(item.updatedAt).toLocaleString()}
              </span>
              <span className="inline-flex items-center gap-1">
                <User className="h-3 w-3" />
                Owner:{' '}
                {item.ownerId === me.id ? 'you' : item.ownerId.slice(0, 8)}
              </span>
              {item.tags.length > 0 ? (
                <span className="text-muted">
                  · {item.tags.length}{' '}
                  {item.tags.length === 1 ? 'tag' : 'tags'}
                </span>
              ) : null}
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180" />
          </summary>
          <div className="space-y-3 border-t border-border px-3 py-3">
            {item.description ? (
              <p className="text-sm text-ink-1">{item.description}</p>
            ) : null}
            {item.tags.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {item.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px] text-muted"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </details>
      ) : (
        // No description/tags: still show the updated + owner line
        // so users have at least the audit trail visible.
        <div className="mb-4 flex items-center gap-3 text-xs text-muted">
          <span className="inline-flex items-center gap-1">
            <Calendar className="h-3 w-3" />
            Updated {new Date(item.updatedAt).toLocaleString()}
          </span>
          <span className="inline-flex items-center gap-1">
            <User className="h-3 w-3" />
            Owner: {item.ownerId === me.id ? 'you' : item.ownerId.slice(0, 8)}
          </span>
        </div>
      )}

      {item.type === 'web_map' ? (
        <section className="mb-6">
          <MapEditor
            itemId={item.id}
            initial={{ ...DEFAULT_WEB_MAP, ...((item.data ?? {}) as Partial<WebMapData>) }}
            canEdit={canManage}
          />
        </section>
      ) : item.type === 'feature_service' ? (
        // v3 items route to the new multi-layer schema editor. v1/v2
        // continue to use the legacy single-layer editor so existing
        // items keep working exactly as before.
        (item.data as FeatureServiceData | null)?.version === 3 ? (
          <section className="mb-6">
            <FeatureServiceV3SchemaEditor
              itemId={item.id}
              // Runtime version check above guarantees the v3 shape;
              // cast through unknown to sidestep conditional-type
              // acrobatics.
              initial={
                item.data as unknown as import('@gratis-gis/shared-types').FeatureServiceDataV3
              }
              canEdit={canManage}
            />
          </section>
        ) : (
        <section className="mb-6">
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
        )
      ) : item.type === 'arcgis_service' ? (
        <section className="mb-6">
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
        <section className="mb-6">
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
