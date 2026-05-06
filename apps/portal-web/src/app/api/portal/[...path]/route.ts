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

/**
 * Long-running upstream dispatcher for ingest + per-layer import
 * routes. Default undici fetch() caps the response-headers wait at
 * 30 s, which is plenty for an admin click but nowhere near long
 * enough for a county-scale parcel ingest where GDAL parse + bulk
 * insert can run for several minutes. We use a dedicated Agent so
 * normal API calls keep their tight defaults: only requests routed
 * here get the loosened budget.
 *
 * Both the import AND the constructor are deferred to first ingest
 * hit. A static `import { Agent } from 'undici'` loads undici's
 * Agent module at evaluation time, and that module body references
 * `util.markAsUncloneable`, a Node 22+ builtin that doesn't exist on
 * the older Node our build container runs. Next.js's "Collect page
 * data" phase evaluates every route module, so the build crashed
 * even though we never instantiated the Agent. Dynamic import keeps
 * undici entirely out of build-time evaluation.
 */
let _ingestAgent: unknown = null;
async function getIngestAgent(): Promise<unknown> {
  if (!_ingestAgent) {
    const { Agent } = await import('undici');
    _ingestAgent = new Agent({
      headersTimeout: 15 * 60 * 1000,
      bodyTimeout: 15 * 60 * 1000,
      connectTimeout: 30 * 1000,
    });
  }
  return _ingestAgent;
}

/** Match v3 per-layer ingest, v2 ingest, and the wizard probe path.
 *  Conservative: only widens for endpoints we know can take minutes. */
function isLongRunningIngestPath(suffix: string): boolean {
  return (
    /^items\/[^/]+\/layers\/[^/]+\/import$/.test(suffix) ||
    /^items\/[^/]+\/ingest$/.test(suffix) ||
    suffix === 'ingest/probe'
  );
}

/**
 * Anonymous-fallback rewrites for #307. When the caller has no
 * session, GETs to a small allowlist of paths get rewritten to
 * the equivalent /api/public route and forwarded without an auth
 * header. portal-api enforces access='public' on the public
 * surface, so anonymous calls to these paths are safe; everything
 * else still 401s.
 *
 * Allowlist:
 *   - items/:id                        -> public/items/:id
 *   - items/:id/layers/:layer/geojson  -> public/items/:id/layers/:layer/geojson
 *   - items/:id/layers/:layer/features -> public/items/:id/layers/:layer/features
 *
 * Anything else (item lists, dependents lookups, write verbs)
 * stays auth-gated. Lists are deliberately not in the allowlist
 * because /api/public/items?type=basemap is a tiny custom surface
 * and the ?type=basemap parameter pattern doesn't generalize to
 * the rest of the items list contract.
 */
function publicRewriteForAnonymousGet(suffix: string): string | null {
  if (/^items\/[^/]+$/.test(suffix)) {
    return `public/${suffix}`;
  }
  if (/^items\/[^/]+\/layers\/[^/]+\/(geojson|features)$/.test(suffix)) {
    return `public/${suffix}`;
  }
  // Anonymous service-proxy passthrough: a public viewer that
  // references an external service (ArcGIS / WMS / WFS / WMTS)
  // hits /items/:id/proxy/<sub-path>?... at runtime to fetch
  // tiles or features. The matching public endpoint is gated on
  // access='public' and injects stored credentials server-side
  // before forwarding upstream, so the credential never leaves
  // the server. See public-proxy.controller.ts.
  if (/^items\/[^/]+\/proxy(\/.*)?$/.test(suffix)) {
    return `public/${suffix}`;
  }
  return null;
}

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

  const suffix = pathSegments.join('/');
  const qs = req.nextUrl.search;

  // #307: when an anonymous visitor opens a publicly-shared viewer,
  // the runtime makes client-side fetches for layer features and
  // map item metadata. Without a session we'd 401 here; instead,
  // for a small allowlist of GET paths we rewrite to the public
  // surface and forward without auth. portal-api enforces
  // access='public' on those endpoints.
  const publicRewrite =
    !session?.accessToken && req.method === 'GET'
      ? publicRewriteForAnonymousGet(suffix)
      : null;

  if (!session?.accessToken && !publicRewrite) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  const effectiveSuffix = publicRewrite ?? suffix;
  const target = `${API_BASE}/api/${effectiveSuffix}${qs}`;

  // Preserve the full Content-Type header. Multipart uploads carry a
  // boundary in the value (e.g. `multipart/form-data; boundary=----x`)
  // and strip-to-"application/json" corrupts them.
  const headers: Record<string, string> = {};
  if (session?.accessToken) {
    headers.authorization = `Bearer ${session.accessToken}`;
  }
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
  const init: RequestInit & { duplex?: 'half'; dispatcher?: unknown } = {
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

  // Long-running ingest endpoints get a custom dispatcher with 15 min
  // headers + body timeouts. Everything else falls through to the
  // built-in 30 s defaults so a misbehaving upstream still fails fast.
  if (isLongRunningIngestPath(suffix)) {
    init.dispatcher = await getIngestAgent();
  }

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
