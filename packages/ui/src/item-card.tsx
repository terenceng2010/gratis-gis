import type { Item } from '@gratis-gis/shared-types';
import { cn } from './cn.js';

export interface ItemCardProps {
  item: Pick<Item, 'id' | 'title' | 'description' | 'type' | 'thumbnailUrl' | 'updatedAt'>;
  onClick?: (id: Item['id']) => void;
  className?: string;
}

const typeBadgeColor: Record<string, string> = {
  'web-map': 'bg-emerald-100 text-emerald-800',
  'feature-service': 'bg-sky-100 text-sky-800',
  form: 'bg-violet-100 text-violet-800',
  'web-app': 'bg-amber-100 text-amber-800',
  'report-template': 'bg-rose-100 text-rose-800',
  dashboard: 'bg-indigo-100 text-indigo-800',
  file: 'bg-slate-100 text-slate-800',
};

export function ItemCard({ item, onClick, className }: ItemCardProps) {
  const badgeClass = typeBadgeColor[item.type] ?? 'bg-slate-100 text-slate-800';
  return (
    <button
      type="button"
      onClick={() => onClick?.(item.id)}
      className={cn(
        'flex w-full flex-col gap-2 rounded-lg border border-slate-200 bg-white p-4 text-left shadow-sm transition-shadow hover:shadow-md',
        className,
      )}
    >
      {item.thumbnailUrl ? (
        <img
          src={item.thumbnailUrl}
          alt=""
          className="h-32 w-full rounded-md object-cover"
        />
      ) : (
        <div className="flex h-32 w-full items-center justify-center rounded-md bg-slate-50 text-slate-400">
          No thumbnail
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className={cn('rounded px-2 py-0.5 text-xs font-medium', badgeClass)}>
          {item.type}
        </span>
      </div>
      <div className="font-medium text-slate-900">{item.title}</div>
      {item.description ? (
        <div className="line-clamp-2 text-sm text-slate-600">{item.description}</div>
      ) : null}
      <div className="text-xs text-slate-400">
        Updated {new Date(item.updatedAt).toLocaleDateString()}
      </div>
    </button>
  );
}
