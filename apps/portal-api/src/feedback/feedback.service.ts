// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger } from '@nestjs/common';

import { EmailTransport } from '../notifications/email-transport.js';

export interface FeedbackInput {
  /** Optional sender name. Free-form; not validated against any user table. */
  name?: string;
  /** Optional sender email so the maintainer can reply. */
  email?: string;
  /** Required body of the feedback. */
  message: string;
  /** Optional page URL the user was on when they opened the form. */
  pageUrl?: string;
  /** Optional user-agent string. */
  userAgent?: string;
  /** IP address of the caller, captured server-side. */
  ip: string;
}

/**
 * Anonymous feedback intake (#146). The whole point is that a tester
 * who does not have (and does not want) a GitHub account can still
 * leave a comment on the public test instance. The service:
 *
 *   - Validates message presence (controller-level DTO catches it
 *     too, this is defense in depth).
 *   - Routes the message to the maintainer inbox via the existing
 *     EmailTransport. The recipient is read from
 *     FEEDBACK_RECIPIENT_EMAIL with a sensible fallback so a
 *     fresh deploy with no env setup still has somewhere to land.
 *   - Falls back to a structured logger.warn() when SMTP is not
 *     configured. The submission still succeeds from the user's
 *     point of view; the maintainer can scrape the log later.
 *     This keeps the form usable even on a deploy that hasn't
 *     configured SMTP yet (the common "I just stood up the portal"
 *     case).
 *   - Never echoes the submission back to the client beyond a
 *     plain `{ ok: true }`. No id, no email-status leak.
 */
@Injectable()
export class FeedbackService {
  private readonly log = new Logger(FeedbackService.name);

  constructor(private readonly mail: EmailTransport) {}

  async submit(input: FeedbackInput): Promise<void> {
    const recipient = resolveRecipient();
    const subject = renderSubject(input);
    const { text, html } = renderBody(input);

    // Always log so the maintainer has a backup record even when
    // SMTP delivery succeeds (and especially when it doesn't).
    // PII-light: we log the email + IP because they are how the
    // maintainer would chase down a bad-faith submission, but we
    // do NOT log the message body (it might contain whatever the
    // user just typed). The body lives only in the outbound email.
    this.log.log(
      `feedback received from=${input.email ?? '(no email)'} ip=${input.ip} ua="${truncate(
        input.userAgent ?? '',
        80,
      )}" page="${truncate(input.pageUrl ?? '', 80)}" len=${input.message.length}`,
    );

    if (!(await this.mail.isAvailable())) {
      // SMTP not configured. We deliberately do not surface this to
      // the client; from their point of view the submission "went
      // through" (their words landed somewhere durable, which is
      // the log). Log the full body here so the maintainer can
      // recover it after configuring SMTP.
      this.log.warn(
        `SMTP not configured; feedback body logged below.\n---\nFrom: ${
          input.email ?? '(no email)'
        }\nName: ${input.name ?? '(no name)'}\nPage: ${input.pageUrl ?? ''}\n---\n${
          input.message
        }\n---`,
      );
      return;
    }

    try {
      await this.mail.send({
        to: recipient,
        subject,
        text,
        html,
      });
    } catch (err) {
      // Mail delivery failed. Log the body so it is recoverable,
      // and throw so the controller can return a 502 to the user
      // (they can retry; they shouldn't see "success" when the
      // mail did NOT go out).
      this.log.error(
        `feedback delivery failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      this.log.warn(
        `Lost-to-SMTP feedback body recovered below.\n---\nFrom: ${
          input.email ?? '(no email)'
        }\nName: ${input.name ?? '(no name)'}\nPage: ${input.pageUrl ?? ''}\n---\n${
          input.message
        }\n---`,
      );
      throw err;
    }
  }
}

/**
 * Where the feedback email lands. Configurable via env so a fork or
 * a per-org deploy can route to its own inbox. Defaults to ACME_EMAIL
 * (the Let's Encrypt registration email) because that's already a
 * "real inbox the operator reads" they had to fill in to obtain
 * TLS. Last-ditch fallback is the upstream maintainer's address so
 * the form never silently swallows in a misconfigured deploy.
 */
function resolveRecipient(): string {
  const explicit = process.env.FEEDBACK_RECIPIENT_EMAIL?.trim();
  if (explicit) return explicit;
  const acme = process.env.ACME_EMAIL?.trim();
  if (acme && acme !== 'you@example.com') return acme;
  return 'matthew.palavido@gmail.com';
}

function renderSubject(input: FeedbackInput): string {
  const who = input.email ?? input.name ?? 'anonymous';
  return `[GratisGIS feedback] ${truncate(input.message, 60)} (from ${who})`;
}

function renderBody(input: FeedbackInput): { text: string; html: string } {
  const lines = [
    `From: ${input.email ?? '(not provided)'}`,
    `Name: ${input.name ?? '(not provided)'}`,
    `Page: ${input.pageUrl ?? '(not provided)'}`,
    `User-Agent: ${input.userAgent ?? '(not provided)'}`,
    `IP: ${input.ip}`,
    '',
    '----',
    '',
    input.message,
  ];
  const text = lines.join('\n');
  const html =
    `<p><strong>From:</strong> ${escape(input.email ?? '(not provided)')}<br>` +
    `<strong>Name:</strong> ${escape(input.name ?? '(not provided)')}<br>` +
    `<strong>Page:</strong> ${escape(input.pageUrl ?? '(not provided)')}<br>` +
    `<strong>User-Agent:</strong> ${escape(input.userAgent ?? '(not provided)')}<br>` +
    `<strong>IP:</strong> ${escape(input.ip)}</p>` +
    `<hr>` +
    `<pre style="white-space: pre-wrap; font-family: -apple-system, system-ui, sans-serif;">${escape(
      input.message,
    )}</pre>`;
  return { text, html };
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
