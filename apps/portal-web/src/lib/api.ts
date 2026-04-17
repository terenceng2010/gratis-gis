import { getServerSession } from 'next-auth';
import { authOptions, type SessionWithToken } from './auth';

const API_BASE = process.env.PORTAL_API_URL ?? 'http://localhost:4000';

/**
 * Server-side fetch against portal-api that forwards the current user's
 * Keycloak access token. Use inside server components and route handlers.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = (await getServerSession(authOptions)) as SessionWithToken | null;
  if (!session?.accessToken) {
    throw new Error('Not authenticated');
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${session.accessToken}`,
      ...(init.headers ?? {}),
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`portal-api ${res.status}: ${body}`);
  }
  return (await res.json()) as T;
}
