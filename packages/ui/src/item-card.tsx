import type { Item } from '@gratis-gis/shared-types';
import { cn } from './cn';

export interface ItemCardProps {
  item: Pick<Item, 'id' | 'title' | 'description' | 'type' | 'thumbnailUrl' | 'updatedAt'>;
  /**
   * Where clicking the card should go. If omitted, the card renders as a
   * non-interactive block. An href is preferred over an onClick handler so
   * the card remains server-component-safe and accessible (right-click, open
   * in new tab, screen-reader announcement as "link" rather than "button").
   */
  href?: string;
  className?: string;
}

const typeBadgeColor: Record<string, string> = {
  web_map: 'bg-emerald-100 text-emerald-800',
  feature_service: 'bg-sky-100 text-sky-800',
  form: 'bg-violet-100 text-violet-800',
  web_app: 'bg-amber-100 text-amber-800',
  report_template: 'bg-rose-100 text-rose-800',
  dashboard: 'bg-indigo-100 text-indigo-800',
  file: 'bg-slate-100 text-slate-800',
  notebook: 'bg-fuchsia-100 text-fuchsia-800',
  tool: 'bg-teal-100 text-teal-800',
};

export function ItemCard({ item, href, className }: ItemCardProps) {
  const badgeClass = typeBadgeColor[item.type] ?? 'bg-slate-100 text-slate-800';
  const baseClass = cn(
    'flex w-full flex-col gap-2 rounded-lg border border-border bg-surface-1 p-4 text-left shadow-card transition-shadow',
    href ? 'hover:shadow-raised focus:outline-none focus:ring-2 focus:ring-accent/30' : '',
    className,
  );

  const content = (
    <>
      {item.thumbnailUrl ? (
        <img
          src={item.thumbnailUrl}
          alt=""
          className="h-32 w-full rounded-md object-cover"
        />
      ) : (
        <div className="flex h-32 w-full items-center justify-center rounded-md bg-surface-2 text-muted">
          No thumbnail
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className={cn('rounded px-2 py-0.5 text-xs font-medium', badgeClass)}>
          {item.type}
        </span>
      </div>
      <div className="font-medium text-ink-1">{item.title}</div>
      {item.description ? (
        <div className="line-clamp-2 text-sm text-muted">{item.description}</div>
      ) : null}
      <div className="text-xs text-muted">
        Updated {new Date(item.updatedAt).toLocaleDateString()}
      </div>
    </>
  );

  if (href) {
    return (
      <a href={href} className={baseClass}>
        {content}
      </a>
    );
  }
  return <div className={baseClass}>{content}</div>;
}
