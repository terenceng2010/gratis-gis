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
   * all work.  Stored as a full CSS color (not bare HSL components)
   * because the SVG renderer needs a single drop-in string and these
   * blobs are also consumed by a future client-side designer preview
   * where authors pick via a color input that emits hex.
   */
  background: string;
  /** Sidebar strip fill color. */
  sidebar: string;
  /**
   * Optional override of the type-label text shown in the sidebar.
   * When null / missing the renderer falls back to whatever the
   * backend passes in (typically getItemTypeLabel(item.type)).
   * The override only changes the LABEL, never the layout.
   */
  sidebarLabelOverride?: string | null;
  /**
   * Optional full-bleed background image, either an absolute URL or
   * a `data:` URL.  When set, renders behind the sidebar and title
   * overlays.  Future basemap-thumbnail path uses this to render a
   * sample-tile rendering of the basemap as the bg (#67).
   */
  backgroundImage?: string | null;
}

/**
 * Per-item-type default colors used to seed a new item's thumbnail
 * design.  Mirrors the ItemCard tile palette in @gratis-gis/ui so
 * cards and thumbnails feel visually coherent.  Background is a
 * desaturated tint of the sidebar color so the two work as a pair.
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
 */
export function defaultThumbnailDesign(type: ItemType): ThumbnailDesign {
  const palette = TYPE_PALETTE[type] ?? { sidebar: '#475569', background: '#f8fafc' };
  return {
    version: 1,
    background: palette.background,
    sidebar: palette.sidebar,
    sidebarLabelOverride: null,
    backgroundImage: null,
  };
}

/**
 * Render a thumbnail SVG.  Returns a complete `<svg>` document
 * string ready for `Content-Type: image/svg+xml`.
 *
 * Layout (viewBox 600x400, 3:2 aspect):
 *
 *   +---------+-------------------------------+
 *   |         |                               |
 *   | sidebar |     title (auto-wrapped)      |
 *   | label   |     centered                  |
 *   |         |                               |
 *   +---------+-------------------------------+
 *
 * The sidebar is a 120-px-wide strip.  Title autosizes between 32
 * and 56 px based on string length, and wraps at word boundaries
 * across up to three lines (longer titles truncate with an
 * ellipsis on the third line).  Sidebar label uses 22 px text
 * vertically stacked at the top of the sidebar.
 */
export function renderThumbnailSvg(args: {
  title: string;
  /** Resolved type label (e.g. via getItemTypeLabel(type)). */
  typeLabel: string;
  design: ThumbnailDesign;
}): string {
  const { title, typeLabel, design } = args;
  const label = design.sidebarLabelOverride ?? typeLabel;
  const titleColor = pickContrastColor(design.background);
  const labelColor = pickContrastColor(design.sidebar);

  const sidebarWidth = 120;
  const padding = 24;
  const mainWidth = 600 - sidebarWidth;
  const mainLeft = sidebarWidth;
  const mainCenterX = mainLeft + mainWidth / 2;

  const { lines, fontSize } = wrapTitle(title, mainWidth - padding * 2);
  const lineHeight = fontSize * 1.15;
  const blockHeight = lineHeight * lines.length;
  const blockTop = (400 - blockHeight) / 2 + fontSize * 0.85;

  const bgImageHref = design.backgroundImage;

  // Vertical sidebar label: stack two lines if the label has a space
  // and the second word is short enough to fit.  Single line otherwise,
  // top-aligned with comfortable padding.
  const labelLines = splitLabel(label);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${escapeXml(label)}: ${escapeXml(title)}">
  <rect width="600" height="400" fill="${escapeXml(design.background)}"/>
  ${bgImageHref ? `<image href="${escapeXml(bgImageHref)}" x="${mainLeft}" y="0" width="${mainWidth}" height="400" preserveAspectRatio="xMidYMid slice"/>` : ''}
  <rect x="0" y="0" width="${sidebarWidth}" height="400" fill="${escapeXml(design.sidebar)}"/>
  <g font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" fill="${labelColor}" text-anchor="middle">
    ${labelLines
      .map(
        (line, i) =>
          `<text x="${sidebarWidth / 2}" y="${36 + i * 26}" font-size="20" font-weight="600">${escapeXml(line)}</text>`,
      )
      .join('\n    ')}
  </g>
  <g font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" fill="${titleColor}" text-anchor="middle" font-weight="700">
    ${lines
      .map(
        (line, i) =>
          `<text x="${mainCenterX}" y="${blockTop + i * lineHeight}" font-size="${fontSize}">${escapeXml(line)}</text>`,
      )
      .join('\n    ')}
  </g>
</svg>`;
}

/**
 * Split a label into 1-2 stacked words for the sidebar.  Two-word
 * labels like "Data layer" wrap to two lines; longer labels stay on
 * one line so they don't tower out of the strip.
 */
function splitLabel(label: string): string[] {
  const words = label.trim().split(/\s+/);
  if (words.length <= 1) return [label.trim()];
  if (words.length === 2 && words.every((w) => w.length <= 9)) {
    return words;
  }
  return [label.trim()];
}

/**
 * Word-wrap the title across up to three lines and pick a font size
 * that fits.  Character widths are estimated by the average glyph
 * advance at the chosen font size (≈ 0.55 em for the system stack);
 * close enough for layout without a real font-metrics lookup.
 */
function wrapTitle(
  title: string,
  maxWidthPx: number,
): { lines: string[]; fontSize: number } {
  const cleaned = title.trim() || '(Untitled)';
  // Try font sizes from largest to smallest until 3 lines fit.
  for (const fontSize of [56, 48, 40, 34, 30]) {
    const approxCharWidth = fontSize * 0.55;
    const maxChars = Math.max(6, Math.floor(maxWidthPx / approxCharWidth));
    const lines = greedyWrap(cleaned, maxChars);
    if (lines.length <= 3) {
      return { lines, fontSize };
    }
  }
  // Title is huge; truncate to 3 lines at the smallest font.
  const fontSize = 28;
  const approxCharWidth = fontSize * 0.55;
  const maxChars = Math.max(6, Math.floor(maxWidthPx / approxCharWidth));
  const lines = greedyWrap(cleaned, maxChars).slice(0, 3);
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
  m = /^hsla?\(\s*-?\d+(?:\.\d+)?\s*,?\s*\d+(?:\.\d+)?%?\s*,?\s*(\d+(?:\.\d+)?)%/.exec(c);
  if (m) {
    return Number(m[1]) / 100;
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
