// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Item thumbnail design + renderer (#66).
 *
 * Every item ships with a generated thumbnail.  The design is a small
 * JSON blob stored on the item; the rendered output is SVG returned by
 * a backend endpoint that the portal points its <img> tags at.  SVG
 * instead of baked PNG because:
 *
 *   - It scales perfectly at any card size.
 *   - It re-renders against current item state on every request, so a
 *     renamed item shows the new title immediately with zero re-bake.
 *   - It's tiny: under 2 KB per thumbnail vs 30-60 KB for a baked PNG.
 *   - No image-library dependency (sharp, node-canvas, satori) needs
 *     to live in the portal-api Docker image.
 *
 * Forced consistency: sidebar + title overlays are ALWAYS rendered.
 * There is no toggle to hide them.  That's the deliberate design
 * choice from the project memory: every thumbnail across the portal
 * follows the same visual grammar, and no author can bake a title
 * into a background image that then can't follow a rename.
 */
import type { ItemType } from './item-types';

export interface ThumbnailDesign {
  /** Schema version.  Bumped on any breaking change to the shape. */
  version: 1;
  /**
   * Background fill color as a CSS color string.  Hex, rgb(), or hsl()
   * all work.  Renders as the bottom layer; visible wherever the
   * background image (if any) leaves space and through the
   * semi-transparent sidebar / title bar overlays.
   */
  background: string;
  /**
   * Optional full-bleed background image, either an absolute URL or
   * a `data:` URL.  Renders above the background color and below
   * the sidebar + title-bar overlays.  Honors `backgroundOpacity`
   * so the underlying color can show through.
   */
  backgroundImage?: string | null;
  /**
   * Background image opacity (0..1).  Defaults to 1 (fully visible).
   * Lets the author fade the image so the chrome reads cleanly.
   */
  backgroundOpacity?: number;
  /** Sidebar strip fill color. */
  sidebar: string;
  /**
   * Sidebar fill opacity (0..1).  Defaults to 1.  Lower values let
   * the background bleed through, mimicking AGO's polished
   * thumbnail look.
   */
  sidebarOpacity?: number;
  /**
   * Optional override of the type-label text shown in the sidebar.
   * When null / missing the renderer falls back to whatever the
   * backend passes in (typically getItemTypeLabel(item.type)).
   * The override only changes the LABEL, never the layout.
   */
  sidebarLabelOverride?: string | null;
  /**
   * Title-bar fill color.  The title overlay sits across the bottom
   * of the canvas behind the item title text.  Defaults to the
   * sidebar color when unset so an author who only edits sidebar
   * still gets a coordinated palette.
   */
  titleBar?: string;
  /**
   * Title-bar fill opacity (0..1).  Defaults to ~0.85 so the title
   * stays legible while letting the background tease through.
   */
  titleBarOpacity?: number;
  /**
   * Optional logo image URL (absolute or `data:`).  Renders in the
   * top-right of the background area, above the title bar.  Null /
   * missing = no logo.
   */
  logo?: string | null;
}

/**
 * Per-item-type default colors used to seed a new item's thumbnail
 * design.  Sidebar drives the type-coded right-side strip and the
 * title-bar tint; background is a desaturated tint of the same hue
 * so the two work as a pair when there's no background image.
 */
const TYPE_PALETTE: Record<string, { sidebar: string; background: string }> = {
  map: { sidebar: '#10b981', background: '#ecfdf5' },
  data_layer: { sidebar: '#0284c7', background: '#f0f9ff' },
  derived_layer: { sidebar: '#1d4ed8', background: '#eff6ff' },
  arcgis_service: { sidebar: '#0891b2', background: '#ecfeff' },
  form: { sidebar: '#7c3aed', background: '#f5f3ff' },
  form_submission_collection: { sidebar: '#8b5cf6', background: '#f5f3ff' },
  web_app: { sidebar: '#d97706', background: '#fffbeb' },
  report_template: { sidebar: '#e11d48', background: '#fff1f2' },
  dashboard: { sidebar: '#4f46e5', background: '#eef2ff' },
  file: { sidebar: '#475569', background: '#f8fafc' },
  layer_package: { sidebar: '#047857', background: '#ecfdf5' },
  tool: { sidebar: '#0d9488', background: '#f0fdfa' },
  widget_package: { sidebar: '#0f766e', background: '#f0fdfa' },
  pick_list: { sidebar: '#65a30d', background: '#f7fee7' },
  geo_boundary: { sidebar: '#ea580c', background: '#fff7ed' },
  basemap: { sidebar: '#334155', background: '#f1f5f9' },
  wms_service: { sidebar: '#0e7490', background: '#ecfeff' },
  wfs_service: { sidebar: '#155e75', background: '#ecfeff' },
  service: { sidebar: '#0891b2', background: '#ecfeff' },
  folder: { sidebar: '#b45309', background: '#fffbeb' },
  editor: { sidebar: '#9333ea', background: '#faf5ff' },
  data_collection: { sidebar: '#6d28d9', background: '#f5f3ff' },
  geocoding_service: { sidebar: '#c2410c', background: '#fff7ed' },
  tile_layer: { sidebar: '#c026d3', background: '#fdf4ff' },
  app_template: { sidebar: '#b45309', background: '#fffbeb' },
  theme: { sidebar: '#db2777', background: '#fdf2f8' },
};

/**
 * Build the default thumbnail design for a newly-created item.  The
 * caller is responsible for passing the item's type; title is read
 * live by the renderer at request time, not baked in here.
 *
 * Defaults reach for a polished out-of-the-box look that resembles
 * the AGO Story Map template that inspired the redesign: full-bleed
 * background color, type-coded sidebar at ~95% opacity, title bar
 * across the bottom at ~80% opacity so the background reads
 * through.
 */
export function defaultThumbnailDesign(type: ItemType): ThumbnailDesign {
  const palette = TYPE_PALETTE[type] ?? { sidebar: '#475569', background: '#f8fafc' };
  return {
    version: 1,
    background: palette.background,
    backgroundImage: null,
    backgroundOpacity: 1,
    sidebar: palette.sidebar,
    sidebarOpacity: 0.95,
    sidebarLabelOverride: null,
    titleBar: palette.sidebar,
    titleBarOpacity: 0.8,
    logo: null,
  };
}

/**
 * Render a thumbnail SVG.  Returns a complete `<svg>` document
 * string ready for `Content-Type: image/svg+xml`.
 *
 * Four-layer composition (AGO Story Map style), viewBox 600x400:
 *
 *   +---------------------------------------+--+
 *   |   [logo]                              |  |
 *   |                                       |  |
 *   |        background (image or color)    |s |
 *   |                                       |i |
 *   |                                       |d |
 *   |                                       |e |
 *   +---------------------------------------+b |
 *   |   title text on title bar (transp.)   |ar|
 *   +---------------------------------------+--+
 *
 * Layer order (bottom to top):
 *   1. background color (always)
 *   2. background image (optional, honors backgroundOpacity)
 *   3. title bar (semi-transparent strip across the bottom)
 *   4. sidebar (semi-transparent strip on the right, overlaps title bar)
 *   5. logo (optional, top-left of background area)
 *   6. title text (on title bar, right of sidebar)
 *   7. rotated type label (on sidebar)
 */
export function renderThumbnailSvg(args: {
  title: string;
  /** Resolved type label (e.g. via getItemTypeLabel(type)). */
  typeLabel: string;
  design: ThumbnailDesign;
}): string {
  const { title, typeLabel, design } = args;
  const label = design.sidebarLabelOverride ?? typeLabel;

  // Effective opacities + colors with sensible fallbacks so older
  // rows without the new fields still render.
  const bgImageOpacity = clamp01(design.backgroundOpacity ?? 1);
  const sidebarOpacity = clamp01(design.sidebarOpacity ?? 0.95);
  const titleBarColor = design.titleBar ?? design.sidebar;
  const titleBarOpacity = clamp01(design.titleBarOpacity ?? 0.8);

  // Layout: right-side sidebar so the AGO-template look feels
  // familiar to authors coming from there.
  const W = 600;
  const H = 400;
  const sidebarWidth = 70;
  const sidebarX = W - sidebarWidth;
  const titleBarHeight = 90;
  const titleBarY = H - titleBarHeight;
  const titleAreaLeft = 24;
  const titleAreaWidth = sidebarX - titleAreaLeft - 24;

  // Title color reads on the title bar, not the bare background,
  // so contrast picks against the bar's effective tint.
  const titleColor = pickContrastColor(titleBarColor);
  const labelColor = pickContrastColor(design.sidebar);

  const { lines, fontSize } = wrapTitle(title, titleAreaWidth, titleBarHeight);
  const lineHeight = fontSize * 1.15;
  const blockHeight = lineHeight * lines.length;
  // Vertically center the title block inside the title bar.
  const blockTop =
    titleBarY + (titleBarHeight - blockHeight) / 2 + fontSize * 0.82;

  // Logo position: top-left corner of the main area, with comfortable
  // padding.  64x64 max; the <image> preserves aspect ratio.
  const logoSize = 88;
  const logoX = 20;
  const logoY = 20;

  // Rotated type label: anchor on the sidebar center, rotate -90
  // around that anchor so the text runs from bottom to top.  Bumps
  // the font size a touch since the label is the primary affordance
  // on the sidebar.
  const labelSize = 22;
  const labelCx = sidebarX + sidebarWidth / 2;
  // Center vertically within the part of the sidebar that's not
  // covered by the title bar so the label doesn't collide with it.
  const labelCy = (titleBarY) / 2 + 30;

  const bgImageHref = design.backgroundImage;
  const logoHref = design.logo;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${escapeXml(label)}: ${escapeXml(title)}">
  <rect width="${W}" height="${H}" fill="${escapeXml(design.background)}"/>
  ${
    bgImageHref
      ? `<image href="${escapeXml(bgImageHref)}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice" opacity="${bgImageOpacity}"/>`
      : ''
  }
  <rect x="0" y="${titleBarY}" width="${W}" height="${titleBarHeight}" fill="${escapeXml(titleBarColor)}" fill-opacity="${titleBarOpacity}"/>
  <rect x="${sidebarX}" y="0" width="${sidebarWidth}" height="${H}" fill="${escapeXml(design.sidebar)}" fill-opacity="${sidebarOpacity}"/>
  ${
    logoHref
      ? `<image href="${escapeXml(logoHref)}" x="${logoX}" y="${logoY}" width="${logoSize}" height="${logoSize}" preserveAspectRatio="xMidYMid meet"/>`
      : ''
  }
  <g font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" fill="${titleColor}" font-weight="700">
    ${lines
      .map(
        (line, i) =>
          `<text x="${titleAreaLeft}" y="${blockTop + i * lineHeight}" font-size="${fontSize}">${escapeXml(line)}</text>`,
      )
      .join('\n    ')}
  </g>
  <g font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" fill="${labelColor}" font-weight="600" letter-spacing="0.08em">
    <text x="${labelCx}" y="${labelCy}" font-size="${labelSize}" text-anchor="middle" transform="rotate(-90 ${labelCx} ${labelCy})">${escapeXml(label.toUpperCase())}</text>
  </g>
</svg>`;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 1;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Word-wrap the title across up to two lines (the title bar is
 * deliberately short so the title doesn't tower over the background
 * image).  Picks the largest font that fits in the available width
 * and line count.  Character widths are estimated at ~0.55 em for
 * the system stack; close enough for layout without a real font-
 * metrics lookup.
 */
function wrapTitle(
  title: string,
  maxWidthPx: number,
  maxHeightPx: number,
): { lines: string[]; fontSize: number } {
  const cleaned = title.trim() || '(Untitled)';
  // Cap lines so the title fits in the bar: roughly fontSize * 1.15 *
  // lines <= maxHeightPx, with a 1.6 padding factor.
  for (const fontSize of [34, 30, 26, 22, 20, 18]) {
    const approxCharWidth = fontSize * 0.55;
    const maxChars = Math.max(6, Math.floor(maxWidthPx / approxCharWidth));
    const lines = greedyWrap(cleaned, maxChars);
    const blockHeight = fontSize * 1.15 * lines.length;
    if (lines.length <= 2 && blockHeight <= maxHeightPx - 12) {
      return { lines, fontSize };
    }
  }
  // Title is huge; truncate to 2 lines at the smallest font.
  const fontSize = 16;
  const approxCharWidth = fontSize * 0.55;
  const maxChars = Math.max(6, Math.floor(maxWidthPx / approxCharWidth));
  const lines = greedyWrap(cleaned, maxChars).slice(0, 2);
  const last = lines[lines.length - 1];
  if (last && last.length > 3) {
    lines[lines.length - 1] = last.slice(0, maxChars - 1) + '…';
  }
  return { lines, fontSize };
}

function greedyWrap(text: string, maxChars: number): string[] {
  const out: string[] = [];
  const words = text.split(/\s+/);
  let cur = '';
  for (const w of words) {
    // Single word longer than the line: hard-break it.
    if (w.length > maxChars) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      for (let i = 0; i < w.length; i += maxChars) {
        const chunk = w.slice(i, i + maxChars);
        if (i + maxChars >= w.length) {
          cur = chunk;
        } else {
          out.push(chunk);
        }
      }
      continue;
    }
    const candidate = cur ? cur + ' ' + w : w;
    if (candidate.length <= maxChars) {
      cur = candidate;
    } else {
      out.push(cur);
      cur = w;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Pick a high-contrast text color (near-black or near-white) for
 * the given background fill.  Parses #rgb / #rrggbb / rgb() / hsl()
 * just well enough to estimate luminance; anything we don't
 * recognize falls through to dark text since most defaults are
 * light-tinted.
 */
function pickContrastColor(bg: string): string {
  const lum = estimateLuminance(bg);
  return lum > 0.55 ? '#0f172a' : '#f8fafc';
}

function estimateLuminance(color: string): number {
  const c = color.trim().toLowerCase();
  // #rgb
  let m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(c);
  if (m) {
    const r = parseInt(m[1]! + m[1]!, 16) / 255;
    const g = parseInt(m[2]! + m[2]!, 16) / 255;
    const b = parseInt(m[3]! + m[3]!, 16) / 255;
    return relLum(r, g, b);
  }
  // #rrggbb
  m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(c);
  if (m) {
    const r = parseInt(m[1]!, 16) / 255;
    const g = parseInt(m[2]!, 16) / 255;
    const b = parseInt(m[3]!, 16) / 255;
    return relLum(r, g, b);
  }
  // rgb(r, g, b)
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(c);
  if (m) {
    return relLum(
      Number(m[1]) / 255,
      Number(m[2]) / 255,
      Number(m[3]) / 255,
    );
  }
  // hsl(h, s%, l%) -- use l directly as a luminance proxy.
  //
  // Parsed by hand rather than with a single regex. The old regex
  // had three `\d+(?:\.\d+)?` runs separated by optional commas and
  // CodeQL flagged it as polynomial-redos: adversarial inputs like
  // 'hsl(0000000000...' would let the engine try many `\d+` /
  // optional-fraction splits. Splitting on the structural characters
  // is O(n) and rejects malformed inputs cleanly.
  if (c.startsWith('hsl(') || c.startsWith('hsla(')) {
    const open = c.indexOf('(');
    const close = c.indexOf(')', open + 1);
    if (open > 0 && close > open) {
      const parts = c.slice(open + 1, close).split(',');
      const lRaw = parts[2]?.trim().replace(/%$/, '');
      if (lRaw && /^-?\d+(\.\d+)?$/.test(lRaw)) {
        const l = Number(lRaw);
        if (Number.isFinite(l)) return l / 100;
      }
    }
  }
  return 0.7;
}

function relLum(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
