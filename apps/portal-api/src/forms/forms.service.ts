import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { V3FeaturesService } from '../features-v3/v3-features.service.js';
import { V3AttachmentsService } from '../features-v3/v3-attachments.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';

/**
 * Persistence and access control for form submissions (#131).
 *
 * Idempotency: writes go through `upsert` keyed on (formId, clientId)
 * so a re-drained offline queue is a no-op rather than a duplicate.
 *
 * Access control today:
 *   - The respondent must be able to see the form item (either by
 *     ownership, by share, or by org-wide access). We piggyback on
 *     the existing item visibility rules: if you can read the form,
 *     you can submit to it. Phase 2 introduces explicit "respondent"
 *     vs "viewer" share tiers.
 *   - Listing submissions requires either ownership of the form or
 *     org-admin role.
 */
@Injectable()
export class FormsService {
  private readonly log = new Logger(FormsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly v3Features: V3FeaturesService,
    private readonly v3Attachments: V3AttachmentsService,
  ) {}

  /** Fetch the form item, gating by visibility for the caller. Used
   *  to look up the orgId we'll stamp on the submission. Selects
   *  `data` so submit() can read linkedLayerId / linkedLayerKey for
   *  the paired-data_layer mirror write (#281e). */
  private async getVisibleForm(formId: string, user: AuthUser) {
    const item = await this.prisma.item.findUnique({
      where: { id: formId },
      select: {
        id: true,
        type: true,
        orgId: true,
        ownerId: true,
        access: true,
        title: true,
        data: true,
      },
    });
    if (!item || item.type !== 'form') {
      throw new NotFoundException('Form not found.');
    }
    // Same org check is the cheap baseline. Org-wide-public forms
    // pass; private forms only pass when the respondent has a share.
    if (item.orgId !== user.orgId) {
      throw new ForbiddenException('Form is not in your organization.');
    }
    if (item.access === 'private' && item.ownerId !== user.id) {
      const share = await this.prisma.itemShare.findFirst({
        where: {
          itemId: item.id,
          OR: [
            { principalType: 'user', principalId: user.id },
            {
              principalType: 'group',
              principalId: { in: user.groupIds },
            },
          ],
        },
        select: { itemId: true },
      });
      if (!share) {
        throw new ForbiddenException('You do not have access to this form.');
      }
    }
    return item;
  }

  async submit(
    formId: string,
    user: AuthUser,
    dto: {
      clientId: string;
      schemaVersion: number;
      response: Record<string, unknown>;
      capturedAt: string;
    },
  ): Promise<{ id: string; created: boolean }> {
    const form = await this.getVisibleForm(formId, user);
    const captured = new Date(dto.capturedAt);
    if (Number.isNaN(captured.getTime())) {
      throw new ForbiddenException('Invalid capturedAt.');
    }
    const result = await this.prisma.formSubmission.upsert({
      where: { formId_clientId: { formId: form.id, clientId: dto.clientId } },
      create: {
        formId: form.id,
        orgId: form.orgId,
        clientId: dto.clientId,
        schemaVersion: dto.schemaVersion,
        response: dto.response as Prisma.InputJsonValue,
        submittedBy: user.id,
        capturedAt: captured,
      },
      update: {}, // idempotent on re-drain; never overwrite a stored row
      select: { id: true, createdAt: true },
    });
    // `created` is true only when the row didn't already exist -- we
    // proxy it via createdAt being equal to "right now" within
    // tolerance, which is good enough for the UI and avoids a second
    // query. Phase 2 may switch to a tx-level WAS-CREATED flag.
    const justCreated =
      Date.now() - result.createdAt.getTime() < 5_000;
    // form_submission_received fan-out (#229). Only fire on real
    // first-write so a re-drained offline queue doesn't re-spam the
    // form owner. Recipient for v1 is the form item's owner; per-
    // recipient lists land with the Phase B template editor. Fire-
    // and-forget so an SMTP outage never rolls back the submission
    // the user just made.
    if (justCreated) {
      void this.notifyFormSubmissionReceived({
        formId: form.id,
        formTitle: form.title ?? 'Form',
        formOwnerId: form.ownerId,
        formData: form.data,
        submissionId: result.id,
        submitter: user,
        response: dto.response,
      });
      // Mirror the submission into the paired data_layer (#281e).
      // V1 stores everything under `properties` on the layer's
      // submissions sublayer (one row per submission). This gives
      // the form a real, queryable, map-friendly home immediately;
      // the schema-mutation API in #281b will later split the
      // properties JSONB into typed columns per question.
      //
      // Only on first-write so an offline re-drain doesn't duplicate
      // the layer row. Failures are non-fatal: form_submission is
      // the durable source of truth; a missed mirror just means the
      // layer is out of date until a backfill pass.
      void this.mirrorToPairedLayer({
        form,
        clientId: dto.clientId,
        submissionId: result.id,
        schemaVersion: dto.schemaVersion,
        response: dto.response,
        submittedBy: user.id,
        capturedAt: captured,
        user,
      }).catch((err) => {
        this.log.warn(
          `mirrorToPairedLayer failed for submission ${result.id}: ${
            err instanceof Error ? err.message : err
          }`,
        );
      });
    }
    return { id: result.id, created: justCreated };
  }

  /**
   * Insert a row into the form's paired data_layer (#281e). The
   * form's `data.linkedLayerId` (set at create time by #283) points
   * at the layer; `data.linkedLayerKey` names the sublayer to
   * write into. If either is absent, this is a no-op: the form
   * pre-dates the auto-paired-layer feature, or the linkage has
   * been deliberately removed.
   *
   * V1 wire shape: globalId = the form_submission row id (so the
   * layer row and the JSONB row can be joined later); properties =
   * { ...response, _submitted_at, _submitted_by, _client_id,
   * _schema_version }. The leading-underscore keys mirror the
   * v3 feature-tracking convention (#39 / #118) and stay distinct
   * from any user-defined question name.
   */
  private async mirrorToPairedLayer(args: {
    form: { id: string; data: Prisma.JsonValue };
    clientId: string;
    submissionId: string;
    schemaVersion: number;
    response: Record<string, unknown>;
    submittedBy: string;
    capturedAt: Date;
    user: AuthUser;
  }): Promise<void> {
    const data = args.form.data as
      | { linkedLayerId?: unknown; linkedLayerKey?: unknown }
      | null;
    const layerId =
      data && typeof data.linkedLayerId === 'string'
        ? data.linkedLayerId
        : null;
    const layerKey =
      data && typeof data.linkedLayerKey === 'string'
        ? data.linkedLayerKey
        : 'submissions';
    if (!layerId) return;

    // Split attachment-shaped values out of the response BEFORE we
    // dump the rest into properties JSONB (#292). Form attachments
    // shouldn't sit inline on the parent row -- they belong in the
    // standard v3 feature_attachment table the same way every other
    // data_layer attaches files. The form runtime stores each
    // attachment as { name, mimeType, sizeBytes, url, key } per
    // upload (see #280); we detect that shape here.
    const attachments = extractAttachments(args.response);
    const responseSansAttachments = stripAttachments(args.response);

    const properties: Record<string, unknown> = {
      ...responseSansAttachments,
      _submission_id: args.submissionId,
      _client_id: args.clientId,
      _schema_version: args.schemaVersion,
      _submitted_at: args.capturedAt.toISOString(),
      _submitted_by: args.submittedBy,
    };

    // #323: extract the geometry value from the response when the
    // form has a geo-question binding. The paired-layer-upgrade
    // path in items.service.ts already promoted the layer's
    // geometryType when the form was last saved; we look up the
    // current geometryType off the layer here so we know whether to
    // pass isTable (no geom column) or pack a real GeoJSON geometry.
    const layerRow = await this.prisma.item.findUnique({
      where: { id: layerId },
      select: { data: true },
    });
    const sublayerGeomType = readSublayerGeometryType(
      layerRow?.data,
      layerKey,
    );
    const isTable = sublayerGeomType === null;
    let geometry: unknown = undefined;
    if (!isTable) {
      const binding = pickFormGeometryBinding(args.form.data);
      if (binding) {
        geometry = responseValueToGeoJson(
          (args.response as Record<string, unknown>)[binding.questionId],
          binding.geometryType,
        );
      }
    }

    await this.v3Features.insertFeatures(
      layerId,
      layerKey,
      [
        {
          globalId: args.submissionId,
          properties,
          ...(geometry !== undefined ? { geometry } : {}),
        },
      ],
      args.user,
      // Table sublayer (geometryType=null) skips the geom column
      // entirely (#192). Geo sublayers go through the spatial
      // INSERT branch and pick up the geom from feature.geometry.
      { isTable },
    );

    // Register each attachment in the v3 feature_attachment table
    // keyed on (layerId=submissions, featureId=submissionId). Errors
    // are logged but don't fail the submission: the JSONB form_
    // submission row is the authoritative copy and the attachment
    // file already lives in MinIO.
    for (const att of attachments) {
      try {
        await this.v3Attachments.register(
          layerId,
          layerKey,
          args.submissionId,
          {
            fileName: att.name,
            mime: att.mimeType,
            sizeBytes: att.sizeBytes,
            storageKey: att.key,
            storageUrl: att.url,
          },
          args.submittedBy,
        );
      } catch (err) {
        this.log.warn(
          `attachment register failed for submission ${args.submissionId}: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }
  }

  /**
   * Helper for the form_submission_received notification (#229, #190).
   *
   * Resolves the submitter's display name, builds a rendered receipt
   * (every answered question on the form, in presentation order) from
   * the form schema + response, and fans out the email to:
   *
   *   - The form owner, when `notify.notifyOwner` is unset or true
   *     (default).
   *   - Every address in `notify.extraRecipients` (#190 Phase 1).
   *
   * Owner fan-out goes through `notify()` so per-user preferences
   * still apply (the owner can mute the type from their settings).
   * Extra recipients go through `notifyAddress()` which bypasses
   * preferences -- they're addresses chosen by the form author, not
   * users with their own opt-in.
   *
   * Errors are swallowed: a queued notification failing must never
   * roll back the submission the user just made.
   */
  private async notifyFormSubmissionReceived(args: {
    formId: string;
    formTitle: string;
    formOwnerId: string;
    formData: Prisma.JsonValue;
    submissionId: string;
    submitter: AuthUser;
    response: Record<string, unknown>;
  }): Promise<void> {
    try {
      const submitterRow = await this.prisma.user.findUnique({
        where: { id: args.submitter.id },
        select: { fullName: true, username: true },
      });
      const submittedByName =
        submitterRow?.fullName || submitterRow?.username || 'Someone';
      const summary = pickResponseSummary(args.response);
      const answers = renderAnswers(args.formData, args.response);
      const payload: Prisma.InputJsonValue = {
        formItemId: args.formId,
        formTitle: args.formTitle,
        submissionId: args.submissionId,
        submittedByName,
        summary,
        answers,
      };

      // notify.notifyOwner defaults to true. Read it off the form's
      // data JSON (the FormSchema). Any non-object data shape (legacy
      // forms, malformed) falls back to the default behavior.
      const notifyCfg =
        args.formData &&
        typeof args.formData === 'object' &&
        !Array.isArray(args.formData)
          ? ((args.formData as { notify?: unknown }).notify as
              | { notifyOwner?: unknown; extraRecipients?: unknown }
              | undefined)
          : undefined;
      const notifyOwner = notifyCfg?.notifyOwner !== false;
      const extras = Array.isArray(notifyCfg?.extraRecipients)
        ? (notifyCfg!.extraRecipients as unknown[])
            .filter((e): e is string => typeof e === 'string')
            .map((e) => e.trim())
            .filter((e) => e.length > 0 && e.includes('@'))
        : [];

      // Resolve the owner's email up front so we can de-dup against
      // extras: an author who lists themselves in extraRecipients
      // shouldn't get two copies. Lower-case for case-insensitive
      // compare; the worker still sends to the canonical-cased address
      // we capture on the row.
      const ownerRow = notifyOwner
        ? await this.prisma.user.findUnique({
            where: { id: args.formOwnerId },
            select: { email: true },
          })
        : null;
      const ownerEmailLower = (ownerRow?.email ?? '').toLowerCase();

      if (notifyOwner) {
        await this.notifications.notify(
          args.formOwnerId,
          'form_submission_received',
          payload,
        );
      }
      for (const addr of extras) {
        if (ownerEmailLower && addr.toLowerCase() === ownerEmailLower) {
          continue;
        }
        await this.notifications.notifyAddress(
          args.formOwnerId,
          'form_submission_received',
          payload,
          addr,
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `form_submission_received notify failed: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  async list(
    formId: string,
    user: AuthUser,
    opts: { limit?: number } = {},
  ): Promise<
    Array<{
      id: string;
      clientId: string;
      response: unknown;
      submittedBy: string | null;
      capturedAt: string;
      createdAt: string;
      schemaVersion: number;
    }>
  > {
    const form = await this.getVisibleForm(formId, user);
    if (form.ownerId !== user.id && user.orgRole !== 'admin') {
      throw new ForbiddenException(
        'Only the form owner or an org admin can view submissions.',
      );
    }
    const rows = await this.prisma.formSubmission.findMany({
      where: { formId: form.id },
      orderBy: { createdAt: 'desc' },
      take: Math.max(1, Math.min(opts.limit ?? 100, 500)),
      select: {
        id: true,
        clientId: true,
        response: true,
        submittedBy: true,
        capturedAt: true,
        createdAt: true,
        schemaVersion: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      clientId: r.clientId,
      response: r.response,
      submittedBy: r.submittedBy,
      capturedAt: r.capturedAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
      schemaVersion: r.schemaVersion,
    }));
  }

  async count(formId: string, user: AuthUser): Promise<number> {
    const form = await this.getVisibleForm(formId, user);
    if (form.ownerId !== user.id && user.orgRole !== 'admin') {
      throw new ForbiddenException(
        'Only the form owner or an org admin can view submission counts.',
      );
    }
    return this.prisma.formSubmission.count({ where: { formId: form.id } });
  }
}

/**
 * Best-effort summary string for form_submission_received emails.
 * The form response shape is `{ [questionId]: answer }` where answer
 * may be a string, number, boolean, array, or nested object (for
 * groups / repeats). We pick the first non-empty primitive we hit so
 * the subject reads "New submission: <something useful>" rather
 * than a uuid. Underscore-prefixed keys (system metadata) are
 * skipped. Falls back to a short literal when nothing's available.
 */
function pickResponseSummary(
  response: Record<string, unknown> | undefined,
): string {
  if (!response) return '(no answers)';
  for (const [k, v] of Object.entries(response)) {
    if (k.startsWith('_')) continue;
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'object') continue;
    const s = String(v);
    return s.length > 80 ? `${s.slice(0, 77)}...` : s;
  }
  return '(no answers)';
}

/**
 * Form attachment shape produced by the form-runtime upload helper
 * (apps/portal-web/src/lib/form-attachment-upload.ts) once #280's
 * direct-to-MinIO upload completes. The same shape lives in the form
 * response for photo / audio / video / file / sketch / signature
 * questions: each question's value is an array of these descriptors.
 */
interface AttachmentDescriptor {
  name: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  key: string;
}

function isAttachmentDescriptor(v: unknown): v is AttachmentDescriptor {
  if (!v || typeof v !== 'object') return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.url === 'string' &&
    typeof a.key === 'string' &&
    typeof a.name === 'string' &&
    typeof a.mimeType === 'string' &&
    typeof a.sizeBytes === 'number'
  );
}

/**
 * Walk a form response and collect every uploaded attachment
 * descriptor. Photo / audio / video / file question values are
 * arrays of descriptors; the walk is recursive so attachments
 * inside repeating-group instances (response[groupId][i].photo)
 * also get picked up.
 *
 * Pending offline-queued attachments (objects with `dataUrl` but no
 * `url`) shouldn't reach here -- the form-runtime drain step
 * (#280) uploads them and replaces them with the uploaded shape
 * before POSTing. If one slips through anyway, isAttachmentDescriptor
 * rejects it and the value stays in properties JSONB; the form
 * still works, the attachment just doesn't register in
 * feature_attachment until a manual re-upload.
 */
function extractAttachments(
  response: Record<string, unknown>,
): AttachmentDescriptor[] {
  const out: AttachmentDescriptor[] = [];
  function walk(node: unknown): void {
    if (Array.isArray(node)) {
      for (const item of node) {
        if (isAttachmentDescriptor(item)) {
          out.push(item);
        } else {
          walk(item);
        }
      }
      return;
    }
    if (node && typeof node === 'object') {
      for (const v of Object.values(node)) walk(v);
    }
  }
  walk(response);
  return out;
}

/**
 * Return a deep copy of the response with every attachment array
 * stripped (replaced with an empty array, so question keys still
 * resolve to a defined value). Avoids storing 5+ MB of attachment
 * descriptors in the parent row's properties JSONB when those
 * descriptors live more naturally in feature_attachment.
 *
 * Non-attachment data inside repeat groups is preserved; only the
 * attachment-shaped sub-arrays are replaced with [].
 */
function stripAttachments(
  response: Record<string, unknown>,
): Record<string, unknown> {
  const clone = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      // An array purely of attachment descriptors -> empty array.
      // Mixed arrays (shouldn't happen with current question types
      // but defensive) keep their non-attachment items.
      const filtered = node
        .map((item) =>
          isAttachmentDescriptor(item) ? null : clone(item),
        )
        .filter((item) => item !== null);
      return filtered;
    }
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) out[k] = clone(v);
      return out;
    }
    return node;
  };
  return clone(response) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// #325 geometry-binding helpers for the form-mirror submit path.
//
// These read the paired data_layer's logical schema + the form's
// FormSchema and pull the geo answer out of the response so the v3
// insert can ride the spatial INSERT branch with a real GeoJSON
// geometry. Without this, a form with a geopoint question would land
// the lat/lng pair in the properties JSONB but never populate the
// geom column, leaving the row invisible to map runtimes.
// ---------------------------------------------------------------------------

/**
 * Read the geometryType for a specific sublayer off a data_layer
 * item's `data` blob. Returns 'point' / 'line' / 'polygon' for a
 * spatial sublayer, null for a non-spatial table sublayer, and null
 * when the blob doesn't look like v3 layer data (defensive default,
 * since the caller treats null as "no geom column" which is also
 * the correct fallback for a malformed schema).
 */
function readSublayerGeometryType(
  data: Prisma.JsonValue | null | undefined,
  layerKey: string,
): 'point' | 'line' | 'polygon' | null {
  if (!data || typeof data !== 'object') return null;
  const layers = (data as { layers?: unknown }).layers;
  if (!Array.isArray(layers)) return null;
  for (const l of layers) {
    if (!l || typeof l !== 'object') continue;
    const id = (l as { id?: unknown }).id;
    if (id !== layerKey) continue;
    const g = (l as { geometryType?: unknown }).geometryType;
    if (g === 'point' || g === 'line' || g === 'polygon') return g;
    return null;
  }
  return null;
}

/**
 * Find the form's geometry-binding question. Walks top-level
 * questions and (recursively) non-repeat group children -- repeat
 * groups carry their own per-instance geometry on the related child
 * layer, not on the parent submission. Returns the first geo question
 * encountered; multiple geo questions on one form would each need
 * their own column and we don't support that yet.
 *
 * This mirrors the walk in syncPairedLayerColumns (see
 * apps/portal-web/.../form/designer.tsx) so promotion + submit pick
 * the same question.
 */
function pickFormGeometryBinding(
  formData: Prisma.JsonValue | null | undefined,
):
  | { questionId: string; geometryType: 'point' | 'line' | 'polygon' }
  | null {
  if (!formData || typeof formData !== 'object') return null;
  const questions = (formData as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return null;

  function walk(
    qs: unknown[],
  ):
    | { questionId: string; geometryType: 'point' | 'line' | 'polygon' }
    | null {
    for (const qRaw of qs) {
      if (!qRaw || typeof qRaw !== 'object') continue;
      const q = qRaw as {
        type?: unknown;
        id?: unknown;
        repeat?: unknown;
        children?: unknown;
      };
      if (q.type === 'group') {
        if (!q.repeat && Array.isArray(q.children)) {
          const inner = walk(q.children);
          if (inner) return inner;
        }
        continue;
      }
      if (typeof q.id !== 'string') continue;
      if (q.type === 'geopoint') {
        return { questionId: q.id, geometryType: 'point' };
      }
      if (q.type === 'geotrace') {
        return { questionId: q.id, geometryType: 'line' };
      }
      if (q.type === 'geoshape') {
        return { questionId: q.id, geometryType: 'polygon' };
      }
    }
    return null;
  }
  return walk(questions);
}

/**
 * Convert a form-runtime geo answer into a GeoJSON geometry suitable
 * for the v3 insert path. The form runtime's geopoint question stores
 * `{ lat, lng, accuracy? }`; geotrace / geoshape land as arrays of
 * those pairs. Anything we don't recognize returns undefined so the
 * insert path falls back to the existing "no geometry on this row"
 * behavior rather than throwing -- a malformed answer should never
 * fail the whole submission.
 */
function responseValueToGeoJson(
  value: unknown,
  geometryType: 'point' | 'line' | 'polygon',
): unknown | undefined {
  if (value === null || value === undefined) return undefined;
  if (geometryType === 'point') {
    if (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { lat?: unknown }).lat === 'number' &&
      typeof (value as { lng?: unknown }).lng === 'number'
    ) {
      const v = value as { lat: number; lng: number };
      return { type: 'Point', coordinates: [v.lng, v.lat] };
    }
    return undefined;
  }
  // Line / polygon: form runtime hasn't shipped a tracer / shape
  // capture UI yet (designer-only previews). Once it does, expand
  // here with the same shape contract.
  return undefined;
}

/**
 * Build the rendered-receipt list for a submission email (#190).
 *
 * Walks the form schema in presentation order and emits one
 * `{ label, value }` row per answered question. The walk:
 *
 *   - Skips layout-only types (note, page) -- they capture nothing.
 *   - Recurses into non-repeat groups, since their children write
 *     at the TOP LEVEL of the response (per #288). That keeps the
 *     receipt flat and matches the runtime's read/write model.
 *   - Treats repeat groups as a single row labeled with the count
 *     ("Inspections: 3 entries"); the per-instance details land in
 *     a related child layer (#246 pattern), so the email points to
 *     the count and the deep link rather than inlining nested rows.
 *   - Resolves select-one / select-many choice VALUES to their LABELS
 *     when the schema carries them inline. Pick-list-sourced choices
 *     fall back to the value (resolving them needs a DB hit; not
 *     worth it for an email line).
 *   - Renders attachment-array values as a compact count
 *     ("Photo: 2 files") rather than dumping signed URLs.
 *
 * Returns an empty array if the form schema isn't parseable; the
 * renderer falls back to `summary` in that case.
 */
function renderAnswers(
  formData: Prisma.JsonValue,
  response: Record<string, unknown> | undefined,
): Array<{ label: string; value: string }> {
  if (!response || !formData || typeof formData !== 'object' || Array.isArray(formData)) {
    return [];
  }
  const data = formData as { questions?: unknown };
  const questions = Array.isArray(data.questions) ? data.questions : null;
  if (!questions) return [];
  const out: Array<{ label: string; value: string }> = [];
  for (const q of questions) {
    walkQuestionForAnswer(q, response, out);
  }
  return out;
}

function walkQuestionForAnswer(
  q: unknown,
  response: Record<string, unknown>,
  out: Array<{ label: string; value: string }>,
): void {
  if (!q || typeof q !== 'object') return;
  const qq = q as {
    id?: unknown;
    type?: unknown;
    label?: unknown;
    repeat?: unknown;
    children?: unknown;
    choices?: unknown;
  };
  const type = typeof qq.type === 'string' ? qq.type : '';
  const id = typeof qq.id === 'string' ? qq.id : '';
  if (!id || !type) return;

  // Layout-only: nothing to render in the receipt.
  if (type === 'note' || type === 'page') return;

  if (type === 'group') {
    const children = Array.isArray(qq.children) ? qq.children : [];
    if (qq.repeat && typeof qq.repeat === 'object') {
      // Repeating group -- show count as a single row.
      const raw = response[id];
      const count = Array.isArray(raw) ? raw.length : 0;
      if (count > 0) {
        const label = labelOf(qq, id);
        out.push({
          label,
          value: count === 1 ? '1 entry' : `${count} entries`,
        });
      }
      return;
    }
    // Non-repeat group: descend; children write at top level.
    for (const child of children) walkQuestionForAnswer(child, response, out);
    return;
  }

  const raw = response[id];
  if (raw === null || raw === undefined || raw === '') return;

  const label = labelOf(qq, id);
  const formatted = formatAnswerValue(raw, type, qq.choices);
  if (formatted === null) return;
  out.push({ label, value: formatted });
}

function labelOf(
  q: { id?: unknown; label?: unknown },
  fallback: string,
): string {
  const lbl = typeof q.label === 'string' && q.label.trim().length > 0
    ? q.label.trim()
    : fallback;
  // Trim runaway labels so a malicious / verbose author can't blow up
  // the email body width.
  return lbl.length > 120 ? `${lbl.slice(0, 117)}...` : lbl;
}

function formatAnswerValue(
  value: unknown,
  type: string,
  choicesRaw: unknown,
): string | null {
  // Attachment arrays render as a compact count.
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.every((v) => isAttachmentDescriptor(v))) {
      return value.length === 1 ? '1 file' : `${value.length} files`;
    }
    // Multi-choice / ranking / multi-image-choice (#295): array of
    // primitive choice values. Resolve through inline `choices` to
    // labels when possible, comma-join.
    if (
      value.every(
        (v) =>
          v === null ||
          typeof v === 'string' ||
          typeof v === 'number' ||
          typeof v === 'boolean',
      )
    ) {
      const lookup = buildChoiceLookup(choicesRaw);
      const parts = value
        .filter((v) => v !== null && v !== '')
        .map((v) => lookup.get(String(v)) ?? String(v));
      if (parts.length === 0) return null;
      return parts.join(', ');
    }
    // Heterogeneous / nested array (matrix-multi etc.) -- fall back
    // to a JSON snippet so the receipt at least carries something.
    try {
      const json = JSON.stringify(value);
      return json.length > 200 ? `${json.slice(0, 197)}...` : json;
    } catch {
      return null;
    }
  }

  // Object value (matrix, signature object, etc.) -- compact JSON.
  if (value && typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      return json.length > 200 ? `${json.slice(0, 197)}...` : json;
    } catch {
      return null;
    }
  }

  if (typeof value === 'boolean') return value ? 'Yes' : 'No';

  // select-one: resolve value to label when inline choices exist.
  if (type === 'select-one' && typeof value === 'string') {
    const lookup = buildChoiceLookup(choicesRaw);
    return lookup.get(value) ?? value;
  }

  const s = String(value);
  return s.length > 500 ? `${s.slice(0, 497)}...` : s;
}

function buildChoiceLookup(choicesRaw: unknown): Map<string, string> {
  const lookup = new Map<string, string>();
  if (!Array.isArray(choicesRaw)) return lookup;
  for (const c of choicesRaw) {
    if (!c || typeof c !== 'object') continue;
    const cc = c as { value?: unknown; label?: unknown };
    if (typeof cc.value === 'string' && typeof cc.label === 'string') {
      lookup.set(cc.value, cc.label);
    }
  }
  return lookup;
}
