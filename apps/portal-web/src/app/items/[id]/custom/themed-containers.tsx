// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Themed-app container widgets. Each container holds an array of
 * child CustomWidgets and renders them inside opinionated themed
 * chrome — a top app bar, a side dock, a slideout drawer, a
 * foldable group. These are the building blocks that let an author
 * make an app look like one cohesive product instead of a pile of
 * floating widget boxes.
 *
 * Containers are deliberately not "generic flex containers". Each
 * has opinions about how children stack (row vs column), spacing
 * between siblings, dividers, collapse affordances, etc. The
 * theme tokens (--app-surface-*, --app-accent, --app-radius,
 * --app-shadow-card, --app-density) drive the visual treatment so
 * the same container looks coherent across themes.
 *
 * Children are full CustomWidget instances — the same kinds the
 * page grid uses. A template is just a CustomAppData with
 * containers already laid out and children dropped inside; an
 * advanced-mode author can rearrange + add + remove without
 * touching a separate framework.
 */
import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown as ChevronDownIcon,
  ChevronRight as ChevronRightIcon,
  Filter as FilterIcon,
  Layers as LayersIcon,
  Menu as MenuIcon,
  X as XIcon,
  Wrench as WrenchIcon,
} from 'lucide-react';
import type {
  AppBarWidgetConfig,
  CustomWidget,
  DockPanelWidgetConfig,
  FoldableGroupWidgetConfig,
  SlideoutWidgetConfig,
} from '@gratis-gis/shared-types';

/**
 * The runtime + designer pass these renderers a `RenderChild`
 * function so the container doesn't have to import the full widget
 * renderer registry directly (and so the designer can swap in a
 * design-time preview for children without touching this file).
 */
export type RenderChild = (child: CustomWidget) => React.ReactNode;

// ---- App bar ----------------------------------------------------

interface AppBarRenderProps {
  config: AppBarWidgetConfig;
  /** Fallback title (e.g., the item's own title) when config.title
   *  is empty. */
  fallbackTitle?: string;
  /** Logo URL fallback (e.g., the org's branding logo) when
   *  config.logoUrl is empty. */
  fallbackLogoUrl?: string;
  renderChild: RenderChild;
}

/**
 * Top app bar. Sticky by default; renders logo + title block on the
 * left, children as a flex row on the right (which is the
 * convention for action bars in nearly every app shell).
 */
export function AppBar({
  config,
  fallbackTitle,
  fallbackLogoUrl,
  renderChild,
}: AppBarRenderProps) {
  const sticky = config.sticky !== false;
  const variant = config.variant ?? 'elevated';
  const title = config.title ?? fallbackTitle ?? '';
  const subtitle = config.subtitle;
  const logoUrl = config.logoUrl ?? fallbackLogoUrl;

  // Variant styling map. 'elevated' is the default solid bar with a
  // subtle bottom border; 'glass' is translucent with backdrop blur
  // for map-first layouts; 'flat' is borderless flush.
  const variantClass =
    variant === 'glass'
      ? 'bg-[hsl(var(--app-surface-1)/0.7)] backdrop-blur supports-[backdrop-filter]:bg-[hsl(var(--app-surface-1)/0.6)] border-b border-[hsl(var(--app-border)/0.6)]'
      : variant === 'flat'
        ? 'bg-[hsl(var(--app-surface-1))]'
        : 'bg-[hsl(var(--app-surface-1))] border-b border-[hsl(var(--app-border))] shadow-[var(--app-shadow-card)]';

  return (
    <header
      className={`flex h-full w-full items-center gap-3 px-4 ${variantClass} ${
        sticky ? 'sticky top-0 z-10' : ''
      }`}
      style={{ minHeight: 48 }}
    >
      {/* Left: logo + title block. Logo is optional; title is the
          primary label. Subtitle stacks under the title for a
          two-line hero treatment when the author wants context. */}
      <div className="flex min-w-0 items-center gap-3">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logoUrl}
            alt=""
            className="h-7 w-7 shrink-0 rounded object-contain"
          />
        ) : null}
        {title || subtitle ? (
          <div className="min-w-0">
            {title ? (
              <p className="truncate text-base font-semibold leading-tight text-[hsl(var(--app-ink-0))]">
                {title}
              </p>
            ) : null}
            {subtitle ? (
              <p className="truncate text-xs text-[hsl(var(--app-muted))]">
                {subtitle}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Right: children flex row. Spacing comes from the container,
          not the children, so individual widgets don't need to know
          they're in a bar. The grow spacer pushes content right; if
          the author wants a left-anchored item they can drop a
          spacer widget after the desired child. */}
      <div className="flex flex-1 items-center justify-end gap-2">
        {config.widgets.map((child) => (
          <div
            key={child.id}
            className="flex shrink-0 items-center"
            // Inline children render their own chrome but the bar
            // overrides any rounded-card frame they'd normally
            // bring (tool buttons want a flat bar treatment).
            data-app-bar-child
          >
            {renderChild(child)}
          </div>
        ))}
      </div>
    </header>
  );
}

// ---- Dock panel -------------------------------------------------

interface DockPanelRenderProps {
  config: DockPanelWidgetConfig;
  renderChild: RenderChild;
}

/**
 * Side dock panel. Always-open when `collapsible=false`; otherwise
 * shows a collapse handle that shrinks the panel to a 40px icon
 * rail. The rail icons come from each child widget's kind-specific
 * icon registry; clicking the rail expands the panel.
 */
export function DockPanel({ config, renderChild }: DockPanelRenderProps) {
  const collapsible = config.collapsible !== false;
  const widthPx = config.widthPx ?? 280;
  const [collapsed, setCollapsed] = useState(config.defaultCollapsed ?? false);
  const side = config.side;
  const title = config.title;

  const effectiveWidth = collapsed ? 44 : widthPx;
  const borderSide = side === 'left' ? 'border-r' : 'border-l';
  // When the dock has no title configured, the header degrades to a
  // bare collapse-handle row — author opted into "let the children
  // (foldable groups, etc.) label themselves", so we don't stamp a
  // redundant wrapping label like the older "Map tools" treatment.
  // When `collapsible=false` AND no title is set, the header drops
  // out entirely so the dock is just its body.
  const hasTitle = Boolean(title && title.trim().length > 0);
  const showHeader = hasTitle || collapsible;

  return (
    <aside
      className={`relative flex h-full shrink-0 flex-col overflow-hidden bg-[hsl(var(--app-surface-1))] ${borderSide} border-[hsl(var(--app-border))]`}
      style={{ width: effectiveWidth, transition: 'width 160ms ease-out' }}
    >
      {showHeader ? (
        // Header: optional title + collapse handle. When collapsed,
        // the handle becomes the only interactive surface; clicking
        // expands. When `hasTitle=false`, the row contains just the
        // collapse button right-aligned so the children butt right
        // against the top edge with no chrome between them.
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-[hsl(var(--app-border))] px-2">
          {hasTitle && !collapsed ? (
            <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-[hsl(var(--app-muted))]">
              {title}
            </span>
          ) : null}
          {collapsible ? (
            <button
              type="button"
              onClick={() => setCollapsed((v) => !v)}
              aria-label={collapsed ? 'Expand panel' : 'Collapse panel'}
              aria-expanded={!collapsed}
              className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded text-[hsl(var(--app-muted))] hover:bg-[hsl(var(--app-surface-2))] hover:text-[hsl(var(--app-ink-0))]"
            >
              {side === 'left' ? (
                collapsed ? (
                  <ChevronRightIcon className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDownIcon className="h-3.5 w-3.5 rotate-90" />
                )
              ) : collapsed ? (
                <ChevronRightIcon className="h-3.5 w-3.5 rotate-180" />
              ) : (
                <ChevronDownIcon className="h-3.5 w-3.5 -rotate-90" />
              )}
            </button>
          ) : null}
        </header>
      ) : null}

      {/* Body: children stack vertically with a divider between
          siblings. When collapsed, only the kind icons render; the
          body content stays mounted so per-instance state survives
          collapse + re-expand. */}
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        style={collapsed ? { visibility: 'hidden' } : undefined}
        aria-hidden={collapsed}
      >
        <div className="divide-y divide-[hsl(var(--app-border)/0.6)]">
          {config.widgets.map((child) => (
            <div key={child.id} className="p-2" data-dock-panel-child>
              {renderChild(child)}
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

// ---- Slideout drawer --------------------------------------------

interface SlideoutRenderProps {
  config: SlideoutWidgetConfig;
  renderChild: RenderChild;
}

/**
 * Slideout drawer. Hidden by default; opens via a trigger button
 * stamped at the configured edge of the parent. Used for "tools"
 * drawers that the author doesn't want to take permanent space.
 */
export function Slideout({ config, renderChild }: SlideoutRenderProps) {
  const [open, setOpen] = useState(false);
  const edge = config.edge;
  const sizePx = config.sizePx ?? 320;
  const triggerLabel = config.triggerLabel ?? 'Tools';
  const Icon =
    config.triggerIcon === 'layers'
      ? LayersIcon
      : config.triggerIcon === 'filter'
        ? FilterIcon
        : config.triggerIcon === 'menu'
          ? MenuIcon
          : WrenchIcon;

  // Trigger anchored on the parent's edge. Drawer panel slides in
  // from the same edge when open. Both share the same root so the
  // container's grid placement positions everything correctly.
  const triggerPositionClass =
    edge === 'left'
      ? 'left-2 top-1/2 -translate-y-1/2'
      : edge === 'right'
        ? 'right-2 top-1/2 -translate-y-1/2'
        : edge === 'top'
          ? 'top-2 left-1/2 -translate-x-1/2'
          : 'bottom-2 left-1/2 -translate-x-1/2';
  const drawerPositionClass =
    edge === 'left'
      ? 'left-0 top-0 h-full'
      : edge === 'right'
        ? 'right-0 top-0 h-full'
        : edge === 'top'
          ? 'top-0 left-0 w-full'
          : 'bottom-0 left-0 w-full';
  const drawerSizeStyle: React.CSSProperties =
    edge === 'left' || edge === 'right'
      ? { width: sizePx }
      : { height: sizePx };
  const drawerTransform =
    !open && edge === 'left'
      ? 'translate-x-[-100%]'
      : !open && edge === 'right'
        ? 'translate-x-[100%]'
        : !open && edge === 'top'
          ? 'translate-y-[-100%]'
          : !open && edge === 'bottom'
            ? 'translate-y-[100%]'
            : 'translate-x-0 translate-y-0';

  return (
    <div className="pointer-events-none absolute inset-0">
      {/* Trigger pill always visible; turns into the close button
          when the drawer is open. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`pointer-events-auto absolute z-20 inline-flex items-center gap-1.5 rounded-full border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] px-3 py-1.5 text-xs font-medium text-[hsl(var(--app-ink-0))] shadow-[var(--app-shadow-card)] transition-colors hover:bg-[hsl(var(--app-surface-2))] ${triggerPositionClass}`}
        aria-expanded={open}
        aria-label={open ? `Close ${triggerLabel}` : `Open ${triggerLabel}`}
      >
        <Icon className="h-3.5 w-3.5 text-[hsl(var(--app-muted))]" />
        {triggerLabel}
      </button>

      {/* Drawer panel. Stays mounted so per-instance state survives
          open/close; off-screen when closed via translate transform. */}
      <aside
        className={`pointer-events-auto absolute z-10 flex flex-col overflow-hidden border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))] shadow-[var(--app-shadow-overlay)] transition-transform duration-200 ease-out ${drawerPositionClass} ${drawerTransform} ${
          edge === 'left' || edge === 'right' ? 'border-l border-r' : 'border-t border-b'
        }`}
        style={drawerSizeStyle}
        aria-hidden={!open}
      >
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-[hsl(var(--app-border))] px-3">
          <Icon className="h-3.5 w-3.5 text-[hsl(var(--app-muted))]" />
          <span className="flex-1 truncate text-sm font-semibold text-[hsl(var(--app-ink-0))]">
            {triggerLabel}
          </span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close drawer"
            className="rounded p-1 text-[hsl(var(--app-muted))] hover:bg-[hsl(var(--app-surface-2))] hover:text-[hsl(var(--app-ink-0))]"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="divide-y divide-[hsl(var(--app-border)/0.6)]">
            {config.widgets.map((child) => (
              <div key={child.id} className="p-2" data-slideout-child>
                {renderChild(child)}
              </div>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}

// ---- Foldable group --------------------------------------------

interface FoldableGroupRenderProps {
  config: FoldableGroupWidgetConfig;
  renderChild: RenderChild;
}

/**
 * Foldable group. Header with chevron; clicking toggles the
 * children. Useful for nesting groups of related controls inside a
 * dock panel or slideout so a deep tool tree fits in a small side.
 */
export function FoldableGroup({
  config,
  renderChild,
}: FoldableGroupRenderProps) {
  const [open, setOpen] = useState(config.defaultOpen !== false);
  return (
    <section className="flex w-full flex-col overflow-hidden rounded-[var(--app-radius)] border border-[hsl(var(--app-border))] bg-[hsl(var(--app-surface-1))]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[hsl(var(--app-surface-2))]"
      >
        <span className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-[hsl(var(--app-ink-0))]">
            {config.title}
          </p>
          {config.subtitle ? (
            <p className="truncate text-xs text-[hsl(var(--app-muted))]">
              {config.subtitle}
            </p>
          ) : null}
        </span>
        {open ? (
          <ChevronDownIcon className="h-4 w-4 text-[hsl(var(--app-muted))]" />
        ) : (
          <ChevronRightIcon className="h-4 w-4 text-[hsl(var(--app-muted))]" />
        )}
      </button>
      {open ? (
        <div className="border-t border-[hsl(var(--app-border)/0.6)]">
          <div className="divide-y divide-[hsl(var(--app-border)/0.6)]">
            {config.widgets.map((child) => (
              <div key={child.id} className="p-2" data-foldable-child>
                {renderChild(child)}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
