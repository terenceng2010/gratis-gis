/**
 * Portal-api proxy. The browser hits /api/portal/<rest> and this route
 * forwards the request to portal-api with the current user's Keycloak
 * access token attached server-side. Keeps the JWT off the client while
 * giving interactive pages a simple fetch-to-relative-URL story.
 *
 * Only verbs we currently use are wired; add more as needed.
 */
import { getServerSession } from 'next-auth';
import { NextRequest, NextResponse } from 'next/server';
import { authOptions, type SessionWithToken } from '@/lib/auth';

const API_BASE = process.env.PORTAL_API_URL ?? 'http://localhost:4000';

async function forward(req: NextRequest, pathSegments: string[]) {
  // Per-hop timing log behind the BFF_TIMING flag. Lets us split a
  // slow page load into "cookie + getServerSession" vs "upstream
  // fetch to portal-api" vs "body shaping". With ~24 items in the
  // dev DB, none of those should take more than tens of ms; if the
  // log shows a 20s+ value on any hop, that's where the time is.
  const trace = process.env.BFF_TIMING === '1';
  const t0 = trace ? Date.now() : 0;

  const session = (await getServerSession(authOptions)) as SessionWithToken | null;
  const tSession = trace ? Date.now() : 0;
  if (!session?.accessToken) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  const suffix = pathSegments.join('/');
  const qs = req.nextUrl.search;
  const target = `${API_BASE}/api/${suffix}${qs}`;

  // Preserve the full Content-Type header. Multipart uploads carry a
  // boundary in the value (e.g. `multipart/form-data; boundary=----x`)
  // and strip-to-"application/json" corrupts them.
  const headers: Record<string, string> = {
    authorization: `Bearer ${session.accessToken}`,
  };
  const ct = req.headers.get('content-type');
  if (ct) headers['content-type'] = ct;
  // Editor runtime sends `x-editor-id` on every write so the API can
  // apply the Editor item's per-target policy as a defense-in-depth
  // gate over the existing data_layer share-edit check. Forward it
  // through the BFF unchanged. Custom headers are namespaced under
  // x-* so we keep the allowlist explicit rather than blanket-
  // forwarding everything.
  const editorId = req.headers.get('x-editor-id');
  if (editorId) headers['x-editor-id'] = editorId;
  // Field deployment runtime sends `x-data-collection-id` on every
  // write so the API can fire the data_collection_feature_created
  // notification (#229). Same allowlist pattern as x-editor-id.
  const dataCollectionId = req.headers.get('x-data-collection-id');
  if (dataCollectionId) headers['x-data-collection-id'] = dataCollectionId;

  // Stream-forward the request body instead of buffering the full
  // payload into a single ArrayBuffer. Buffering blew up on large
  // ingest uploads (a 200 MB shapefile would allocate 200 MB in the
  // BFF and another 200 MB in fetch's internal copy before sending,
  // sometimes oom-ing portal-web). Streaming keeps memory flat.
  // `duplex: 'half'` is required by undici/fetch when the request
  // body is a ReadableStream; without it Node throws "RequestInit:
  // duplex option is required when sending a body".
  const init: RequestInit & { duplex?: 'half' } = {
    method: req.method,
    headers,
    cache: 'no-store',
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = req.body;
    init.duplex = 'half';
  }

  // Forward client aborts upstream. Without this, when the browser
  // cancels its request the BFF still waits for portal-api to
  // finish (and portal-api still holds a Prisma connection). On a
  // slow page-revisit pattern that means each abandoned request
  // serialises behind the previous one's still-running query.
  init.signal = req.signal;

  const upstream = await fetch(target, init);
  const tUpstream = trace ? Date.now() : 0;
  // Stream the response body through as bytes so the browser receives
  // exactly what portal-api produced. text() would re-encode.
  const body = await upstream.arrayBuffer();
  if (trace) {
    const tDone = Date.now();
    // eslint-disable-next-line no-console
    console.log(
      `[bff] ${req.method} /api/${suffix}${qs} ` +
        `session=${tSession - t0}ms upstream=${tUpstream - tSession}ms ` +
        `body=${tDone - tUpstream}ms total=${tDone - t0}ms ` +
        `bytes=${body.byteLength}`,
    );
  }
  return new NextResponse(body, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
    },
  });
}

export async function GET(req: NextRequest, ctx: { params: { path: string[] } }) {
  return forward(req, ctx.params.path);
}
export async function POST(req: NextRequest, ctx: { params: { path: string[] } }) {
  return forward(req, ctx.params.path);
}
export async function PUT(req: NextRequest, ctx: { params: { path: string[] } }) {
  return forward(req, ctx.params.path);
}
export async function PATCH(req: NextRequest, ctx: { params: { path: string[] } }) {
  return forward(req, ctx.params.path);
}
export async function DELETE(req: NextRequest, ctx: { params: { path: string[] } }) {
  return forward(req, ctx.params.path);
}
