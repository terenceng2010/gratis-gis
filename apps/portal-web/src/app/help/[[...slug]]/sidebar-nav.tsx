// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Recursive sidebar navigation for the help system.  Categories
 * are collapsible (default open if the active doc lives inside);
 * leaves are links.  Pure client component so collapse state
 * doesn't round-trip to the server on every interaction.
 */
import Link from 'next/link';
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface NavNode {
  label: string;
  slug?: string;
  children: NavNode[];
}

export function HelpSidebarNav({
  nav,
  activeSlug,
}: {
  nav: NavNode;
  activeSlug: string;
}) {
  return (
    <ul className="space-y-0.5 text-xs">
      {nav.children.map((c, i) => (
        <NavRow
          key={`${c.label}-${i}`}
          node={c}
          activeSlug={activeSlug}
          depth={0}
        />
      ))}
    </ul>
  );
}

function NavRow({
  node,
  activeSlug,
  depth,
}: {
  node: NavNode;
  activeSlug: string;
  depth: number;
}) {
  const isLeaf = !!node.slug;
  // Auto-open categories that contain the active doc.  Walks
  // children recursively; cheap because the tree is tiny.
  const containsActive = containsSlug(node, activeSlug);
  const [open, setOpen] = useState<boolean>(containsActive || depth === 0);
  const isActive = isLeaf && node.slug === activeSlug;
  const indent = depth * 12;
  if (isLeaf) {
    return (
      <li>
        <Link
          href={`/help/${node.slug}`}
          className={`block rounded px-2 py-1 ${
            isActive
              ? 'bg-accent/10 font-medium text-accent'
              : 'text-ink-1 hover:bg-surface-2'
          }`}
          style={{ paddingLeft: `${8 + indent}px` }}
        >
          {node.label}
        </Link>
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 rounded px-2 py-1 text-left font-medium text-ink-0 hover:bg-surface-2"
        style={{ paddingLeft: `${4 + indent}px` }}
      >
        {open ? (
          <ChevronDown className="h-3 w-3 text-muted" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted" />
        )}
        <span>{node.label}</span>
      </button>
      {open && node.children.length > 0 ? (
        <ul className="space-y-0.5">
          {node.children.map((c, i) => (
            <NavRow
              key={`${c.label}-${i}`}
              node={c}
              activeSlug={activeSlug}
              depth={depth + 1}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function containsSlug(node: NavNode, slug: string): boolean {
  if (node.slug === slug) return true;
  for (const c of node.children) {
    if (containsSlug(c, slug)) return true;
  }
  return false;
}
