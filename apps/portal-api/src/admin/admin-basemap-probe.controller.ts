// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { AdminGuard } from './admin.guard.js';

/**
 * Basemap-URL probe (#144). The admin pastes a URL into the
 * basemap editor; this endpoint inspects the URL + (when needed)
 * the remote service's metadata document and returns a populated
 * BasemapData skeleton the editor can drop into its form fields:
 *
 *   { kind, tileUrl?, styleUrl?, wmsUrl?, wmsConfig?, title?,
 *     attribution?, thumbnailUrl?, minZoom?, maxZoom? }
 *
 * Detection rules, in order:
 *
 *   1. URL contains literal `{z}/{x}/{y}` (or `{z}/{y}/{x}`)
 *      placeholders -> kind: 'tile-url'. The URL stays as-is.
 *
 *   2. URL path ends in `/MapServer` or `/MapServer/` (no
 *      `/tile/...` suffix) -> kind: 'tile-url'; fetch the service
 *      `?f=json` metadata to confirm cached tiles are available
 *      (`singleFusedMapCache: true`) and to lift mapName +
 *      copyrightText + thumbnail. Tile template becomes
 *      `{base}/tile/{z}/{y}/{x}` (Esri row-before-column order).
 *
 *   3. URL has `?service=WMS` (or path / file extension suggests
 *      WMS) -> kind: 'wms'; fetch GetCapabilities and surface
 *      Title + AccessConstraints + first layer name for the
 *      wmsConfig.
 *
 *   4. URL responds with `application/json` and the body looks
 *      like a MapLibre style (has `version`, `sources`, `layers`)
 *      -> kind: 'style-url'.
 *
 * Anything else returns 400 with a polite "couldn't detect"
 * message; the admin can still configure the basemap manually.
 *
 * Why admin-only: the endpoint makes outbound requests to a URL
 * the caller chooses. We don't want anonymous internet visitors
 * using the portal as a side-channel scanner against internal
 * networks. AdminGuard restricts to org admins.
 */
@ApiTags('admin', 'basemap')
@ApiBearerAuth()
@Controller('admin/basemap')
@UseGuards(AdminGuard)
export class AdminBasemapProbeController {
  private readonly log = new Logger(AdminBasemapProbeController.name);

  @Get('probe')
  async probe(@Query('url') rawUrl?: string): Promise<BasemapProbeResult> {
    if (!rawUrl || typeof rawUrl !== 'string') {
      throw new BadRequestException('Missing url parameter.');
    }
    const url = rawUrl.trim();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BadRequestException('Not a valid URL.');
    }
    // Block obvious internal-network ranges; AdminGuard already
    // restricts to org admins but a defense-in-depth on the
    // hostname keeps us from being an accidental SSRF surface.
    // Numeric IPs in private ranges + loopback + link-local are
    // refused outright. DNS-resolving hostnames are forwarded
    // (we don't try to resolve here; the admin-only audience is
    // assumed reasonable). Caddy/portal-web also network-isolate
    // the api container.
    if (isPrivateOrLoopbackHost(parsed.hostname)) {
      throw new BadRequestException(
        'Probing private / loopback addresses is not allowed.',
      );
    }

    // (1) XYZ tile template. Cheap; no network call.
    if (looksLikeXyzTemplate(url)) {
      return {
        kind: 'tile-url',
        tileUrl: url,
      };
    }

    // (2) ArcGIS MapServer.
    if (looksLikeArcgisMapServer(parsed)) {
      try {
        return await this.probeArcgisMapServer(parsed);
      } catch (err) {
        this.log.warn(
          `MapServer probe failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Fall through to the generic style probe; some MapServer
        // URLs respond to ?f=json with errors but still serve
        // tiles, so a manual tile-url paste might still work.
      }
    }

    // (3) WMS GetCapabilities.
    if (looksLikeWms(parsed)) {
      try {
        return await this.probeWms(parsed);
      } catch (err) {
        this.log.warn(
          `WMS probe failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // (4) MapLibre style.json.
    try {
      const styleResult = await this.probeStyle(url);
      if (styleResult) return styleResult;
    } catch (err) {
      this.log.warn(
        `Style probe failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    throw new BadRequestException(
      'Could not detect a recognized basemap format at that URL. ' +
        'Supported: XYZ tile template ({z}/{x}/{y} placeholders), ArcGIS ' +
        'MapServer, WMS GetCapabilities, or MapLibre style.json.',
    );
  }

  // ----------------------------------------------------------------

  private async probeArcgisMapServer(
    parsed: URL,
  ): Promise<BasemapProbeResult> {
    const base = parsed.toString().replace(/\/+$/, '');
    const metaUrl = `${base}?f=json`;
    const res = await fetchWithTimeout(metaUrl, 10_000);
    if (!res.ok) {
      throw new Error(`MapServer ?f=json returned ${res.status}`);
    }
    type EsriMapServer = {
      mapName?: string;
      copyrightText?: string;
      documentInfo?: { Title?: string };
      singleFusedMapCache?: boolean;
      tileInfo?: { lods?: Array<{ level: number }> };
      minLOD?: number;
      maxLOD?: number;
    };
    const meta = (await res.json()) as EsriMapServer;
    const title =
      (meta.mapName && meta.mapName.trim()) ||
      (meta.documentInfo?.Title && meta.documentInfo.Title.trim()) ||
      undefined;
    const attribution =
      meta.copyrightText && meta.copyrightText.trim()
        ? meta.copyrightText.trim()
        : undefined;
    // Esri tile URL convention is /tile/{level}/{row}/{col} which
    // MapLibre expresses as /tile/{z}/{y}/{x}. The row-before-
    // column swap matters; getting it backwards gives mirrored
    // tiles that don't blow up but are obviously wrong.
    const tileUrl = `${base}/tile/{z}/{y}/{x}`;
    // LOD range becomes minzoom / maxzoom so MapLibre doesn't try
    // to fetch tiles outside the cached pyramid (which 404s noisy
    // log spam).
    const lods = meta.tileInfo?.lods;
    let minZoom: number | undefined;
    let maxZoom: number | undefined;
    if (Array.isArray(lods) && lods.length > 0) {
      const levels = lods
        .map((l) => l.level)
        .filter((n): n is number => typeof n === 'number');
      if (levels.length > 0) {
        minZoom = Math.min(...levels);
        maxZoom = Math.max(...levels);
      }
    }
    return {
      kind: 'tile-url',
      tileUrl,
      ...(title ? { title } : {}),
      ...(attribution ? { attribution } : {}),
      ...(minZoom !== undefined ? { minZoom } : {}),
      ...(maxZoom !== undefined ? { maxZoom } : {}),
    };
  }

  private async probeWms(parsed: URL): Promise<BasemapProbeResult> {
    // Strip whatever query the URL had; GetCapabilities is a
    // standard request we compose ourselves.
    const base = `${parsed.origin}${parsed.pathname}`;
    const capsUrl = `${base}?service=WMS&request=GetCapabilities&version=1.3.0`;
    const res = await fetchWithTimeout(capsUrl, 10_000);
    if (!res.ok) {
      throw new Error(`GetCapabilities returned ${res.status}`);
    }
    const xml = await res.text();
    // Very light XML scrape. Full WMS Capabilities parsing is
    // multi-version and we don't need to be exhaustive: we just
    // want a Title + AccessConstraints + the first named layer.
    const title = matchXmlText(xml, 'Title');
    const attribution =
      matchXmlText(xml, 'AccessConstraints') ||
      matchXmlText(xml, 'OrganizationName');
    // First <Layer><Name>...</Name>. The outer Service block also
    // has Name + Title but those describe the SERVER, not the
    // layer; we want the first published layer for the form.
    const firstLayerName = firstLayerNameFromCaps(xml);
    if (!firstLayerName) {
      throw new Error('No named Layer in GetCapabilities response');
    }
    return {
      kind: 'wms',
      wmsUrl: base,
      wmsConfig: {
        layers: firstLayerName,
        format: 'image/png',
        transparent: true,
        version: '1.3.0',
        crs: 'EPSG:3857',
      },
      ...(title ? { title } : {}),
      ...(attribution ? { attribution } : {}),
    };
  }

  private async probeStyle(url: string): Promise<BasemapProbeResult | null> {
    const res = await fetchWithTimeout(url, 10_000);
    if (!res.ok) return null;
    const ctype = res.headers.get('content-type') ?? '';
    if (!/json/.test(ctype)) return null;
    const body = (await res.json()) as {
      version?: unknown;
      sources?: unknown;
      layers?: unknown;
      name?: unknown;
    };
    if (
      typeof body.version !== 'number' ||
      typeof body.sources !== 'object' ||
      !Array.isArray(body.layers)
    ) {
      return null;
    }
    const title =
      typeof body.name === 'string' && body.name.length > 0
        ? body.name
        : undefined;
    return {
      kind: 'style-url',
      styleUrl: url,
      ...(title ? { title } : {}),
    };
  }
}

/**
 * Wire shape returned by GET /admin/basemap/probe. Mirrors the
 * BasemapData shape closely so the frontend can spread it
 * straight into a form-state object.
 */
export interface BasemapProbeResult {
  kind: 'tile-url' | 'wms' | 'style-url';
  tileUrl?: string;
  styleUrl?: string;
  wmsUrl?: string;
  wmsConfig?: {
    layers: string;
    format?: string;
    transparent?: boolean;
    version?: string;
    crs?: string;
  };
  title?: string;
  attribution?: string;
  thumbnailUrl?: string;
  minZoom?: number;
  maxZoom?: number;
}

// ----------------------------------------------------------------
// helpers
// ----------------------------------------------------------------

function looksLikeXyzTemplate(url: string): boolean {
  // Accept the common placeholder shapes: {z}/{x}/{y} (XYZ
  // convention), {z}/{y}/{x} (Esri convention if the user pasted
  // a pre-shaped Esri tile URL).
  return /\{z\}.*\{x\}.*\{y\}|\{z\}.*\{y\}.*\{x\}/i.test(url);
}

function looksLikeArcgisMapServer(parsed: URL): boolean {
  // Path ends in /MapServer or /MapServer/. Anything below
  // /MapServer/ (sub-layer, query, etc.) is NOT a basemap input;
  // those are feature/raster service URLs that go through the
  // arcgis_service item type instead.
  return /\/MapServer\/?$/i.test(parsed.pathname);
}

function looksLikeWms(parsed: URL): boolean {
  const qs = parsed.searchParams;
  const service = (qs.get('service') ?? qs.get('SERVICE') ?? '').toLowerCase();
  if (service === 'wms') return true;
  // Some servers expose `/wms` or `/services/wms` paths even
  // without an explicit service= param.
  if (/(^|\/)wms(\/|$)/i.test(parsed.pathname)) return true;
  return false;
}

function matchXmlText(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(xml);
  if (!m || !m[1]) return undefined;
  // Strip surrounding whitespace + collapse internal whitespace.
  const v = m[1].replace(/\s+/g, ' ').trim();
  return v.length > 0 ? v : undefined;
}

function firstLayerNameFromCaps(xml: string): string | undefined {
  // Walk every <Layer>...<Name>X</Name>...</Layer> and pick the
  // first one. WMS capabilities nests Layer elements; the first
  // INNER one with a Name is the smallest publishable layer.
  const layerBlocks = xml.match(/<Layer\b[\s\S]*?<\/Layer>/gi);
  if (!layerBlocks) return undefined;
  for (const block of layerBlocks) {
    const m = /<Name[^>]*>([\s\S]*?)<\/Name>/i.exec(block);
    if (m && m[1] && m[1].trim().length > 0) {
      return m[1].trim();
    }
  }
  return undefined;
}

function isPrivateOrLoopbackHost(host: string): boolean {
  // Numeric IPv4
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
  // IPv6 loopback / link-local / unique-local
  if (host === '::1') return true;
  if (host.startsWith('[::1]') || host.startsWith('[fc') || host.startsWith('[fd')) {
    return true;
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  return false;
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      // Force a small user-agent so upstream logs see "GratisGIS"
      // instead of "node". Some services (looking at you, ArcGIS
      // Online tiers) gate the JSON metadata behind a UA filter.
      headers: { 'user-agent': 'GratisGIS/probe' },
    });
    return res;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new HttpException(
        'Probe timed out (10s). Check the URL or try again.',
        HttpStatus.GATEWAY_TIMEOUT,
      );
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}
