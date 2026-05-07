// SPDX-License-Identifier: AGPL-3.0-or-later
/** Loading skeletons shown during data fetches instead of spinners. */
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-md bg-surface-2 ${className}`}
      aria-hidden="true"
    />
  );
}

export function CardSkeleton() {
  return (
    <div className="rounded-lg border border-border bg-surface-1 p-4 shadow-card">
      <Skeleton className="h-32 w-full" />
      <Skeleton className="mt-3 h-4 w-1/3" />
      <Skeleton className="mt-2 h-5 w-3/4" />
      <Skeleton className="mt-2 h-4 w-full" />
    </div>
  );
}
