// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Generic container widget renderer.  ONE component handles every
 * container behavior (sticky top/bottom bar, side dock, overlay
 * drawer, inline region) by reading the container's `position`,
 * `variant`, `layout`, and `collapsible` props.  Replaces the
 * earlier AppBar / DockPanel / Slideout / FoldableGroup family
 * (#92) which baked slot-style chrome into separate widget kinds.
 *
 * The container holds an array of full CustomWidget children and
 * passes each to the caller-supplied `renderChild` function.  The
 * container's own `layout` prop controls how children flow (row vs
 * column) inside the body; everything else (background, sticky
 * anchoring, collapse affordance, trigger button) is chrome
 * provided by this component.
 *
 * Theme tokens (--app-surface-*, --app-header-*, --app-accent,
 * --app-radius, --app-shadow-card, etc.) drive the visual treatment
 * so the same container looks coherent across the theme presets.
 */
import { createContext, useState } from 'react';
import type { CSSProperties } from 'react';
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
  ContainerWidgetConfig,
  CustomWidget,
} from '@gratis-gis/shared-types';

/**
 * The runtime + designer pass the renderer a `RenderChild` function
 * so the container doesn't have to import the full widget renderer
 * registry directly (and so the designer can swap in a design-time
 * preview for children without touching this file).
 */
export type RenderChild = (child: CustomWidget) => React.ReactNode;

/**
 * Signals to descendant widgets that they're being rendered inside
 * a container with branded-header chrome (variant='elevated' on a
 * sticky-top / sticky-bottom container).  Tool widgets check this
 * so they can swap their raised white-pill treatment for a flat,
 * header-colored treatment: the difference between a "button that
 * floats on a page" and an "icon link in a navy nav bar".  Renamed
 * from AppBarContext (#92); kept as a single boolean so existing
 * consumers don't need a new shape.
 */
export const AppBarContext = createContext<boolean>(false);

interface ContainerRenderProps {
  config: ContainerWidgetConfig;
  renderChild: RenderChild;
}

/**
 * Resolve the effective defaults for a container's chrome props.
 * Centralizes the "what does position X imply" rules so the renderer
 * branches stay tight.
 */
function resolveChrome(config: ContainerWidgetConfig) {
  const position = config.position ?? 'inline';
  const variant =
    config.variant ??
    (position === 'sticky-top' ||
    position === 'sticky-bottom' ||
    position === 'dock-left' ||
    position === 'dock-right' ||
    position === 'overlay-trigger'
      ? 'elevated'
      : 'flat');
  const layout =
    config.layout ??
    (position === 'sticky-top' || position === 'sticky-bottom'
      ? 'row'
      : 'column');
  return { position, variant, layout };
}

/**
 * Map a container's `variant` to its chrome class set.  Same
 * vocabulary across every position so an 'elevated' sticky top bar
 * and an 'elevated' overlay drawer share the same header surface
 * tokens.
 */
function variantClasses(variant: ContainerWidgetConfig['variant']): string {
  if (variant === 'glass') {
    return 'bg-[hsl(var(--app-surface-1)/0.7)] backdrop-blur supports-[backdrop-filter]:bg-[hsl(var(--app-surface-1)/0.6)] border-b border-[hsl(var(--app-border)/0.6)] text-[hsl(var(--app-ink-0))]';
  }
  if (variant === 'flat') {
    return 'bg-[hsl(var(--app-surface-1))] text-[hsl(var(--app-ink-0))]';
  }
  if (variant === 'none') {
    return 'bg-transparent text-[hsl(var(--app-ink-0))]';
  }
  // 'elevated' (default).  Branded header surface.
  return 'bg-[hsl(var(--app-header-bg))] text-[hsl(var(--app-header-ink))] border-b border-[hsl(var(--app-header-border))] shadow-[var(--app-shadow-card)]';
}

/**
 * Single Container renderer.  Dispatches on `position` to the right
 * sub-renderer.  Inline / sticky-top / sticky-bottom render as the
 * same flow container with different anchoring; dock-left /
 * dock-right render as a side panel with collapse-to-rail;
 * overlay-trigger renders a hidden drawer with a trigger button.
 */
export function Container({ config, renderChild }: ContainerRenderProps) {
  const { position, variant, layout } = resolveChrome(config);

  if (position === 'dock-left' || position === 'dock-right') {
    return (
      <DockContainer
        config={config}
        renderChild={renderChild}
        variant={variant}
        layout={layout}
        side={position === 'dock-left' ? 'left' : 'right'}
      />
    );
  }
  if (position === 'overlay-trigger') {
    return (
      <OverlayContainer
        config={config}
        renderChild={renderChild}
        variant={variant}
        layout={layout}
      />
    );
  }
  // sticky-top / sticky-bottom / inline.  Same flow region, just
  // different anchoring + (for inline) no anchoring at all.
  return (
    <FlowContainer
      config={config}
      renderChild={renderChild}
      variant={variant}
      layout={layout}
      position={position}
    />
  );
}

// ---- Flow container (inline / sticky-top / sticky-bottom) -------

interface FlowProps extends ContainerRenderProps {
  variant: NonNullable<ContainerWidgetConfig['variant']>;
  layout: NonNullable<ContainerWidgetConfig['layout']>;
  position: 'inline' | 'sticky-top' | 'sticky-bottom';
}

function FlowContainer({
  config,
  renderChild,
  variant,
  layout,
  position,
}: FlowProps) {
  const collapsible = config.collapsible === true;
  const [collapsed, setCollapsed] = useState(
    config.defaultCollapsed === true,
  );
  const inBrandedHeader =
    variant === 'elevated' &&
    (position === 'sticky-top' || position === 'sticky-bottom');
  const chromeClass = variantClasses(variant);
  const stickyClass =
    position === 'sticky-top'
      ? 'sticky top-0 z-10'
      : position === 'sticky-bottom'
        ? 'sticky bottom-0 z-10'
        : '';
  const heightStyle: CSSProperties =
    typeof config.heightPx === 'number' ? { height: config.heightPx } : {};

  // #99: free-position children.  Row-layout containers (sticky-top
  // toolbars, etc.) put each child at layout.col along the bar:
  // col 1 = left edge, col 192 = right edge, col 96 ~= center.
  // Column-layout containers do the same with layout.row.  This
  // lets the user drag a single tool to the right (or anywhere)
  // without having to flex-pack everything.
  //
  // Backwards compat: when every child has col=1 (the historical
  // placeholder default), we auto-spread them evenly so existing
  // apps render the same way they did under the old flex-pack
  // model.  The first drag persists explicit cols and from then
  // on positions are literal.  The migration step in shared-types
  // (migrateCustomAppData) writes spread cols on load so the data
  // and visuals match without relying on this fallback long-term.
  const isRow = layout === 'row';
  const axisKey: 'col' | 'row' = isRow ? 'col' : 'row';
  const children = config.widgets;
  const allAtOrigin =
    children.length > 0 &&
    children.every((c) => (c.layout[axisKey] ?? 1) === 1);
  function childPos(child: { layout: { col: number; row: number } }, idx: number): CSSProperties {
    if (allAtOrigin && children.length > 1) {
      // Even-spread fallback: place child[i] at i/(n-1) of the axis,
      // so the first sticks to the start and the last to the end.
      const pct = (idx / (children.length - 1)) * 100;
      return isRow
        ? { position: 'absolute', left: `${pct}%`, top: 0, bottom: 0 }
        : { position: 'absolute', top: `${pct}%`, left: 0, right: 0 };
    }
    if (allAtOrigin) {
      // Single child: just anchor it to the start.
      return isRow
        ? { position: 'absolute', left: 0, top: 0, bottom: 0 }
        : { position: 'absolute', top: 0, left: 0, right: 0 };
    }
    const v = (child.layout[axisKey] ?? 1) - 1;
    const pct = (v / 191) * 100;
    return isRow
      ? { position: 'absolute', left: `${pct}%`, top: 0, bottom: 0 }
      : { position: 'absolute', top: `${pct}%`, left: 0, right: 0 };
  }

  // Collapsed inline / sticky containers fold their children behind
  // a chevron handle; the chrome region stays visible so the handle
  // is reachable.  For row-layout containers (toolbars), collapse
  // doesn't make much physical sense — the handle still works but
  // the practical use is column-layout accordion sections.
  return (
    <AppBarContext.Provider value={inBrandedHeader}>
      <div
        className={`flex h-full w-full ${chromeClass} ${stickyClass}`}
        style={heightStyle}
      >
        {collapsible ? (
          <header className="flex shrink-0 items-center self-start px-2 py-1">
            <button
              type="button"
              onClick={() => setCollapsed((v) => !v)}
              aria-label={collapsed ? 'Expand container' : 'Collapse container'}
              aria-expanded={!collapsed}
              className="inline-flex h-7 w-7 items-center justify-center rounded text-[hsl(var(--app-muted))] hover:bg-[hsl(var(--app-surface-2))] hover:text-[hsl(var(--app-ink-0))]"
            >
              {collapsed ? (
                <ChevronRightIcon className="h-3.5 w-3.5" />
              ) : (
                <ChevronDownIcon className="h-3.5 w-3.5" />
              )}
            </button>
          </header>
        ) : null}
        <div
          className="relative min-h-0 min-w-0 flex-1 px-4 py-1"
          style={collapsed ? { display: 'none' } : undefined}
          aria-hidden={collapsed}
        >
          {children.map((child, idx) => (
            <div
              key={child.id}
              className="flex items-stretch"
              style={childPos(child, idx)}
              data-container-child
            >
              {renderChild(child)}
            </div>
          ))}
        </div>
      </div>
    </AppBarContext.Provider>
  );
}

// ---- Dock container (dock-left / dock-right) -------------------

interface DockProps extends ContainerRenderProps {
  variant: NonNullable<ContainerWidgetConfig['variant']>;
  layout: NonNullable<ContainerWidgetConfig['layout']>;
  side: 'left' | 'right';
}

function DockContainer({
  config,
  renderChild,
  variant,
  side,
}: DockProps) {
  const collapsible = config.collapsible !== false;
  const widthPx = config.widthPx ?? 280;
  const [collapsed, setCollapsed] = useState(
    config.defaultCollapsed === true,
  );

  // The dock controls its own width.  When collapsed, shrinks to a
  // 44px rail so the canvas grid takes the freed space automatically.
  const effectiveWidth = collapsed ? 44 : widthPx;
  const borderSide = side === 'left' ? 'border-r' : 'border-l';
  const chromeClass = variantClasses(variant);
  // Strip the bottom border the variantClasses adds (it's meant for
  // top bars); a side dock wants its border on the inner edge only.
  const dockChromeClass = chromeClass
    .replace('border-b', '')
    .replace('border-[hsl(var(--app-header-border))]', '');

  return (
    <aside
      className={`relative flex h-full shrink-0 flex-col overflow-hidden ${dockChromeClass} ${borderSide} border-[hsl(var(--app-border))]`}
      style={{ width: effectiveWidth, transition: 'width 160ms ease-out' }}
    >
      {collapsible ? (
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-[hsl(var(--app-border))] px-2">
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
        </header>
      ) : null}

      {/* Body: children stack vertically with a divider between
          siblings.  Stays mounted when collapsed so per-instance
          state survives collapse + re-expand; visibility hidden so
          the rail width is the only thing visible. */}
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        style={collapsed ? { visibility: 'hidden' } : undefined}
        aria-hidden={collapsed}
      >
        <div className="divide-y divide-[hsl(var(--app-border)/0.6)]">
          {config.widgets.map((child) => (
            <div key={child.id} className="p-2" data-container-child>
              {renderChild(child)}
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

// ---- Overlay container (overlay-trigger) -----------------------

interface OverlayProps extends ContainerRenderProps {
  variant: NonNullable<ContainerWidgetConfig['variant']>;
  layout: NonNullable<ContainerWidgetConfig['layout']>;
}

function OverlayContainer({ config, renderChild }: OverlayProps) {
  const [open, setOpen] = useState(false);
  const edge = config.edge ?? 'left';
  const sizePx =
    edge === 'left' || edge === 'right'
      ? config.widthPx ?? 320
      : config.heightPx ?? 320;
  const triggerLabel = config.triggerLabel ?? 'Tools';
  const Icon =
    config.triggerIcon === 'layers'
      ? LayersIcon
      : config.triggerIcon === 'filter'
        ? FilterIcon
        : config.triggerIcon === 'menu'
          ? MenuIcon
          : WrenchIcon;

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
  const drawerSizeStyle: CSSProperties =
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
      {/* Trigger pill always visible. */}
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

      {/* Drawer panel.  Stays mounted so per-instance state survives
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
              <div key={child.id} className="p-2" data-container-child>
                {renderChild(child)}
              </div>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}
