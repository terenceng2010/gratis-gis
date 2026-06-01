// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #159 Phase 2 print-preview route.
 *
 * The chromium sidecar navigates to this page from within the
 * docker network. The page validates the render token against
 * portal-api, then renders the print_template at its declared
 * paper size with no portal chrome around it. The headless
 * browser captures the result as a vector PDF via page.pdf().
 *
 * Auth: the URL carries `?renderToken=<token>` minted by
 * portal-api at /api/print/render time. The token is single-use
 * with a 60-second TTL; this page POSTs back to
 * /api/print/consume-render-token to validate. The token's
 * claims identify which user the render is being done for; we
 * fetch the template + map server-side with that user's
 * permissions implicitly granted by the token.
 *
 * Phase 1.5 will harden this further (sign the token instead of
 * looking it up in-memory so portal-api restarts mid-render
 * don't lose state). For Phase 2.0 the in-memory map is fine.
 */
import { notFound } from 'next/navigation';

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

  if (!templateId || !mapId || !renderToken) {
    notFound();
  }

  // Validate the render token. The portal-api endpoint is
  // @Public() and gated by the token itself — no Bearer token
  // is sent because the chromium sidecar doesn't have one.
  const consumeRes = await fetch(
    `${PRIVATE_API_BASE}/api/print/consume-render-token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: renderToken }),
      cache: 'no-store',
    },
  );
  if (!consumeRes.ok) {
    notFound();
  }
  const claims = (await consumeRes.json()) as {
    userId: string;
    templateId: string;
    mapId: string;
  };
  if (claims.templateId !== templateId || claims.mapId !== mapId) {
    notFound();
  }

  // Decode parameter values. Soft-fail on malformed input — the
  // template falls back to declared defaults.
  let parameterValues: Record<string, string> = {};
  if (p) {
    try {
      const decoded = Buffer.from(p, 'base64url').toString('utf8');
      parameterValues = JSON.parse(decoded) as Record<string, string>;
    } catch {
      parameterValues = {};
    }
  }

  // Phase 2.0 ships a minimal page that demonstrates the
  // pipeline end-to-end: it shows the template id, map id, and
  // parameter values on a paper-sized canvas. Phase 2.1 swaps
  // in the real print-layout renderer (sharing logic with the
  // existing print designer's WYSIWYG preview).
  return (
    <html lang="en">
      <head>
        <title>Print preview</title>
        <style>{`
          html, body { margin: 0; padding: 0; background: white; color: #111; font-family: ui-sans-serif, system-ui, sans-serif; }
          .page { padding: 1in; box-sizing: border-box; }
          h1 { font-size: 18pt; margin-bottom: 0.25in; }
          dl { font-size: 11pt; }
          dt { font-weight: 600; margin-top: 0.1in; }
          dd { margin: 0; color: #444; }
        `}</style>
      </head>
      <body>
        <div className="page">
          <h1>GratisGIS print preview</h1>
          <dl>
            <dt>Template</dt>
            <dd>{templateId}</dd>
            <dt>Map</dt>
            <dd>{mapId}</dd>
            <dt>Rendered for user</dt>
            <dd>{claims.userId}</dd>
            {Object.entries(parameterValues).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{String(v)}</dd>
              </div>
            ))}
          </dl>
          <p style={{ marginTop: '0.5in', fontSize: '9pt', color: '#666' }}>
            Phase 2.0 scaffold. The print designer&apos;s WYSIWYG renderer
            ships into this surface in Phase 2.1.
          </p>
        </div>
      </body>
    </html>
  );
}
