// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Shared SSRF guards used by every probe path that takes a
 * user-supplied URL and fetches it server-side (basemap probe,
 * geocoder probe, ArcGIS service probe, item proxy, public proxy,
 * tile-layer ingest worker).
 *
 * `isPrivateOrLoopbackHost` returns true for hostnames that should
 * never be the target of a server-side fetch from inside the prod
 * docker network: numeric RFC1918, loopback, link-local, IPv6
 * loopback / unique-local, `localhost`, and any bare single-label
 * hostname (which in our deploy is always a docker compose service
 * name like `postgres`, `keycloak`, `minio`, `pg_tileserv`).
 *
 * `assertSafeOutboundUrl` is the load-bearing helper: it parses the
 * URL, rejects non-http(s) schemes, runs the hostname check, and
 * then resolves the hostname via DNS and re-runs the check against
 * the resolved IP.  Without the post-DNS check, an attacker can
 * register a public hostname that resolves to 192.168.x.y and
 * smuggle a fetch past a hostname-only filter.
 *
 * `safeFetch` is a drop-in replacement for `fetch()` that runs the
 * assert step first.  Every outbound HTTP call originating from a
 * user-supplied URL must route through `safeFetch`.  Outbound calls
 * to fixed, deploy-time-configured URLs (Keycloak's token endpoint,
 * MinIO inside the docker network) do NOT need the guard and would
 * trip on the single-label hostname check; they call `fetch()`
 * directly.
 *
 * TOCTOU note: there is a small window between the DNS lookup and
 * the underlying TCP connect where DNS could re-resolve.  A complete
 * defense pins the connection to the resolved IP and ships the
 * Host header for SNI.  We're not doing that yet; flagged as a
 * future hardening.
 */
import { lookup as dnsLookup } from 'node:dns/promises';

export function isPrivateOrLoopbackHost(host: string): boolean {
  // Numeric IPv4. Block RFC1918 + loopback + link-local.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const [, a, b] = m;
    const aN = Number(a);
    const bN = Number(b);
    if (aN === 10) return true;
    if (aN === 127) return true;
    if (aN === 169 && bN === 254) return true;
    if (aN === 172 && bN >= 16 && bN <= 31) return true;
    if (aN === 192 && bN === 168) return true;
    // Carrier-grade NAT (RFC 6598).  Not strictly necessary today
    // but cheap to add and matches the spirit of the rule.
    if (aN === 100 && bN >= 64 && bN <= 127) return true;
    return false;
  }
  // IPv6 loopback / link-local / unique-local. URL parsing wraps v6
  // hosts in brackets, so we check both bracketed and bare forms.
  if (host === '::1') return true;
  if (host.startsWith('[::1]') || host.startsWith('[fc') || host.startsWith('[fd')) {
    return true;
  }
  // Bare IPv6 without brackets (DNS-lookup result format).
  if (host.startsWith('fc') && host.includes(':')) return true;
  if (host.startsWith('fd') && host.includes(':')) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  // Any bare single-label hostname in our prod deploy is a docker
  // compose service name and must not be fetched from a
  // user-supplied URL.  Real external services always have FQDNs.
  if (!host.includes('.') && !host.startsWith('[')) return true;
  return false;
}

export class UnsafeOutboundUrlError extends Error {
  constructor(reason: string) {
    super(`Refusing to fetch URL: ${reason}`);
    this.name = 'UnsafeOutboundUrlError';
  }
}

/**
 * Validate a user-supplied URL for server-side fetch.  Throws
 * `UnsafeOutboundUrlError` if the URL targets a private host, an
 * unresolvable host, or a non-HTTP scheme.  Returns the parsed
 * URL on success.
 *
 * Performs two checks:
 *   1. Hostname-as-given is not in the private ranges
 *   2. DNS lookup of the hostname resolves to a non-private IP
 * The second is the DNS-rebinding defense.
 */
export async function assertSafeOutboundUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeOutboundUrlError(`invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeOutboundUrlError(
      `unsupported scheme: ${url.protocol}`,
    );
  }
  const host = url.hostname;
  if (isPrivateOrLoopbackHost(host)) {
    throw new UnsafeOutboundUrlError(`private host: ${host}`);
  }
  // DNS-rebinding defense: resolve and check.
  try {
    const { address } = await dnsLookup(host);
    if (isPrivateOrLoopbackHost(address)) {
      throw new UnsafeOutboundUrlError(
        `host ${host} resolves to private IP ${address}`,
      );
    }
  } catch (e) {
    if (e instanceof UnsafeOutboundUrlError) throw e;
    // Unresolvable host: refuse rather than letting fetch report a
    // generic error.  This keeps the error message specific and
    // prevents an attacker from probing internal DNS via timing.
    throw new UnsafeOutboundUrlError(`unresolvable host: ${host}`);
  }
  return url;
}

/**
 * Drop-in replacement for `fetch()` that validates the URL before
 * dispatching.  Use this for every outbound HTTP call originating
 * from a user-supplied URL.
 *
 * For fixed, deploy-time URLs (the Keycloak token endpoint via
 * AUTH_URL env, MinIO inside the docker network) call `fetch`
 * directly; those URLs target single-label hostnames or internal
 * IPs by design and would trip the guard.
 */
export async function safeFetch(
  rawUrl: string,
  init?: RequestInit,
): Promise<Response> {
  const url = await assertSafeOutboundUrl(rawUrl);
  return fetch(url, init);
}
