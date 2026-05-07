// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable } from '@nestjs/common';
import { NotificationChannel, NotificationType } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import {
  renderNotification,
  type RenderContext,
  type RenderedNotification,
} from './templates.js';
import { SAMPLE_PAYLOADS } from './sample-payloads.js';

/**
 * Per-org override layer for the per-NotificationType template
 * registry baked into templates.ts (#229 Phase B).
 *
 * Precedence chain at render time:
 *
 *   notification_template (orgId, type, channel)  >  hardcoded default
 *
 * The override row stores three fields: `subject`, `bodyText`,
 * `bodyHtml`. Each is a mustache-lite template that gets substituted
 * against the payload + RenderContext at send time. The substitution
 * grammar is intentionally tiny -- {{varName}} in the template
 * pulls from `{ ...payload, orgLabel, baseUrl }` and HTML-escapes
 * by default. {{{varName}}} (triple braces) skips escaping for
 * fields the admin already trusts (e.g. an HTML snippet baked into
 * the bodyHtml). No conditionals, no loops, no helpers -- if an
 * admin needs that level of power they can paste in a different
 * template per type. This keeps the renderer ~30 lines and trivial
 * to audit.
 *
 * Sparse-write contract: clearOverride() deletes the row so the
 * runtime falls back to the hardcoded default. This matches the
 * notification_type_default table's behavior and keeps the table
 * minimal.
 */
@Injectable()
export class NotificationTemplateService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Look up the per-org override for (type, channel) and return a
   * fully-rendered notification. Returns null when no override
   * exists -- the caller should fall back to the hardcoded
   * renderNotification() in templates.ts.
   */
  async renderOverride(
    orgId: string,
    type: NotificationType,
    channel: NotificationChannel,
    payload: unknown,
    ctx: RenderContext,
  ): Promise<RenderedNotification | null> {
    const row = await this.prisma.notificationTemplate.findUnique({
      where: { orgId_type_channel: { orgId, type, channel } },
    });
    if (!row) return null;
    return substituteTemplate(
      { subject: row.subject, bodyText: row.bodyText, bodyHtml: row.bodyHtml },
      payload,
      ctx,
    );
  }

  /**
   * Resolve the effective template (override or default) and produce
   * a sample render. Used by the admin preview endpoint so changing
   * the body in the editor surfaces the new copy without firing a
   * real trigger.
   */
  async previewEffective(
    orgId: string,
    type: NotificationType,
    channel: NotificationChannel,
    ctx: RenderContext,
  ): Promise<RenderedNotification | null> {
    const payload = SAMPLE_PAYLOADS[type];
    if (payload === undefined) return null;
    const override = await this.renderOverride(orgId, type, channel, payload, ctx);
    if (override) return override;
    return renderNotification(type, payload, ctx);
  }

  /**
   * Preview an unsaved template. The admin Edit UI calls this with
   * the in-flight subject/body strings so they can see the result
   * before clicking Save. The renderer is the same one
   * renderOverride() uses, just without the DB lookup.
   */
  previewUnsaved(
    template: { subject: string; bodyText: string; bodyHtml: string },
    type: NotificationType,
    ctx: RenderContext,
  ): RenderedNotification | null {
    const payload = SAMPLE_PAYLOADS[type];
    if (payload === undefined) return null;
    return substituteTemplate(template, payload, ctx);
  }

  /**
   * Materialised list for the admin templates page: every (type,
   * channel) the catalog declares for this org, with a flag
   * indicating whether the org has saved a custom override.
   */
  async list(orgId: string): Promise<
    Array<{
      type: NotificationType;
      channel: NotificationChannel;
      isOverride: boolean;
      updatedAt: string | null;
    }>
  > {
    const rows = await this.prisma.notificationTemplate.findMany({
      where: { orgId },
      select: { type: true, channel: true, updatedAt: true },
    });
    return rows.map((r) => ({
      type: r.type,
      channel: r.channel,
      isOverride: true,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  /** Read one override row. Returns null when no override is set. */
  async get(
    orgId: string,
    type: NotificationType,
    channel: NotificationChannel,
  ): Promise<{
    subject: string;
    bodyText: string;
    bodyHtml: string;
    updatedAt: string;
  } | null> {
    const row = await this.prisma.notificationTemplate.findUnique({
      where: { orgId_type_channel: { orgId, type, channel } },
    });
    if (!row) return null;
    return {
      subject: row.subject,
      bodyText: row.bodyText,
      bodyHtml: row.bodyHtml,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Upsert an override. */
  async setOverride(
    orgId: string,
    type: NotificationType,
    channel: NotificationChannel,
    template: { subject: string; bodyText: string; bodyHtml: string },
  ): Promise<void> {
    await this.prisma.notificationTemplate.upsert({
      where: { orgId_type_channel: { orgId, type, channel } },
      create: { orgId, type, channel, ...template },
      update: { ...template },
    });
  }

  /** Delete an override so the runtime falls back to the hardcoded
   *  default. Idempotent: calling on a missing row is a no-op. */
  async clearOverride(
    orgId: string,
    type: NotificationType,
    channel: NotificationChannel,
  ): Promise<void> {
    await this.prisma.notificationTemplate.deleteMany({
      where: { orgId, type, channel },
    });
  }
}

/**
 * Mustache-lite substitution. The grammar is:
 *
 *   {{name}}    -- HTML-escaped value of payload[name] or ctx[name]
 *   {{{name}}}  -- raw value, no escaping (HTML pass-through)
 *   missing     -- empty string
 *
 * Subject + bodyText skip HTML escaping entirely (they're not HTML
 * contexts). bodyHtml respects the {{ }} vs {{{ }}} distinction.
 *
 * Exported for unit tests; the production callers go through
 * NotificationTemplateService.
 */
export function substituteTemplate(
  template: { subject: string; bodyText: string; bodyHtml: string },
  payload: unknown,
  ctx: RenderContext,
): RenderedNotification {
  const scope: Record<string, unknown> = {
    ...(typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)
      : {}),
    orgLabel: ctx.orgLabel,
    baseUrl: ctx.baseUrl,
  };
  const subject = renderPlain(template.subject, scope);
  const text = renderPlain(template.bodyText, scope);
  const html = renderHtml(template.bodyHtml, scope);
  return { subject, text, html };
}

/** Plain (non-HTML) substitution: no escaping, only {{ }} replaced. */
function renderPlain(input: string, scope: Record<string, unknown>): string {
  // Triple-brace and double-brace look the same in plain text, so a
  // single regex that strips both is fine here. Use the longest-
  // delimiter-first ordering so `{{{a}}}` doesn't get matched as
  // `{{` then a literal `{a}}}`.
  return input.replace(/\{\{\{?\s*([\w.]+)\s*\}?\}\}/g, (_, key) => {
    const v = scope[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

/** HTML substitution: {{ }} HTML-escapes, {{{ }}} passes through. */
function renderHtml(input: string, scope: Record<string, unknown>): string {
  // Match triple-brace first so the double-brace regex doesn't
  // greedy-eat a `{{{ }}}` block.
  let out = input.replace(/\{\{\{\s*([\w.]+)\s*\}\}\}/g, (_, key) => {
    const v = scope[key];
    return v === undefined || v === null ? '' : String(v);
  });
  out = out.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const v = scope[key];
    if (v === undefined || v === null) return '';
    return escapeHtml(String(v));
  });
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
