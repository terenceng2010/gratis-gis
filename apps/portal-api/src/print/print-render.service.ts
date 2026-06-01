// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import puppeteer from 'puppeteer-core';
import {
  resolvePaperInches,
  type PrintPaperSpec,
} from '@gratis-gis/shared-types';

import { PrismaService } from '../prisma/prisma.service.js';
import { ItemsService } from '../items/items.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';

/**
 * #159 Phase 2 server-side render path.
 *
 * Connects to one of the configured browserless sidecars
 * (load-balanced random pick), navigates to the internal
 * print-preview route on portal-web, renders the page at the
 * template's paper size, returns the PDF bytes.
 *
 * Authentication for the preview route: portal-api mints a
 * single-use token, stores it in-memory with a 60-second TTL,
 * and hands the chromium sidecar a URL with `?renderToken=...`.
 * The preview route on portal-web validates the token against
 * a portal-api callback before rendering, so the public can't
 * just hit the preview URL and exfiltrate map data they can't
 * otherwise read.
 */
const TOKEN_TTL_MS = 60_000;

@Injectable()
export class PrintRenderService {
  private readonly log = new Logger(PrintRenderService.name);
  private readonly tokens = new Map<
    string,
    { userId: string; templateId: string; mapId: string; expiresAt: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly items: ItemsService,
  ) {}

  /**
   * Validate a render token against the server's in-memory map.
   * Used by the preview route's "is this caller legit?" callback.
   * Tokens are single-use: a successful validation consumes the
   * entry.
   */
  consumeToken(token: string): { userId: string; templateId: string; mapId: string } | null {
    const entry = this.tokens.get(token);
    if (!entry) return null;
    this.tokens.delete(token);
    if (entry.expiresAt < Date.now()) return null;
    return {
      userId: entry.userId,
      templateId: entry.templateId,
      mapId: entry.mapId,
    };
  }

  async render(
    user: AuthUser,
    args: {
      templateId: string;
      mapId: string;
      parameterValues?: Record<string, string>;
    },
  ): Promise<Buffer> {
    // 1. Load + permission-check both items via the items service.
    const template = await this.items.get(user, args.templateId);
    if (template.type !== 'print_template') {
      throw new BadRequestException(
        `Item ${args.templateId} is not a print_template`,
      );
    }
    const map = await this.items.get(user, args.mapId);
    if (map.type !== 'map') {
      throw new BadRequestException(`Item ${args.mapId} is not a map`);
    }
    const paper = (
      (template.data as { paper?: PrintPaperSpec } | null)?.paper ?? {
        size: 'letter',
        orientation: 'portrait',
        marginIn: 0.25,
      }
    ) as PrintPaperSpec;

    // 2. Mint a render token, drop it into the in-memory map.
    const token = randomBytes(24).toString('hex');
    this.tokens.set(token, {
      userId: user.id,
      templateId: args.templateId,
      mapId: args.mapId,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });

    // 3. Pick a chromium endpoint at random for load balancing.
    const endpoints = (process.env.CHROMIUM_WS_ENDPOINTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (endpoints.length === 0) {
      throw new ServiceUnavailableException(
        'No chromium endpoints configured (CHROMIUM_WS_ENDPOINTS)',
      );
    }
    const endpoint = endpoints[Math.floor(Math.random() * endpoints.length)]!;
    const previewBase = process.env.PRINT_PREVIEW_BASE_URL ?? 'http://portal-web:3000';

    // 4. Build the preview URL with the token + parameter values
    //    encoded as a single ?p=<base64-json> blob so the URL
    //    stays short even for templates with many parameters.
    const paramsBlob = Buffer.from(
      JSON.stringify(args.parameterValues ?? {}),
    ).toString('base64url');
    const previewUrl =
      `${previewBase}/print-preview/${encodeURIComponent(args.templateId)}` +
      `?map=${encodeURIComponent(args.mapId)}` +
      `&renderToken=${encodeURIComponent(token)}` +
      `&p=${paramsBlob}`;

    // 5. Connect, navigate, page.pdf, return bytes.
    const inches = resolvePaperInches(paper);
    const browser = await puppeteer.connect({ browserWSEndpoint: endpoint });
    try {
      const page = await browser.newPage();
      try {
        await page.setViewport({
          width: Math.round(inches.w * 96),
          height: Math.round(inches.h * 96),
        });
        await page.goto(previewUrl, {
          waitUntil: 'networkidle0',
          timeout: 30_000,
        });
        const pdf = await page.pdf({
          printBackground: true,
          preferCSSPageSize: false,
          width: `${inches.w}in`,
          height: `${inches.h}in`,
          margin: {
            top: `${paper.marginIn}in`,
            right: `${paper.marginIn}in`,
            bottom: `${paper.marginIn}in`,
            left: `${paper.marginIn}in`,
          },
        });
        // puppeteer.page.pdf returns Uint8Array on recent versions;
        // wrap as a Buffer so the controller can stream it.
        return Buffer.from(pdf);
      } finally {
        await page.close().catch(() => undefined);
      }
    } finally {
      await browser.disconnect();
    }
  }
}
