import { Body, Controller, Get, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

class UpdateMeDto {
  // Null clears a previously-set avatar back to the initial badge.
  @IsOptional() @IsString() @MaxLength(2048)
  avatarUrl?: string | null;
}

/**
 * The /users/me endpoint is the single source of truth the web layer
 * reads for "who am I". Lower-traffic fields (avatar, org display name)
 * live here rather than in every JWT decode so the auth-sync layer stays
 * narrow. PATCH lets a user swap their avatar; Keycloak remains the
 * authority for anything identity-critical like username or email.
 */
@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    const [row, org] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: user.id },
        select: { avatarUrl: true, fullName: true },
      }),
      this.prisma.organization.findUnique({
        where: { id: user.orgId },
        select: { name: true, slug: true },
      }),
    ]);
    return {
      ...user,
      fullName: row?.fullName ?? user.username,
      avatarUrl: row?.avatarUrl ?? null,
      orgName: org?.name ?? null,
      orgSlug: org?.slug ?? null,
    };
  }

  /**
   * Org-scoped directory used by the sharing picker. Returns a lean
   * shape (no email, no createdAt) because this endpoint is called
   * from the client on every keystroke and we don't want to leak
   * contact details through a search surface.
   *
   * Search is case-insensitive across username and fullName. Limits to
   * 50 results so a cold query on a big org doesn't blow a payload.
   */
  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query('q') q?: string,
  ) {
    const trimmed = (q ?? '').trim();
    const where: {
      orgId: string;
      OR?: Array<Record<string, unknown>>;
    } = { orgId: user.orgId };
    if (trimmed.length > 0) {
      where.OR = [
        { username: { contains: trimmed, mode: 'insensitive' } },
        { fullName: { contains: trimmed, mode: 'insensitive' } },
      ];
    }
    return this.prisma.user.findMany({
      where,
      select: {
        id: true,
        username: true,
        fullName: true,
        avatarUrl: true,
      },
      orderBy: { fullName: 'asc' },
      take: 50,
    });
  }

  @Patch('me')
  async updateMe(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateMeDto,
  ) {
    return this.prisma.user.update({
      where: { id: user.id },
      data: {
        ...(dto.avatarUrl !== undefined && { avatarUrl: dto.avatarUrl }),
      },
      select: {
        id: true,
        username: true,
        fullName: true,
        email: true,
        avatarUrl: true,
      },
    });
  }
}
