import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';

import { AuthSyncService, type AuthUser } from './auth-sync.service.js';

/**
 * Validates Keycloak-issued JWTs against the realm's JWKS endpoint.
 * On success, upserts the local User row and returns the AuthUser object
 * that gets attached to `request.user` for the duration of the request.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(private readonly authSync: AuthSyncService) {
    const keycloakUrl = process.env.KEYCLOAK_URL ?? 'http://localhost:8080';
    const realm = process.env.KEYCLOAK_REALM ?? 'gratis-gis';

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      algorithms: ['RS256'],
      issuer: `${keycloakUrl}/realms/${realm}`,
      audience: undefined, // Keycloak doesn't set audience by default
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 10,
        jwksUri: `${keycloakUrl}/realms/${realm}/protocol/openid-connect/certs`,
      }),
    });
  }

  async validate(payload: KeycloakClaims): Promise<AuthUser> {
    return this.authSync.upsertFromClaims(payload);
  }
}

/** The claim shape we expect from Keycloak. Extras are tolerated but ignored. */
export interface KeycloakClaims {
  sub: string;
  preferred_username: string;
  email: string;
  name: string;
  org?: string;
  org_role?: 'viewer' | 'publisher' | 'admin';
}
