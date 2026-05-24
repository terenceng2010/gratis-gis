// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger } from '@nestjs/common';

import type { OverpassResponse } from './osm-to-geojson.js';

/**
 * Thin HTTP client for the Overpass API (#OSM).
 *
 * Wraps Node's built-in fetch with:
 *   - a per-call timeout (defaults to 30s; matches the QL's
 *     in-band timeout + a small server-round-trip buffer)
 *   - a small set of well-known error mappings (504 -> "the
 *     query was too big or the server is overloaded"; 429 ->
 *     "rate limited"; everything else -> generic upstream
 *     failure)
 *   - URL-encoded body submission per the Overpass API contract
 *     (it accepts both POST x-www-form-urlencoded and POST raw;
 *     we use the form encoding because that's what the public
 *     endpoint documents).
 *
 * The endpoint URL is supplied by the caller; the service layer
 * resolves it from env (`GRATIS_GIS_OSM_OVERPASS_ENDPOINT`,
 * default `https://overpass-api.de/api/interpreter`).  Keeping
 * the URL out of this class makes it easy to swap endpoints per
 * org in wave 2 without re-instantiating the client.
 */
@Injectable()
export class OverpassClient {
  private readonly logger = new Logger(OverpassClient.name);

  async run(args: {
    endpoint: string;
    ql: string;
    timeoutMs?: number;
  }): Promise<OverpassResponse> {
    const timeoutMs = args.timeoutMs ?? 30_000;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(args.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': 'gratis-gis-osm/0.1',
          accept: 'application/json',
        },
        body: new URLSearchParams({ data: args.ql }).toString(),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw mapOverpassError(res.status, text);
      }
      const body = (await res.json()) as OverpassResponse;
      return body;
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(
          `Overpass query timed out after ${timeoutMs}ms; tighten the area or filters and retry`,
        );
      }
      throw err;
    } finally {
      clearTimeout(t);
    }
  }
}

function mapOverpassError(status: number, text: string): Error {
  if (status === 504 || status === 503) {
    return new Error(
      `Overpass server is overloaded or the query was too large (HTTP ${status}); tighten the area or filters and retry`,
    );
  }
  if (status === 429) {
    return new Error(
      'Overpass rate-limited the request (HTTP 429); wait a minute and retry, or point the deployment at a self-hosted Overpass endpoint',
    );
  }
  if (status === 400) {
    return new Error(`Overpass rejected the query (HTTP 400): ${text.slice(0, 200)}`);
  }
  return new Error(`Overpass call failed (HTTP ${status}): ${text.slice(0, 200)}`);
}
