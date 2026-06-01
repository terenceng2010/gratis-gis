// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #159 Phase 2.1 print-preview route.
 *
 * The chromium sidecar navigates here from inside the docker
 * network. The page validates the render token, fetches the
 * print_template + map item, then mounts the PrintRenderer at
 * the template's paper dimensions. Puppeteer page.pdf captures
 * the result as a vector PDF.
 *
 * Phase 2.2 will swap the Map element's iframe-based render for
 * an inline MapLibre snapshot so the captured PDF has higher-
 * fidelity map output (current iframe-in-PDF can rasterize).
 */
import { notFound } from 'next/navigation';
import { Buffer } from 'node:buffer';
import type { PrintTemplateData } from '@gratis-gis/shared-types';
import { resolvePaperInches } from '@gratis-gis/shared-types';

import { PrintRenderer } from './print-renderer';

const PRIVATE_API_BASE =
  process.env.PORTAL_API_INTERNAL_URL ?? 'http://portal-api:4000';

interface Props {
  params: { templateId: string };
  searchParams: {
    map?: string;
    renderToken?: string;
    p?: string;
  };
}

export default async function PrintPreviewPage({
  params,
  searchParams,
}: Props) {
  const { templateId } = params;
  const { map: mapId, renderToken, p } = searchParams;

  if (!templateId || !mapId || !renderToken) notFound();

  // 1. Validate the render token against portal-api. The
  //    consume-render-token endpoint is @Public + gated by the
  //    token itself; the chromium sidecar doesn't carry a Bearer.
  const consumeRes = await fetch(
    `${PRIVATE_API_BASE}/api/print/consume-render-token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: renderToken }),
      cache: 'no-store',
    },
  );
  if (!consumeRes.ok) notFound();
  const claims = (await consumeRes.json()) as {
    userId: string;
    templateId: string;
    mapId: string;
  };
  if (claims.templateId !== templateId || claims.mapId !== mapId) {
    notFound();
  }

  // 2. Decode parameter values blob. Soft-fail on malformed
  //    input so the renderer falls back to declared defaults.
  let parameterValues: Record<string, string> = {};
  if (p) {
    try {
      const decoded = Buffer.from(p, 'base64url').toString('utf8');
      parameterValues = JSON.parse(decoded) as Record<string, string>;
    } catch {
      parameterValues = {};
    }
  }

  // 3. Fetch the template + map item from portal-api. We use the
  //    /api/public/items/:id route for the template + map so the
  //    chromium sidecar (which has no Bearer) can still read them
  //    when shared as public. For private items the operator
  //    must arrange portal-web to forward an internal service
  //    token; Phase 2.2 lands that path. Phase 2.1 ships the
  //    common case (publicly shared map + template).
  const [tmplRes, mapRes] = await Promise.all([
    fetch(`${PRIVATE_API_BASE}/api/public/items/${templateId}`, {
      cache: 'no-store',
    }),
    fetch(`${PRIVATE_API_BASE}/api/public/items/${mapId}`, {
      cache: 'no-store',
    }),
  ]);
  if (!tmplRes.ok || !mapRes.ok) notFound();
  const tmplItem = (await tmplRes.json()) as {
    id: string;
    title: string;
    type: string;
    data: PrintTemplateData;
  };
  if (tmplItem.type !== 'print_template') notFound();

  const inches = resolvePaperInches(tmplItem.data.paper);

  return (
    <html lang="en">
      <head>
        <title>Print preview</title>
        <style>{`
          @page { size: ${inches.w}in ${inches.h}in; margin: 0; }
          html, body { margin: 0; padding: 0; background: white; }
          body { width: ${inches.w * 96}px; height: ${inches.h * 96}px; }
        `}</style>
      </head>
      <body>
        <PrintRenderer
          template={tmplItem.data}
          mapId={mapId}
          parameterValues={parameterValues}
          userDisplayName={claims.userId}
        />
      </body>
    </html>
  );
}
