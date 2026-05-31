// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #101: print template schema for the Print tool in a Custom Web App.
 *
 * A print template defines:
 *   - a paper size + orientation (the canvas);
 *   - a list of declared parameters the runtime form prompts the
 *     user for at print time (Title, Author, etc., or anything the
 *     template author defines);
 *   - a list of free-positioned elements (text, image, map, legend,
 *     scalebar, north-arrow, line, rectangle) that compose the
 *     printed page.
 *
 * Design choices vs. typical reporting-tool templates:
 *
 *   - **No bands.**  Single page = single canvas at the chosen paper
 *     size.  Multi-page printing (if ever needed) would be done via
 *     explicit page-break elements, not by a band/master-detail
 *     model.  Keeps the mental model the same as the rest of the
 *     Custom Web App designer.
 *
 *   - **Visual parameter bindings, not string expressions.**  Text
 *     elements carry an array of token segments instead of a single
 *     string with `[Parameters.X]` markers.  The designer renders
 *     each segment as either a literal-text chunk or a "chip" that
 *     resolves to a parameter / dynamic value at print time.  A
 *     "Show expression" toggle (future) lets advanced users drop
 *     to a string expression for cases the token model can't
 *     express, but the default flow is chip-based.
 *
 *   - **Smart auto-binding for map-derived elements.**  Map,
 *     Legend, Scalebar, and North-arrow elements all bind to the
 *     print job's map automatically.  The author never has to name
 *     a map or wire references explicitly; the runtime supplies
 *     the active map widget's id and the renderer takes it from
 *     there.
 */

/** Supported paper sizes.  Widths/heights are in inches at the
 *  natural orientation (portrait); the orientation flag flips them
 *  for landscape.  Names match what authors will recognize from
 *  desktop GIS print dialogs (Letter, Tabloid, Legal, A3, A4). */
export type PrintPaperSize =
  | 'letter'
  | 'legal'
  | 'tabloid'
  | 'a3'
  | 'a4';

export type PrintOrientation = 'portrait' | 'landscape';

export interface PrintPaperSpec {
  size: PrintPaperSize;
  orientation: PrintOrientation;
  /**
   * Inner margin in inches applied uniformly around the page.  The
   * designer canvas shows this as a soft inset.  Default 0.25" --
   * generous enough to avoid printer drift on consumer hardware but
   * tight enough to not waste real estate.
   */
  marginIn: number;
}

/**
 * Paper dimensions at portrait orientation.  Width / height in
 * inches.  The renderer multiplies by the chosen DPI to get pixel
 * dimensions; the designer canvas uses the same numbers at a fixed
 * scale to keep the on-screen ruler honest.
 */
export const PAPER_SIZE_INCHES: Record<PrintPaperSize, { w: number; h: number }> = {
  letter: { w: 8.5, h: 11 },
  legal: { w: 8.5, h: 14 },
  tabloid: { w: 11, h: 17 },
  a3: { w: 11.69, h: 16.54 },
  a4: { w: 8.27, h: 11.69 },
};

/**
 * Resolve a paper spec to its rendered width / height in inches at
 * the chosen orientation.  Landscape swaps the portrait dimensions.
 */
export function resolvePaperInches(spec: PrintPaperSpec): { w: number; h: number } {
  const base = PAPER_SIZE_INCHES[spec.size];
  return spec.orientation === 'landscape'
    ? { w: base.h, h: base.w }
    : { w: base.w, h: base.h };
}

// ---- Parameters ---------------------------------------------------

/**
 * Parameter declared by the template author.  At print time the
 * runtime widget renders a form input matching the type and stores
 * the value the user supplied.  The element renderer then resolves
 * `{Parameters.<name>}` token segments against these values.
 */
export interface PrintTemplateParameter {
  /** Stable identifier referenced by text-element token segments.
   *  Lowercase ASCII, no spaces -- the author edits a `label` but
   *  the id stays put across renames so bindings don't break. */
  id: string;
  /** Display label shown in the runtime form.  Default for the
   *  in-template token chip is this same label. */
  label: string;
  /** Optional helper text rendered under the input in the runtime
   *  form.  Free-form, supports a one-liner like "Project name as
   *  it appears on the deliverable cover sheet." */
  description?: string;
  /** Input type.  Drives both the form control and the value type
   *  the renderer expects.  `dropdown` requires `options`. */
  type: 'text' | 'longtext' | 'number' | 'date' | 'dropdown';
  /** Default value used as the form's initial value AND as the
   *  fallback when the runtime resolves a token segment with no
   *  user-supplied value (eg the template ships with sane defaults
   *  and the user hits Print without changing anything). */
  defaultValue?: string;
  /** Required field.  Runtime form blocks Print until provided. */
  required?: boolean;
  /** Dropdown options when type === 'dropdown'.  Ignored for other
   *  types. */
  options?: { value: string; label: string }[];
}

// ---- Element model ------------------------------------------------

/** Position of an element on the page.  Coordinates are in inches
 *  from the top-left of the page (NOT including margins -- the
 *  margins are part of the canvas frame, not the coordinate space).
 *  Floating-point so authors can nudge elements at sub-pixel
 *  precision; the renderer rounds to the closest device-pixel at
 *  the chosen DPI. */
export interface PrintElementBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Token segment that makes up a text element's content.  A text
 * element's `segments` field is an array of these: literal-text
 * chunks alternate with bound-value chips.  The renderer joins
 * them at print time with the resolved values inserted in place.
 *
 * Why segments instead of a single string with `{Parameters.X}`
 * markers: the chip-based UI is way more usable than typing
 * `[Parameters.X]` everywhere, and the segment array lets us
 * render the same text in the designer with visible chips for
 * the bound parts (vs. a flat string the author has to mentally
 * parse).
 */
export type PrintTextSegment =
  | { kind: 'literal'; text: string }
  | {
      kind: 'binding';
      /** Token source.  `parameter` resolves to a declared
       *  PrintTemplateParameter's value; `dynamic` resolves to a
       *  built-in (date, map scale, map extent, user display
       *  name, etc.).  `expression` is reserved for the future
       *  "Show expression" escape hatch. */
      source: 'parameter' | 'dynamic';
      /** Identifier within the source.  For `parameter`: the
       *  PrintTemplateParameter.id.  For `dynamic`: one of the
       *  DYNAMIC_TOKEN_IDS values (see below). */
      tokenId: string;
      /** Optional format hint (eg date format pattern, scale
       *  prefix).  Renderer-specific; left free-form for now. */
      format?: string;
    };

/** Built-in dynamic tokens the renderer fills automatically at print
 *  time.  Authors pick from this list (alongside their declared
 *  parameters) when inserting a chip. */
export const DYNAMIC_TOKEN_IDS = [
  'today_date',
  'today_datetime',
  'now_time',
  'map_scale',
  'map_extent_bbox',
  'map_center_latlon',
  'user_display_name',
  'org_name',
  'app_name',
  'page_number',
] as const;
export type DynamicTokenId = (typeof DYNAMIC_TOKEN_IDS)[number];

/**
 * Text element.  Renders a block of text composed of segments.
 * Supports basic font-size / weight / alignment styling -- enough
 * for typical map-marginalia (title, source, author, date).  More
 * sophisticated typography (rich text, inline color spans) can be
 * added later via an HTML segment kind; the segment array shape is
 * forward-compatible.
 */
export interface PrintTextElement {
  id: string;
  kind: 'text';
  box: PrintElementBox;
  segments: PrintTextSegment[];
  fontFamily?: string;
  /** Font size in points. */
  fontSizePt: number;
  fontWeight?: 'normal' | 'bold';
  fontStyle?: 'normal' | 'italic';
  color?: string;
  align?: 'left' | 'center' | 'right';
  vAlign?: 'top' | 'middle' | 'bottom';
  /** Optional border around the text box.  Useful for title blocks. */
  border?: PrintElementBorder;
  /** Optional background fill color. */
  backgroundColor?: string;
}

/**
 * Static image element.  Carries a URL (data: URI or http(s) URL).
 * Common case: logo, north-arrow if the author doesn't want the
 * smart NorthArrowElement.  Aspect-fit by default; `objectFit`
 * overrides for cases the author wants stretching.
 */
export interface PrintImageElement {
  id: string;
  kind: 'image';
  box: PrintElementBox;
  /** Image URL.  Data URIs are encouraged for portability so
   *  templates can be exported / imported as a single JSON blob. */
  url: string;
  alt?: string;
  objectFit?: 'contain' | 'cover' | 'fill';
}

/**
 * Map element.  Renders the active map for the print job at the
 * specified scale.  The renderer fetches a static raster image
 * (MapLibre static map endpoint or equivalent) at the chosen
 * resolution and inserts it.  No need to wire a map id -- the
 * runtime supplies it automatically.
 */
export interface PrintMapElement {
  id: string;
  kind: 'map';
  box: PrintElementBox;
  /** Optional fixed scale denominator.  When absent, the runtime
   *  uses the scale the user picked in the print form. */
  scaleOverride?: number;
  /** Optional border around the map frame.  Default thin gray. */
  border?: PrintElementBorder;
  /** Show a coordinate grid overlay.  `none` (default), `decimal`
   *  (decimal degrees), `dms` (degrees-minutes-seconds), or `utm`. */
  grid?: 'none' | 'decimal' | 'dms' | 'utm';
}

/**
 * Legend element.  Pulls layer symbology from the print job's map
 * and renders a vertically-stacked legend.  Optional `layerIds`
 * filter limits which layers appear (default: all visible at print
 * time).
 */
export interface PrintLegendElement {
  id: string;
  kind: 'legend';
  box: PrintElementBox;
  /** Restrict to specific layer ids.  Empty / undefined = all
   *  visible layers from the map. */
  layerIds?: string[];
  title?: string;
  fontSizePt?: number;
  border?: PrintElementBorder;
  backgroundColor?: string;
}

/** Scalebar element.  Bound to the print job's map.  Style picks
 *  between traditional graphic bars; units controls imperial vs
 *  metric vs both. */
export interface PrintScalebarElement {
  id: string;
  kind: 'scalebar';
  box: PrintElementBox;
  style?: 'bar' | 'line' | 'alternating';
  units?: 'imperial' | 'metric' | 'both';
}

/** North-arrow element.  Bound to the print job's map's rotation.
 *  Style picks between several common indicator shapes. */
export interface PrintNorthArrowElement {
  id: string;
  kind: 'north-arrow';
  box: PrintElementBox;
  style?: 'compass' | 'arrow' | 'simple';
}

/** Line element.  Common case: horizontal rule in a title block. */
export interface PrintLineElement {
  id: string;
  kind: 'line';
  box: PrintElementBox;
  thicknessPt?: number;
  color?: string;
  style?: 'solid' | 'dashed' | 'dotted';
}

/** Rectangle element.  Border + optional fill.  Used for title-block
 *  framing and similar marginalia chrome. */
export interface PrintRectangleElement {
  id: string;
  kind: 'rectangle';
  box: PrintElementBox;
  border?: PrintElementBorder;
  backgroundColor?: string;
  cornerRadiusPt?: number;
}

export interface PrintElementBorder {
  widthPt?: number;
  color?: string;
  style?: 'solid' | 'dashed' | 'dotted';
}

export type PrintElement =
  | PrintTextElement
  | PrintImageElement
  | PrintMapElement
  | PrintLegendElement
  | PrintScalebarElement
  | PrintNorthArrowElement
  | PrintLineElement
  | PrintRectangleElement;

export type PrintElementKind = PrintElement['kind'];

// ---- Top-level template ------------------------------------------

/**
 * Versioned template payload.  Stored in items.data_json for
 * print_template items.  Future schema bumps add a migration step
 * here (mirrors the v1->v4 walker in custom-app.ts).
 */
export interface PrintTemplateData {
  /** Schema version.  v1 = initial #101 shape. */
  version: 1;
  /** Paper size + orientation + margins. */
  paper: PrintPaperSpec;
  /** Declared parameters the runtime form prompts the user for. */
  parameters: PrintTemplateParameter[];
  /** Free-positioned elements composing the page.  Render order is
   *  array order (later elements paint on top of earlier ones).  */
  elements: PrintElement[];
  /** Optional descriptive text shown on the template's item-detail
   *  page (separate from the item's own description so the template
   *  author can talk about layout intent specifically). */
  layoutNotes?: string;
  /**
   * #159: optional default map this template was authored against.
   * Stamped when the user creates a template via the "Print this
   * map" button on a map editor (the map id flows through as a
   * query parameter to the new-item wizard, which writes it here).
   * The designer's Map elements auto-bind to this id when present,
   * letting an author preview the layout against the calling map
   * without having to wire references manually. Pure UX hint;
   * the print runtime in a Custom Web App still binds to the host
   * widget's map at print time and is unaffected.
   */
  defaultMapId?: string;
}

/**
 * Fresh template scaffold for the new-item wizard.  Letter portrait,
 * a single Title parameter, and a blank canvas with no elements
 * yet.  Authors stamp this and start dragging elements onto the
 * canvas from the palette.
 */
export const DEFAULT_PRINT_TEMPLATE: PrintTemplateData = {
  version: 1,
  paper: {
    size: 'letter',
    orientation: 'portrait',
    marginIn: 0.25,
  },
  parameters: [
    {
      id: 'title',
      label: 'Title',
      type: 'text',
      defaultValue: 'Map Title',
    },
  ],
  elements: [],
};

/**
 * Light migration scaffold.  Returns the input unchanged for v1
 * data; future versions add steps here so loaders never have to
 * branch on shape.
 */
export function migratePrintTemplateData(data: PrintTemplateData): PrintTemplateData {
  // v1 is the only shipped version; leave room for future steps.
  return data;
}
