// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Request } from 'express';

/**
 * Reconstruct the absolute `scheme://host` for the incoming request,
 * honoring the proxy headers Caddy / nginx set in front of portal-api.
 * Shared across every OGC controller so the link documents are
 * consistent regardless of which class generated them.
 */
export function absoluteBase(req: Request): string {
  const proto =
    (req.headers['x-forwarded-proto'] as string | undefined) ??
    req.protocol ??
    'http';
  const host =
    (req.headers['x-forwarded-host'] as string | undefined) ??
    req.headers.host ??
    'localhost';
  return `${proto}://${host}`;
}
