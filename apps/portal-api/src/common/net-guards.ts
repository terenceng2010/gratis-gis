// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Shared SSRF guards used by every probe path that takes a
 * user-supplied URL and fetches it server-side (basemap probe,
 * geocoder probe, ArcGIS service probe).
 *
 * Returning true means "refuse to fetch": the hostname is on a
 * private / loopback / link-local range and a request would either
 * hit the operator's internal network or loop back to the api itself.
 *
 * Centralized so every probe path has the same coverage; adding a
 * new range (e.g. carrier-grade NAT) only needs to land in one spot.
 */
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
    return false;
  }
  // IPv6 loopback / link-local / unique-local. URL parsing wraps v6
  // hosts in brackets, so we check both bracketed and bare forms.
  if (host === '::1') return true;
  if (host.startsWith('[::1]') || host.startsWith('[fc') || host.startsWith('[fd')) {
    return true;
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  return false;
}
