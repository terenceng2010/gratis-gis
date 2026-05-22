// SPDX-License-Identifier: AGPL-3.0-or-later
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { normalizeAgoUrl } from './ago-url.js';

/**
 * One AGO connection row as returned to the admin UI. Mirrors the
 * Prisma model but drops the FK-only fields the client doesn't
 * need.
 */
export interface AgoConnectionDto {
  id: string;
  orgUrl: string;
  orgHost: string;
  displayName: string;
  clientId: string;
  createdAt: string;
  createdById: string;
}

/**
 * CRUD over the `ago_oauth_connection` table.
 *
 * One connection per AGO portal (org_host unique). Admins create
 * one for each AGO portal they want to import from; the importer
 * picks among them via a dropdown.
 *
 * Authz: every method here assumes the calling user is already an
 * org admin (the controller guards with AdminGuard). createdById
 * is informational only -- any admin can edit any connection so
 * a colleague-admin can pick up a stranded connection without
 * needing the original creator's account.
 */
@Injectable()
export class AgoConnectionsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<AgoConnectionDto[]> {
    const rows = await this.prisma.agoOauthConnection.findMany({
      orderBy: { displayName: 'asc' },
    });
    return rows.map(toDto);
  }

  async getById(id: string): Promise<AgoConnectionDto> {
    const row = await this.prisma.agoOauthConnection.findUnique({
      where: { id },
    });
    if (!row) throw new NotFoundException(`AGO connection ${id} not found.`);
    return toDto(row);
  }

  /**
   * Look up a connection by its org host. The OAuth-start endpoint
   * uses this when the client passes the connection id; the
   * importer's connection-picker passes the id so this path is
   * the load-bearing read.
   */
  async getByHost(host: string): Promise<AgoConnectionDto | null> {
    const row = await this.prisma.agoOauthConnection.findUnique({
      where: { orgHost: host },
    });
    return row ? toDto(row) : null;
  }

  async create(
    user: AuthUser,
    input: { orgUrl: string; displayName?: string; clientId: string },
  ): Promise<AgoConnectionDto> {
    const normalized = normalizeAgoUrl(input.orgUrl);
    if (!normalized) {
      throw new BadRequestException(
        `Could not parse "${input.orgUrl}" as an AGO portal URL.`,
      );
    }
    const clientId = input.clientId.trim();
    if (!clientId) {
      throw new BadRequestException('clientId is required.');
    }
    const orgHost = hostnameFromOrigin(normalized.origin);
    const displayName = (input.displayName ?? '').trim() || orgHost;
    try {
      const row = await this.prisma.agoOauthConnection.create({
        data: {
          orgUrl: normalized.origin + normalized.portalPath,
          orgHost,
          displayName,
          clientId,
          createdById: user.id,
        },
      });
      return toDto(row);
    } catch (err) {
      // P2002 = unique constraint violation on org_host. Surface
      // as a 400 with a clear hint so the UI can offer to edit
      // the existing row instead.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new BadRequestException(
          `A connection for ${orgHost} already exists. Edit it instead of creating a duplicate.`,
        );
      }
      throw err;
    }
  }

  async update(
    id: string,
    patch: { displayName?: string; clientId?: string },
  ): Promise<AgoConnectionDto> {
    const existing = await this.prisma.agoOauthConnection.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException(`AGO connection ${id} not found.`);
    }
    const data: Prisma.AgoOauthConnectionUpdateInput = {};
    if (patch.displayName !== undefined) {
      const trimmed = patch.displayName.trim();
      if (!trimmed) {
        throw new BadRequestException('displayName cannot be blank.');
      }
      data.displayName = trimmed;
    }
    if (patch.clientId !== undefined) {
      const trimmed = patch.clientId.trim();
      if (!trimmed) {
        throw new BadRequestException('clientId cannot be blank.');
      }
      data.clientId = trimmed;
    }
    if (Object.keys(data).length === 0) {
      return toDto(existing);
    }
    const row = await this.prisma.agoOauthConnection.update({
      where: { id },
      data,
    });
    return toDto(row);
  }

  async delete(id: string): Promise<void> {
    try {
      await this.prisma.agoOauthConnection.delete({ where: { id } });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new NotFoundException(`AGO connection ${id} not found.`);
      }
      throw err;
    }
  }
}

function toDto(row: Prisma.AgoOauthConnectionGetPayload<object>): AgoConnectionDto {
  return {
    id: row.id,
    orgUrl: row.orgUrl,
    orgHost: row.orgHost,
    displayName: row.displayName,
    clientId: row.clientId,
    createdAt: row.createdAt.toISOString(),
    createdById: row.createdById,
  };
}

function hostnameFromOrigin(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}
