import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { OrgRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type { KeycloakClaims } from './jwt.strategy.js';

export interface AuthUser {
  id: string;
  orgId: string;
  username: string;
  email: string;
  orgRole: OrgRole;
  /** Group IDs the user belongs to, resolved at request time. */
  groupIds: string[];
}

/**
 * On every request the JWT strategy calls `upsertFromClaims` to keep the
 * local `user` table in sync with Keycloak, then resolves the user's group
 * memberships so authorization checks are cheap downstream.
 */
@Injectable()
export class AuthSyncService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertFromClaims(claims: KeycloakClaims): Promise<AuthUser> {
    const orgSlug = claims.org;
    if (!orgSlug) {
      throw new UnauthorizedException('JWT is missing required "org" claim');
    }

    const org = await this.prisma.organization.upsert({
      where: { slug: orgSlug },
      update: {},
      create: { slug: orgSlug, name: orgSlug },
    });

    const user = await this.prisma.user.upsert({
      where: { id: claims.sub },
      update: {
        username: claims.preferred_username,
        email: claims.email,
        fullName: claims.name,
        orgRole: claims.org_role ?? 'viewer',
        orgId: org.id,
      },
      create: {
        id: claims.sub,
        orgId: org.id,
        username: claims.preferred_username,
        email: claims.email,
        fullName: claims.name,
        orgRole: claims.org_role ?? 'viewer',
      },
    });

    const memberships = await this.prisma.groupMember.findMany({
      where: { userId: user.id },
      select: { groupId: true },
    });

    return {
      id: user.id,
      orgId: user.orgId,
      username: user.username,
      email: user.email,
      orgRole: user.orgRole,
      groupIds: memberships.map((m) => m.groupId),
    };
  }
}
