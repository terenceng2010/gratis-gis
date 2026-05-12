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
import { createContext, useEffect, useRef, useState } from 'react';
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

/**
 * AppBarContext signals to descendant widgets that they're being
 * rendered inside an app-bar (vs. inline on the page grid). Tool
 * widgets check this so they can swap their raised white-pill
 * treatment for a flat, header-colored treatment — the difference
 * between a "button that floats on a page" and an "icon link in a
 * navy nav bar".
 */
export const AppBarContext = createContext<boolean>(false);

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

  // Variant styling map. 'elevated' is the default branded bar
  // using --app-header-* tokens so each theme stamps its own
  // identity at the top (Forest green, Slate near-black, Paper
  // black, Aurora teal). 'glass' stays translucent over the body
  // surface for map-first layouts (good when the author wants the
  // map to read as the dominant surface). 'flat' is borderless on
  // surface-1 for sparse, content-first apps.
  const variantClass =
    variant === 'glass'
      ? 'bg-[hsl(var(--app-surface-1)/0.7)] backdrop-blur supports-[backdrop-filter]:bg-[hsl(var(--app-surface-1)/0.6)] border-b border-[hsl(var(--app-border)/0.6)] text-[hsl(var(--app-ink-0))]'
      : variant === 'flat'
        ? 'bg-[hsl(var(--app-surface-1))] text-[hsl(var(--app-ink-0))]'
        : 'bg-[hsl(var(--app-header-bg))] text-[hsl(var(--app-header-ink))] border-b border-[hsl(var(--app-header-border))] shadow-[var(--app-shadow-card)]';

  // Whether this variant renders on the branded header surface
  // (elevated default). When true, child text uses header ink for
  // contrast against the header background; otherwise it stays on
  // body-ink tokens.
  const onHeaderSurface = variant !== 'glass' && variant !== 'flat';
  const titleInkClass = onHeaderSurface
    ? 'text-[hsl(var(--app-header-ink))]'
    : 'text-[hsl(var(--app-ink-0))]';
  const subtitleInkClass = onHeaderSurface
    ? 'text-[hsl(var(--app-header-muted))]'
    : 'text-[hsl(var(--app-muted))]';

  return (
    <AppBarContext.Provider value={onHeaderSurface}>
      <header
        className={`flex h-full w-full items-center gap-3 px-4 ${variantClass} ${
          sticky ? 'sticky top-0 z-10' : ''
        }`}
      >
        {/* Left: logo + title block. Logo is optional; title is the
            primary label. Subtitle stacks under the title for a
            two-line hero treatment when the author wants context.
            The inner block uses `flex flex-col justify-center` so a
            single-line title is vertically centered against the bar
            rather than baseline-pinned to the top. */}
        <div className="flex min-w-0 items-center gap-3 self-stretch">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
              alt=""
              className="h-7 w-7 shrink-0 self-center rounded object-contain"
            />
          ) : null}
          {title || subtitle ? (
            <div className="flex min-w-0 flex-col justify-center">
              {title ? (
                <p
                  className={`truncate text-base font-semibold leading-tight ${titleInkClass}`}
                >
                  {title}
                </p>
              ) : null}
              {subtitle ? (
                <p className={`truncate text-xs leading-tight ${subtitleInkClass}`}>
                  {subtitle}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Right: children flex row. Each child renders flat (no
            raised pill) so the bar reads as a coherent banner. Tool
            widgets inside this provider see AppBarContext=true and
            switch from white-pill to flat header-ink treatment. */}
        <div className="flex flex-1 items-stretch justify-end gap-1">
          {config.widgets.map((child) => (
            <div
              key={child.id}
              className="flex shrink-0 items-stretch"
              data-app-bar-child
            >
              {renderChild(child)}
            </div>
          ))}
        </div>
      </header>
    </AppBarContext.Provider>
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
  const [collapsed, setCollapsed] = useState(config.defaultCollapsed ?? false);
  const side = config.side;
  const title = config.title;

  // The dock fills its grid cell. config.widthPx is treated as a
  // designer-time hint (what colSpan the template chose to match);
  // at runtime the grid layout is the source of truth so an
  // author who picks a wider colSpan gets a wider dock with no
  // empty stripe between the dock and the canvas (the previous
  // pixel-fixed `width` left a gap whenever the grid cell was
  // wider than 280px). Collapsed state keeps the panel surface
  // visible but hides the body so the user still sees a coherent
  // panel rather than a hollow strip of page background.
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
      className={`relative flex h-full w-full shrink-0 flex-col overflow-hidden bg-[hsl(var(--app-surface-1))] ${borderSide} border-[hsl(var(--app-border))]`}
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
