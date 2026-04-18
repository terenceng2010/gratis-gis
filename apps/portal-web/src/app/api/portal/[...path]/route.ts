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
  const session = (await getServerSession(authOptions)) as SessionWithToken | null;
  if (!session?.accessToken) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }

  const suffix = pathSegments.join('/');
  const qs = req.nextUrl.search;
  const target = `${API_BASE}/api/${suffix}${qs}`;

  const init: RequestInit = {
    method: req.method,
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      'content-type': req.headers.get('content-type') ?? 'application/json',
    },
    cache: 'no-store',
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = await req.text();
  }

  const upstream = await fetch(target, init);
  const body = await upstream.text();
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
export async function PATCH(req: NextRequest, ctx: { params: { path: string[] } }) {
  return forward(req, ctx.params.path);
}
export async function DELETE(req: NextRequest, ctx: { params: { path: string[] } }) {
  return forward(req, ctx.params.path);
}
