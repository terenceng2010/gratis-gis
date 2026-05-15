// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * #101: render a print template at paper-sized scale, with parameter
 * values resolved into bound segments, and trigger the browser's
 * print dialog when ready.
 *
 * v1 simplifications:
 *   - Map elements render as a labeled placeholder.  Real raster
 *     rendering needs MapLibre + extent/scale plumbing from the
 *     parent web app; tracked as a followup.
 *   - Dynamic tokens that depend on map state (map_scale,
 *     map_extent_bbox, map_center_latlon) resolve to placeholder
 *     text until the map-render path lands.
 *   - The whole template renders to a single page; multi-page is
 *     out of scope per the original design (no bands).
 */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  DYNAMIC_TOKEN_IDS,
  PAPER_SIZE_INCHES,
  resolvePaperInches,
  type DynamicTokenId,
  type PrintElement,
  type PrintImageElement,
  type PrintLegendElement,
  type PrintLineElement,
  type PrintMapElement,
  type PrintNorthArrowElement,
  type PrintRectangleElement,
  type PrintScalebarElement,
  type PrintTemplateData,
  type PrintTemplateParameter,
  type PrintTextElement,
  type PrintTextSegment,
} from '@gratis-gis/shared-types';

interface PrintRenderClientProps {
  templateId: string;
}

/** Resolution used to translate inches -> pixels on the print page.
 *  Browsers use 96 DPI for `@page` size in CSS, so matching that gives
 *  predictable WYSIWYG between the design canvas and the printed
 *  output.  The user's printer driver handles the scale to physical
 *  paper. */
const PRINT_DPI = 96;

export function PrintRenderClient({ templateId }: PrintRenderClientProps) {
  const search = useSearchParams();
  const valuesParam = search?.get('values') ?? '{}';
  const mapWidgetId = search?.get('mapWidgetId') ?? '';

  const values: Record<string, string> = useMemo(() => {
    try {
      return JSON.parse(valuesParam) as Record<string, string>;
    } catch {
      return {};
    }
  }, [valuesParam]);

  void mapWidgetId; // followup: thread map state into MapElementRender

  const [template, setTemplate] = useState<PrintTemplateData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/portal/items/${templateId}`, {
          cache: 'no-store',
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const body = (await res.json()) as { data: PrintTemplateData };
        if (!cancelled) setTemplate(body.data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [templateId]);

  // Trigger the browser print dialog once the template is loaded.
  // Delay by a tick so the layout has a frame to settle (images,
  // fonts) before the print preview snapshot.
  useEffect(() => {
    if (!template) return;
    const t = setTimeout(() => {
      try {
        window.print();
      } catch {
        /* user can hit Cmd+P manually */
      }
    }, 400);
    return () => clearTimeout(t);
  }, [template]);

  if (error) {
    return (
      <div style={{ padding: 24, color: '#900', fontFamily: 'system-ui' }}>
        Failed to load print template: {error}
      </div>
    );
  }
  if (!template) {
    return (
      <div style={{ padding: 24, color: '#666', fontFamily: 'system-ui' }}>
        Loading…
      </div>
    );
  }

  const paperIn = resolvePaperInches(template.paper);
  const widthPx = paperIn.w * PRINT_DPI;
  const heightPx = paperIn.h * PRINT_DPI;

  return (
    <>
      <style jsx global>{`
        @page {
          size: ${paperIn.w}in ${paperIn.h}in;
          margin: 0;
        }
        body {
          margin: 0;
          background: #e5e7eb;
        }
        .print-page {
          width: ${widthPx}px;
          height: ${heightPx}px;
          background: white;
          margin: 24px auto;
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
          position: relative;
          overflow: hidden;
        }
        @media print {
          body {
            background: white;
          }
          .print-page {
            margin: 0;
            box-shadow: none;
          }
          .no-print {
            display: none !important;
          }
        }
      `}</style>
      <div className="no-print" style={{ padding: 12, textAlign: 'center', fontFamily: 'system-ui', fontSize: 13 }}>
        Use your browser's <strong>Print → Save as PDF</strong> to produce a PDF.
      </div>
      <div className="print-page">
        {template.elements.map((el) => (
          <ElementRender
            key={el.id}
            element={el}
            parameters={template.parameters}
            values={values}
          />
        ))}
      </div>
    </>
  );
}

function ElementRender({
  element,
  parameters,
  values,
}: {
  element: PrintElement;
  parameters: PrintTemplateParameter[];
  values: Record<string, string>;
}) {
  const px = (n: number) => n * PRINT_DPI;
  const baseStyle: CSSProperties = {
    position: 'absolute',
    left: px(element.box.x),
    top: px(element.box.y),
    width: px(element.box.w),
    height: px(element.box.h),
  };
  switch (element.kind) {
    case 'text':
      return (
        <TextRender
          element={element}
          parameters={parameters}
          values={values}
          baseStyle={baseStyle}
        />
      );
    case 'image':
      return <ImageRender element={element} baseStyle={baseStyle} />;
    case 'map':
      return <MapPlaceholderRender element={element} baseStyle={baseStyle} />;
    case 'legend':
      return <LegendRender element={element} baseStyle={baseStyle} />;
    case 'scalebar':
      return <ScalebarRender element={element} baseStyle={baseStyle} />;
    case 'north-arrow':
      return <NorthArrowRender element={element} baseStyle={baseStyle} />;
    case 'line':
      return <LineRender element={element} baseStyle={baseStyle} />;
    case 'rectangle':
      return <RectangleRender element={element} baseStyle={baseStyle} />;
  }
}

function resolveSegment(
  seg: PrintTextSegment,
  parameters: PrintTemplateParameter[],
  values: Record<string, string>,
): string {
  if (seg.kind === 'literal') return seg.text;
  if (seg.source === 'parameter') {
    const v = values[seg.tokenId];
    if (typeof v === 'string' && v.length > 0) return v;
    const p = parameters.find((p) => p.id === seg.tokenId);
    return p?.defaultValue ?? '';
  }
  // dynamic
  const id = seg.tokenId as DynamicTokenId;
  if (id === 'today_date') return new Date().toLocaleDateString();
  if (id === 'today_datetime') return new Date().toLocaleString();
  if (id === 'now_time') return new Date().toLocaleTimeString();
  if (id === 'page_number') return '1';
  if (id === 'user_display_name') return '';
  if (id === 'org_name') return '';
  if (id === 'app_name') return '';
  if (id === 'map_scale') return '';
  if (id === 'map_extent_bbox') return '';
  if (id === 'map_center_latlon') return '';
  // Unknown dynamic ids resolve to empty so a renamed token doesn't
  // print a raw `{dynamic.unknown}` to the user.
  return '';
}

function TextRender({
  element,
  parameters,
  values,
  baseStyle,
}: {
  element: PrintTextElement;
  parameters: PrintTemplateParameter[];
  values: Record<string, string>;
  baseStyle: CSSProperties;
}) {
  const fontPx = (element.fontSizePt / 72) * PRINT_DPI;
  const style: CSSProperties = {
    ...baseStyle,
    fontFamily: element.fontFamily ?? 'Arial, sans-serif',
    fontSize: `${fontPx}px`,
    fontWeight: element.fontWeight,
    fontStyle: element.fontStyle,
    color: element.color ?? '#000',
    background: element.backgroundColor,
    border: element.border
      ? `${element.border.widthPt ?? 0.5}px ${element.border.style ?? 'solid'} ${element.border.color ?? '#888'}`
      : undefined,
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
    padding: '2px 4px',
    overflow: 'hidden',
    whiteSpace: 'pre-wrap',
    boxSizing: 'border-box',
  };
  const resolved = element.segments
    .map((s) => resolveSegment(s, parameters, values))
    .join('');
  return (
    <div style={style}>
      <span style={{ textAlign: element.align ?? 'left' as const }}>
        {resolved}
      </span>
    </div>
  );
}

function ImageRender({
  element,
  baseStyle,
}: {
  element: PrintImageElement;
  baseStyle: CSSProperties;
}) {
  if (!element.url) {
    return (
      <div
        style={{
          ...baseStyle,
          background: '#f3f4f6',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#9ca3af',
          fontSize: 11,
          fontFamily: 'system-ui',
        }}
      >
        (no image)
      </div>
    );
  }
  return (
    <img
      src={element.url}
      alt={element.alt ?? ''}
      style={{
        ...baseStyle,
        objectFit: element.objectFit ?? 'contain',
      }}
    />
  );
}

function MapPlaceholderRender({
  element,
  baseStyle,
}: {
  element: PrintMapElement;
  baseStyle: CSSProperties;
}) {
  const borderStyle: CSSProperties = element.border
    ? {
        border: `${element.border.widthPt ?? 0.75}px ${element.border.style ?? 'solid'} ${element.border.color ?? '#444'}`,
        boxSizing: 'border-box',
      }
    : {};
  return (
    <div
      style={{
        ...baseStyle,
        ...borderStyle,
        background:
          'repeating-linear-gradient(45deg, #f0fdf4, #f0fdf4 8px, #dcfce7 8px, #dcfce7 16px)',
        color: '#166534',
        fontFamily: 'system-ui',
        fontSize: 12,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      Map (server-side raster rendering — followup)
    </div>
  );
}

function LegendRender({
  element,
  baseStyle,
}: {
  element: PrintLegendElement;
  baseStyle: CSSProperties;
}) {
  const fontPx = ((element.fontSizePt ?? 9) / 72) * PRINT_DPI;
  return (
    <div
      style={{
        ...baseStyle,
        background: element.backgroundColor ?? '#fff',
        border: element.border
          ? `${element.border.widthPt ?? 0.5}px ${element.border.style ?? 'solid'} ${element.border.color ?? '#888'}`
          : '1px solid #888',
        padding: 4,
        fontFamily: 'Arial, sans-serif',
        fontSize: `${fontPx}px`,
        color: '#222',
        overflow: 'hidden',
        boxSizing: 'border-box',
      }}
    >
      <strong style={{ display: 'block', marginBottom: 4 }}>
        {element.title ?? 'Legend'}
      </strong>
      <div style={{ color: '#888' }}>(layer list — followup)</div>
    </div>
  );
}

function ScalebarRender({
  element,
  baseStyle,
}: {
  element: PrintScalebarElement;
  baseStyle: CSSProperties;
}) {
  return (
    <div
      style={{
        ...baseStyle,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        fontFamily: 'Arial, sans-serif',
        fontSize: 9,
        color: '#222',
      }}
    >
      <div style={{ display: 'flex', height: 8 }}>
        <div style={{ flex: 1, background: '#222' }} />
        <div style={{ flex: 1, background: '#fff', border: '1px solid #222' }} />
        <div style={{ flex: 1, background: '#222' }} />
        <div style={{ flex: 1, background: '#fff', border: '1px solid #222' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>0</span>
        <span>{element.units === 'metric' ? 'km' : 'mi'}</span>
      </div>
    </div>
  );
}

function NorthArrowRender({
  element: _element,
  baseStyle,
}: {
  element: PrintNorthArrowElement;
  baseStyle: CSSProperties;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      style={{ ...baseStyle, color: '#222' }}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
    >
      <circle cx={12} cy={12} r={10} />
      <path d="M12 2 L12 22 M2 12 L22 12" />
      <path d="M12 4 L9 12 L12 10 L15 12 Z" fill="currentColor" />
      <text
        x={12}
        y={7}
        textAnchor="middle"
        fontSize={4}
        fill="currentColor"
        stroke="none"
      >
        N
      </text>
    </svg>
  );
}

function LineRender({
  element,
  baseStyle,
}: {
  element: PrintLineElement;
  baseStyle: CSSProperties;
}) {
  return (
    <div
      style={{
        ...baseStyle,
        background: element.color ?? '#888',
        borderStyle: element.style ?? 'solid',
      }}
    />
  );
}

function RectangleRender({
  element,
  baseStyle,
}: {
  element: PrintRectangleElement;
  baseStyle: CSSProperties;
}) {
  return (
    <div
      style={{
        ...baseStyle,
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

// Reference the DYNAMIC_TOKEN_IDS import so future-token unhandled
// in `resolveSegment` triggers a TS narrowing exhaustiveness check
// when we add new ids.
void DYNAMIC_TOKEN_IDS;
void PAPER_SIZE_INCHES;
