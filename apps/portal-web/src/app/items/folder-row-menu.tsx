// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ExternalLink,
  FolderPlus,
  MoreVertical,
  Share2,
  Trash2,
} from 'lucide-react';

import { useAlert, useConfirm } from '@/components/dialog-provider';

/**
 * Right-click + kebab menu attached to a folder row in the FolderRail.
 * Same items either way so keyboard / trackpad users without
 * secondary-click still get the affordance.
 *
 * Items:
 *   - Configure           -> /items/<folderId>
 *   - Share...            -> /items/<folderId>#sharing
 *   - New subfolder       -> inline edit row in the rail (#90)
 *   - Move to trash       -> DELETE /api/portal/items/<folderId>
 *
 * Trash is gated by canEdit; everything else is always visible.
 */
interface Props {
  folderId: string;
  folderTitle: string;
  canEdit: boolean;
  /**
   * #90: optional callback the rail wires up so "New subfolder"
   * pops an inline edit row anchored under this folder instead of
   * routing to the heavyweight /items/new wizard. When omitted the
   * menu falls back to the legacy wizard link so this component
   * still works in surfaces that haven't wired the inline path.
   */
  onCreateSubfolder?: (parentFolderId: string) => void;
}

export function FolderRowMenu({
  folderId,
  folderTitle,
  canEdit,
  onCreateSubfolder,
}: Props) {
  const router = useRouter();
  const confirm = useConfirm();
  const alert = useAlert();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);

  // Close on outside click / escape so the menu doesn't linger.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (
        wrapperRef.current &&
        e.target instanceof Node &&
        !wrapperRef.current.contains(e.target)
      ) {
        setOpen(false);
        setPos(null);
      }
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        setPos(null);
      }
    }
    window.addEventListener('mousedown', onDocClick);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('mousedown', onDocClick);
      window.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  function openAtPos(x: number, y: number) {
    setPos({ x, y });
    setOpen(true);
  }

  async function moveToTrash() {
    if (!canEdit) return;
    setBusy(true);
    try {
      // Fetch the cascade preview first (#156) so the confirm
      // dialog can list subfolders that will also be trashed.
      // Preview failure is non-fatal: we'll fall through with an
      // empty cascade and the api itself will refuse + 409 if a
      // cascade is actually required.
      let cascade: {
        folders: Array<{ id: string; title: string }>;
        unlinkedItemCount: number;
      } | null = null;
      try {
        const previewRes = await fetch(
          `/api/portal/items/${folderId}/delete-cascade`,
        );
        if (previewRes.ok) {
          cascade = await previewRes.json();
        }
      } catch {
        /* preview failed; continue with empty cascade */
      }

      const ok = await confirm({
        title: 'Move folder to trash?',
        message:
          cascade && cascade.folders.length > 0
            ? `Move "${folderTitle}" and the subfolders below to the recycle bin? Non-folder items inside stay where they are; only the folder arrangement is removed.`
            : `Move "${folderTitle}" to the recycle bin? The folder's contents stay where they are; only the folder arrangement is removed.`,
        confirmLabel: 'Move to trash',
        variant: 'danger',
        body:
          cascade && cascade.folders.length > 0 ? (
            <div className="rounded-md border border-danger/40 bg-danger/5 p-3 text-xs">
              <p className="font-medium text-ink-0">
                {cascade.folders.length === 1
                  ? '1 subfolder will also be moved to trash:'
                  : `${cascade.folders.length} subfolders will also be moved to trash:`}
              </p>
              <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-ink-1">
                {cascade.folders.slice(0, 12).map((f) => (
                  <li key={f.id}>{f.title}</li>
                ))}
                {cascade.folders.length > 12 ? (
                  <li className="text-muted">
                    ...and {cascade.folders.length - 12} more.
                  </li>
                ) : null}
              </ul>
              {cascade.unlinkedItemCount > 0 ? (
                <p className="mt-2 text-muted">
                  {cascade.unlinkedItemCount === 1
                    ? '1 other item inside will lose its folder reference, but the item itself stays.'
                    : `${cascade.unlinkedItemCount} other items inside will lose their folder reference, but the items themselves stay.`}
                </p>
              ) : null}
              <p className="mt-2 text-muted">
                Subfolders that are also filed under another folder
                will survive this delete and aren&rsquo;t listed.
              </p>
            </div>
          ) : null,
      });
      if (!ok) return;

      // Cascade=true on the URL only when the preview surfaced a
      // non-empty list. For the empty-cascade case (preview ok with
      // no subfolders, or preview failed) the api still does the
      // right thing -- it returns 200 on a no-cascade folder
      // delete, and 409 when a cascade is required.
      const needsCascade = (cascade?.folders.length ?? 0) > 0;
      const url = needsCascade
        ? `/api/portal/items/${folderId}?cascade=true`
        : `/api/portal/items/${folderId}`;
      const res = await fetch(url, { method: 'DELETE' });
      if (!res.ok) {
        await alert({
          tone: 'warn',
          title: 'Could not move to trash',
          message: `Move to trash failed: ${res.status}`,
        });
        return;
      }
      setOpen(false);
      setPos(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <span ref={wrapperRef} className="relative inline-flex">
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
          openAtPos(rect.right, rect.bottom);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          openAtPos(e.clientX, e.clientY);
        }}
        aria-label={`Actions for ${folderTitle}`}
        title="More actions"
        className="inline-flex h-5 w-5 items-center justify-center rounded text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-surface-1 hover:text-ink-1"
      >
        <MoreVertical className="h-3.5 w-3.5" />
      </button>

      {/* Right-click anywhere on the row also opens the menu; the
          parent FolderNode wires onContextMenu to this same handler
          via the imperative API below. */}

      {open && pos ? (
        <div
          role="menu"
          aria-label={`Actions for ${folderTitle}`}
          style={{
            position: 'fixed',
            left: pos.x,
            top: pos.y,
            zIndex: 50,
          }}
          className="min-w-[200px] overflow-hidden rounded-md border border-border bg-surface-1 py-1 text-sm shadow-raised"
        >
          <Link
            href={`/items/${folderId}`}
            onClick={() => {
              setOpen(false);
              setPos(null);
            }}
            role="menuitem"
            className="flex items-center gap-2 px-3 py-1.5 text-ink-1 hover:bg-surface-2"
          >
            <ExternalLink className="h-3.5 w-3.5 text-muted" />
            Configure
          </Link>
          <Link
            href={`/items/${folderId}#sharing`}
            onClick={() => {
              setOpen(false);
              setPos(null);
            }}
            role="menuitem"
            className="flex items-center gap-2 px-3 py-1.5 text-ink-1 hover:bg-surface-2"
          >
            <Share2 className="h-3.5 w-3.5 text-muted" />
            Share...
          </Link>
          {onCreateSubfolder ? (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setPos(null);
                onCreateSubfolder(folderId);
              }}
              role="menuitem"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ink-1 hover:bg-surface-2"
            >
              <FolderPlus className="h-3.5 w-3.5 text-muted" />
              New subfolder
            </button>
          ) : (
            // Fallback for surfaces that haven't wired the inline
            // path; preserves the legacy heavy-wizard flow.
            <Link
              href={`/items/new?type=folder&parentFolderId=${folderId}`}
              onClick={() => {
                setOpen(false);
                setPos(null);
              }}
              role="menuitem"
              className="flex items-center gap-2 px-3 py-1.5 text-ink-1 hover:bg-surface-2"
            >
              <FolderPlus className="h-3.5 w-3.5 text-muted" />
              New subfolder
            </Link>
          )}
          {canEdit ? (
            <>
              <div className="my-1 border-t border-border" />
              <button
                type="button"
                onClick={moveToTrash}
                disabled={busy}
                role="menuitem"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-danger hover:bg-danger/5 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {busy ? 'Trashing...' : 'Move to trash'}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}