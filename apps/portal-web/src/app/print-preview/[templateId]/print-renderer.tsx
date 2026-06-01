// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #159 Phase 2.1 server-side print renderer.
 *
 * Reads a PrintTemplateData blob plus runtime parameter values
 * and emits absolute-positioned HTML that paints every layout
 * element at the template's design DPI. The Puppeteer pipeline
 * navigates the headless browser to a page that mounts this
 * component and calls page.pdf at the same paper dimensions, so
 * what the chromium sidecar captures matches what the print
 * designer's WYSIWYG showed.
 *
 * Phase 2.1 scope:
 *   - Text elements render with the same font / color / align /
 *     border / background rules as the designer.
 *   - Image elements render via plain <img>.
 *   - Line + Rectangle elements render via styled divs.
 *   - Legend / Scalebar / North arrow elements render simplified
 *     visual stand-ins (real map-bound versions land in Phase
 *     2.2 alongside the in-page MapLibre snapshot).
 *   - Map element renders an iframe pointing at the
 *     /items/:mapId?view=embed surface so the chromium sidecar
 *     captures a real map. The same-network call stays cheap
 *     (portal-web hits portal-api over the docker bridge).
 *
 * Token resolution: text segments referencing parameter tokens
 * resolve to the runtime-supplied value or the parameter's
 * declared defaultValue. Dynamic tokens (today_date, etc.)
 * resolve to the obvious computed value; map_extent_bbox stays
 * a string placeholder until Phase 2.2 wires the real map
 * extent through.
 */
import type {
  DynamicTokenId,
  PrintElement,
  PrintImageElement,
  PrintLegendElement,
  PrintLineElement,
  PrintMapElement,
  PrintNorthArrowElement,
  PrintRectangleElement,
  PrintScalebarElement,
  PrintTemplateData,
  PrintTemplateParameter,
  PrintTextElement,
  PrintTextSegment,
} from '@gratis-gis/shared-types';
import { resolvePaperInches } from '@gratis-gis/shared-types';

const DESIGN_DPI = 96;

const DYNAMIC_RESOLVERS: Record<
  DynamicTokenId,
  (ctx: RenderContext) => string
> = {
  today_date: () => new Date().toLocaleDateString(),
  today_datetime: () => new Date().toLocaleString(),
  now_time: () => new Date().toLocaleTimeString(),
  map_scale: () => '',
  map_extent_bbox: () => '',
  map_center_latlon: () => '',
  user_display_name: (ctx) => ctx.userDisplayName,
  org_name: () => '',
  app_name: () => 'GratisGIS',
  page_number: () => '1',
};

interface RenderContext {
  mapId: string;
  parameterValues: Record<string, string>;
  parameters: PrintTemplateParameter[];
  userDisplayName: string;
}

interface Props {
  template: PrintTemplateData;
  mapId: string;
  parameterValues: Record<string, string>;
  userDisplayName: string;
}

export function PrintRenderer({
  template,
  mapId,
  parameterValues,
  userDisplayName,
}: Props): JSX.Element {
  const inches = resolvePaperInches(template.paper);
  const pageStyle: React.CSSProperties = {
    position: 'relative',
    width: `${inches.w * DESIGN_DPI}px`,
    height: `${inches.h * DESIGN_DPI}px`,
    background: 'white',
    overflow: 'hidden',
  };
  const ctx: RenderContext = {
    mapId,
    parameterValues,
    parameters: template.parameters,
    userDisplayName,
  };
  return (
    <div style={pageStyle}>
      {(template.elements ?? []).map((el) => (
        <ElementBlock key={el.id} element={el} ctx={ctx} />
      ))}
    </div>
  );
}

function ElementBlock({
  element,
  ctx,
}: {
  element: PrintElement;
  ctx: RenderContext;
}) {
  const px = (n: number) => n * DESIGN_DPI;
  const wrapStyle: React.CSSProperties = {
    position: 'absolute',
    left: px(element.box.x),
    top: px(element.box.y),
    width: px(element.box.w),
    height: px(element.box.h),
  };
  let body: React.ReactNode = null;
  switch (element.kind) {
    case 'text':
      body = <TextBody element={element} ctx={ctx} />;
      break;
    case 'image':
      body = <ImageBody element={element} />;
      break;
    case 'map':
      body = <MapBody element={element} mapId={ctx.mapId} />;
      break;
    case 'legend':
      body = <LegendBody element={element} />;
      break;
    case 'scalebar':
      body = <ScalebarBody element={element} />;
      break;
    case 'north-arrow':
      body = <NorthArrowBody element={element} />;
      break;
    case 'line':
      body = <LineBody element={element} />;
      break;
    case 'rectangle':
      body = <RectangleBody element={element} />;
      break;
  }
  return <div style={wrapStyle}>{body}</div>;
}

function TextBody({
  element,
  ctx,
}: {
  element: PrintTextElement;
  ctx: RenderContext;
}) {
  const fontPx = (element.fontSizePt / 72) * DESIGN_DPI;
  const style: React.CSSProperties = {
    fontFamily: element.fontFamily ?? 'Arial, sans-serif',
    fontSize: `${fontPx}px`,
    fontWeight: element.fontWeight,
    fontStyle: element.fontStyle,
    color: element.color ?? '#000',
    textAlign: element.align ?? 'left',
    display: 'flex',
    alignItems:
      element.vAlign === 'top'
        ? 'flex-start'
        : element.vAlign === 'bottom'
          ? 'flex-end'
          : 'center',
    justifyContent:
      element.align === 'right'
        ? 'flex-end'
        : element.align === 'center'
          ? 'center'
          : 'flex-start',
    height: '100%',
    width: '100%',
    padding: '2px 4px',
    background: element.backgroundColor,
    border: element.border
      ? `${element.border.widthPt ?? 0.5}px ${element.border.style ?? 'solid'} ${element.border.color ?? '#888'}`
      : undefined,
    overflow: 'hidden',
    whiteSpace: 'pre-wrap',
    boxSizing: 'border-box',
  };
  return (
    <div style={style}>
      <span>
        {element.segments.map((seg, i) => (
          <span key={i}>{resolveSegment(seg, ctx)}</span>
        ))}
      </span>
    </div>
  );
}

function resolveSegment(segment: PrintTextSegment, ctx: RenderContext): string {
  if (segment.kind === 'literal') return segment.text;
  if (segment.source === 'parameter') {
    const supplied = ctx.parameterValues[segment.tokenId];
    if (supplied !== undefined && supplied !== '') return String(supplied);
    const decl = ctx.parameters.find((p) => p.id === segment.tokenId);
    return decl?.defaultValue ?? '';
  }
  if (segment.source === 'dynamic') {
    const fn = DYNAMIC_RESOLVERS[segment.tokenId as DynamicTokenId];
    return fn ? fn(ctx) : '';
  }
  return '';
}

function ImageBody({ element }: { element: PrintImageElement }) {
  if (!element.url) return null;
  return (
    <img
      src={element.url}
      alt={element.alt ?? ''}
      style={{
        width: '100%',
        height: '100%',
        objectFit: element.objectFit ?? 'contain',
      }}
    />
  );
}

function MapBody({
  element,
  mapId,
}: {
  element: PrintMapElement;
  mapId: string;
}) {
  const border: React.CSSProperties = element.border
    ? {
        border: `${element.border.widthPt ?? 0.75}px ${element.border.style ?? 'solid'} ${element.border.color ?? '#444'}`,
        boxSizing: 'border-box',
      }
    : {};
  return (
    <iframe
      title={`Map ${mapId}`}
      src={`/items/${mapId}?view=embed&hideChrome=1`}
      style={{
        width: '100%',
        height: '100%',
        border: 'none',
        background: '#f8fafc',
        ...border,
      }}
    />
  );
}

function LegendBody({ element }: { element: PrintLegendElement }) {
  const style: React.CSSProperties = {
    width: '100%',
    height: '100%',
    padding: '6px 8px',
    background: element.backgroundColor ?? '#fff',
    border: element.border
      ? `${element.border.widthPt ?? 0.5}px ${element.border.style ?? 'solid'} ${element.border.color ?? '#888'}`
      : undefined,
    boxSizing: 'border-box',
    fontFamily: 'Arial, sans-serif',
    fontSize: '10px',
    color: '#1f2937',
  };
  return (
    <div style={style}>
      <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '4px' }}>
        {element.title ?? 'Legend'}
      </div>
      {/* Phase 2.2 wires the actual layer list from the bound map.
          Phase 2.1 prints a single hint so the slot doesn't look
          empty in the captured PDF. */}
      <div style={{ color: '#6b7280' }}>
        (Layer-bound legend lands in the next phase)
      </div>
    </div>
  );
}

function ScalebarBody({ element }: { element: PrintScalebarElement }) {
  const unitLabel = element.units === 'metric' ? 'km' : 'mi';
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        fontFamily: 'Arial, sans-serif',
        fontSize: '9px',
        color: '#1f2937',
      }}
    >
      <div style={{ display: 'flex', height: '8px', border: '1px solid #111' }}>
        <div style={{ flex: 1, background: '#111' }} />
        <div style={{ flex: 1, background: '#fff' }} />
        <div style={{ flex: 1, background: '#111' }} />
        <div style={{ flex: 1, background: '#fff' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '2px' }}>
        <span>0</span>
        <span>{unitLabel}</span>
      </div>
    </div>
  );
}

function NorthArrowBody(_: { element: PrintNorthArrowElement }) {
  return (
    <svg
      viewBox="0 0 100 100"
      style={{ width: '100%', height: '100%' }}
      stroke="#111"
      strokeWidth={2}
      fill="none"
    >
      <polygon points="50,10 60,55 50,45 40,55" fill="#111" />
      <polygon points="50,90 60,55 50,65 40,55" fill="#fff" />
      <text
        x="50"
        y="20"
        textAnchor="middle"
        fontSize="18"
        fontFamily="Arial, sans-serif"
        fill="#111"
        stroke="none"
      >
        N
      </text>
    </svg>
  );
}

function LineBody({ element }: { element: PrintLineElement }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: element.color ?? '#1f2937',
      }}
    />
  );
}

function RectangleBody({ element }: { element: PrintRectangleElement }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: element.backgroundColor ?? 'transparent',
        border: element.border
          ? `${element.border.widthPt ?? 0.5}px ${element.border.style ?? 'solid'} ${element.border.color ?? '#888'}`
          : '1px solid #888',
        borderRadius: element.cornerRadiusPt
          ? `${element.cornerRadiusPt}px`
          : undefined,
        boxSizing: 'border-box',
      }}
    />
  );
}
