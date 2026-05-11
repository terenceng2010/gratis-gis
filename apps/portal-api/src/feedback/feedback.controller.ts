// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { Public } from '../auth/public.decorator.js';
import { FeedbackService } from './feedback.service.js';

/**
 * Anonymous feedback DTO (#146). Honeypot field `company` is included
 * BUT it is supposed to stay empty: a real user never sees it (the
 * frontend hides it via off-screen positioning + tabindex=-1). Bots
 * scraping form fields almost always fill every input; a non-empty
 * `company` signals "this submission is automated, drop it." The
 * controller silently 200s on honeypot hits so the bot does not get
 * a signal that we caught it.
 */
class SubmitFeedbackDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsString() @MinLength(2) @MaxLength(10000) message!: string;
  @IsOptional() @IsString() @MaxLength(2000) pageUrl?: string;
  /** Honeypot. Hidden in the UI; bots fill it. */
  @IsOptional() @IsString() @MaxLength(500) company?: string;
}

/**
 * Token-bucket-ish rate limiter, per IP, in process. Two budgets:
 *
 *   - SHORT: 3 submissions per 5 minutes  (catches rapid retries)
 *   - LONG:  20 submissions per hour      (catches sustained spam)
 *
 * In-process is fine for a single-host deploy. When the api goes
 * multi-replica, this needs to move to Redis or a DB table; the
 * shape is the same, just the storage swaps.
 */
class FeedbackRateLimiter {
  private readonly bucket = new Map<string, number[]>();
  private readonly SHORT_WINDOW_MS = 5 * 60 * 1000;
  private readonly SHORT_LIMIT = 3;
  private readonly LONG_WINDOW_MS = 60 * 60 * 1000;
  private readonly LONG_LIMIT = 20;

  /** Returns true when this IP is over either budget. */
  shouldDeny(ip: string, now: number = Date.now()): boolean {
    const stamps = this.bucket.get(ip) ?? [];
    // Drop stamps older than the longer window; they're irrelevant.
    const pruned = stamps.filter((t) => now - t < this.LONG_WINDOW_MS);
    if (pruned.length !== stamps.length) {
      this.bucket.set(ip, pruned);
    }
    const inShort = pruned.filter((t) => now - t < this.SHORT_WINDOW_MS).length;
    if (inShort >= this.SHORT_LIMIT) return true;
    if (pruned.length >= this.LONG_LIMIT) return true;
    return false;
  }

  /** Stamp a successful submission so future calls see it. */
  record(ip: string, now: number = Date.now()): void {
    const stamps = this.bucket.get(ip) ?? [];
    stamps.push(now);
    this.bucket.set(ip, stamps);
  }
}

@ApiTags('public')
@Controller('feedback')
export class FeedbackController {
  private readonly log = new Logger(FeedbackController.name);
  private readonly limiter = new FeedbackRateLimiter();

  constructor(private readonly feedback: FeedbackService) {}

  /**
   * Public feedback intake. Required body: { message: string }. The
   * rest are optional. Returns `{ ok: true }` on success regardless
   * of whether SMTP was reachable (the service has a log-only
   * fallback so the user never sees "we lost your message because
   * we don't have SMTP set up yet"). Throws 429 when rate-limited
   * and 400 when the message is empty / too long. Honeypot hits
   * silently 200; that's intentional so the bot doesn't learn.
   */
  @Public()
  @Post()
  @HttpCode(200)
  async submit(
    @Body() dto: SubmitFeedbackDto,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    // Honeypot first. Silently swallow.
    if (dto.company && dto.company.trim().length > 0) {
      this.log.warn(
        `feedback honeypot tripped ip=${clientIp(req)} ua="${truncate(
          req.headers['user-agent'] ?? '',
          80,
        )}"`,
      );
      return { ok: true };
    }

    const ip = clientIp(req);
    if (this.limiter.shouldDeny(ip)) {
      this.log.warn(`feedback rate-limited ip=${ip}`);
      throw new HttpException(
        'Too many submissions from your network. Try again in a few minutes.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const message = dto.message.trim();
    if (message.length < 2) {
      throw new BadRequestException('Message is required.');
    }

    await this.feedback.submit({
      ...(dto.name ? { name: dto.name.trim() } : {}),
      ...(dto.email ? { email: dto.email.trim() } : {}),
      message,
      ...(dto.pageUrl ? { pageUrl: dto.pageUrl.trim() } : {}),
      ...(req.headers['user-agent']
        ? { userAgent: String(req.headers['user-agent']) }
        : {}),
      ip,
    });

    // Record stamp AFTER successful send so a transient SMTP error
    // does NOT count toward the rate-limit budget. A persistent
    // failure would still let the user retry without being banned.
    this.limiter.record(ip);

    return { ok: true };
  }
}

/**
 * Best-effort client IP. Prefers X-Forwarded-For (set by Caddy in
 * front of the api) over the raw socket, since the socket address
 * is always Caddy's. Strips trailing ports and IPv6 brackets.
 */
function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  const raw = Array.isArray(fwd) ? fwd[0] : fwd;
  if (typeof raw === 'string' && raw.length > 0) {
    // X-Forwarded-For is a comma-separated list; the leftmost entry
    // is the original client.
    const first = raw.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
