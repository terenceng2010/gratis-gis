import {
  BadGatewayException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

/**
 * Thin wrapper around Keycloak's Admin REST API.
 *
 * Keycloak exposes admin endpoints under
 *   {KEYCLOAK_URL}/admin/realms/{realm}/...
 *
 * We authenticate with a confidential service-account client that has
 * the `manage-users` role from the realm-management built-in client.
 * The client credentials live in env vars:
 *
 *   KEYCLOAK_ADMIN_CLIENT_ID     (e.g. "portal-api-admin")
 *   KEYCLOAK_ADMIN_CLIENT_SECRET
 *
 * Tokens returned by Keycloak are cached in-process until ~60s before
 * their advertised expiry. This means `manage-users` doesn't become a
 * per-request roundtrip, and lets the controller stay dumb about auth.
 *
 * All outbound calls use the built-in global `fetch` (Node 18+).
 */
interface TokenCache {
  accessToken: string;
  /** Absolute epoch ms at which this token should be considered stale. */
  expiresAt: number;
}

export interface KeycloakUserRep {
  id: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  enabled: boolean;
  emailVerified?: boolean;
  createdTimestamp?: number;
  attributes?: Record<string, string[]>;
  /** Convenience: combined name for display. */
  fullName?: string;
}

export interface KeycloakUserCreateInput {
  username: string;
  email: string;
  firstName?: string;
  lastName?: string;
  /** When true, sends a Keycloak email with UPDATE_PASSWORD action. */
  sendSetupEmail?: boolean;
  /** Optional initial org role attribute; stored as user attribute
   *  `org_role` since Keycloak doesn't have a first-class role field
   *  mapping here without custom mappers. */
  orgRole?: 'viewer' | 'publisher' | 'admin';
  /** Optional org slug; stored on the user attribute `org`. */
  org?: string;
  enabled?: boolean;
}

export interface KeycloakUserUpdateInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  enabled?: boolean;
  orgRole?: 'viewer' | 'publisher' | 'admin';
}

@Injectable()
export class KeycloakAdminService {
  private readonly logger = new Logger(KeycloakAdminService.name);
  private tokenCache: TokenCache | null = null;

  /** Base URL of the Keycloak server (no trailing slash). */
  private get keycloakUrl(): string {
    return (process.env.KEYCLOAK_URL ?? 'http://localhost:8080').replace(
      /\/$/,
      '',
    );
  }

  /** Realm we operate against. */
  private get realm(): string {
    return process.env.KEYCLOAK_REALM ?? 'gratis-gis';
  }

  private get adminClientId(): string | undefined {
    return process.env.KEYCLOAK_ADMIN_CLIENT_ID;
  }
  private get adminClientSecret(): string | undefined {
    return process.env.KEYCLOAK_ADMIN_CLIENT_SECRET;
  }

  /**
   * Whether the admin integration is configured. Controllers can use
   * this to surface a clear 503 ("admin API not configured") rather
   * than a cryptic Keycloak error when an operator forgot the env vars.
   */
  isConfigured(): boolean {
    return Boolean(this.adminClientId && this.adminClientSecret);
  }

  /** Fetch and cache an admin access token via client_credentials grant. */
  private async getAccessToken(): Promise<string> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'Keycloak admin API is not configured (missing KEYCLOAK_ADMIN_CLIENT_ID / _SECRET)',
      );
    }

    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now) {
      return this.tokenCache.accessToken;
    }

    const tokenUrl = `${this.keycloakUrl}/realms/${this.realm}/protocol/openid-connect/token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.adminClientId!,
      client_secret: this.adminClientSecret!,
    });

    let res: Response;
    try {
      res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch (err) {
      this.logger.error(`Keycloak token endpoint unreachable: ${String(err)}`);
      throw new BadGatewayException(
        'Could not reach Keycloak to obtain an admin token',
      );
    }

    if (!res.ok) {
      const text = await res.text();
      this.logger.error(
        `Keycloak token fetch failed: ${res.status} ${res.statusText} :: ${text}`,
      );
      throw new BadGatewayException(
        `Keycloak token fetch failed (${res.status}). Check client id / secret and service-account role mappings.`,
      );
    }

    const json = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };
    // Refresh 60s before expiry to avoid race-at-the-edge failures.
    const expiresAt = Date.now() + (json.expires_in - 60) * 1000;
    this.tokenCache = { accessToken: json.access_token, expiresAt };
    return json.access_token;
  }

  /** Build an admin endpoint URL inside the target realm. */
  private adminUrl(path: string): string {
    return `${this.keycloakUrl}/admin/realms/${this.realm}${path}`;
  }

  /** GET /users or /users?search=... */
  async listUsers(opts: {
    search?: string;
    first?: number;
    max?: number;
  } = {}): Promise<KeycloakUserRep[]> {
    const token = await this.getAccessToken();
    const qs = new URLSearchParams();
    if (opts.search) qs.set('search', opts.search);
    qs.set('first', String(opts.first ?? 0));
    qs.set('max', String(opts.max ?? 100));
    qs.set('briefRepresentation', 'false');
    const res = await fetch(this.adminUrl(`/users?${qs.toString()}`), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new BadGatewayException(
        `Keycloak listUsers failed: ${res.status} ${res.statusText}`,
      );
    }
    const rows = (await res.json()) as KeycloakUserRep[];
    // Attach a display-friendly fullName so UI code doesn't have to
    // concat first+last everywhere.
    return rows.map((r) => ({
      ...r,
      fullName: combineName(r.firstName, r.lastName, r.username),
    }));
  }

  async getUser(id: string): Promise<KeycloakUserRep> {
    const token = await this.getAccessToken();
    const res = await fetch(this.adminUrl(`/users/${id}`), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 404) {
      throw new NotFoundException(`Keycloak user ${id} not found`);
    }
    if (!res.ok) {
      throw new BadGatewayException(
        `Keycloak getUser failed: ${res.status} ${res.statusText}`,
      );
    }
    const row = (await res.json()) as KeycloakUserRep;
    return {
      ...row,
      fullName: combineName(row.firstName, row.lastName, row.username),
    };
  }

  /**
   * POST /users then GET /users?username=... to fetch the newly-created
   * id. Optionally triggers Keycloak's setup email (UPDATE_PASSWORD +
   * VERIFY_EMAIL actions) so the invitee can establish their password
   * out-of-band.
   */
  async createUser(
    input: KeycloakUserCreateInput,
  ): Promise<KeycloakUserRep> {
    const token = await this.getAccessToken();
    const attributes: Record<string, string[]> = {};
    if (input.orgRole) attributes.org_role = [input.orgRole];
    if (input.org) attributes.org = [input.org];
    const body = {
      username: input.username,
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      enabled: input.enabled ?? true,
      attributes,
    };
    const res = await fetch(this.adminUrl('/users'), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      if (res.status === 409) {
        throw new BadGatewayException(
          `A user with that username or email already exists (${text}).`,
        );
      }
      throw new BadGatewayException(
        `Keycloak createUser failed: ${res.status} ${res.statusText}`,
      );
    }
    // Keycloak returns 201 with a Location header pointing at the new user.
    const location = res.headers.get('location');
    if (!location) {
      throw new InternalServerErrorException(
        'Keycloak did not return a Location header for the created user.',
      );
    }
    const id = location.split('/').pop();
    if (!id) {
      throw new InternalServerErrorException(
        'Could not parse new user id from Location header.',
      );
    }

    if (input.sendSetupEmail) {
      await this.sendExecuteActionsEmail(id, [
        'UPDATE_PASSWORD',
        'VERIFY_EMAIL',
      ]);
    }
    return this.getUser(id);
  }

  async updateUser(
    id: string,
    patch: KeycloakUserUpdateInput,
  ): Promise<KeycloakUserRep> {
    const token = await this.getAccessToken();
    // PUT /users/{id} is a full replacement for the writeable fields.
    // We read-modify-write so partial updates don't clobber attributes.
    const current = await this.getUser(id);
    const attributes = { ...(current.attributes ?? {}) };
    if (patch.orgRole !== undefined) attributes.org_role = [patch.orgRole];

    const body: Record<string, unknown> = {
      firstName: patch.firstName ?? current.firstName,
      lastName: patch.lastName ?? current.lastName,
      email: patch.email ?? current.email,
      enabled: patch.enabled ?? current.enabled,
      attributes,
    };
    const res = await fetch(this.adminUrl(`/users/${id}`), {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.status === 404) {
      throw new NotFoundException(`Keycloak user ${id} not found`);
    }
    if (!res.ok) {
      throw new BadGatewayException(
        `Keycloak updateUser failed: ${res.status} ${res.statusText}`,
      );
    }
    return this.getUser(id);
  }

  async deleteUser(id: string): Promise<void> {
    const token = await this.getAccessToken();
    const res = await fetch(this.adminUrl(`/users/${id}`), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 404) {
      throw new NotFoundException(`Keycloak user ${id} not found`);
    }
    if (!res.ok) {
      throw new BadGatewayException(
        `Keycloak deleteUser failed: ${res.status} ${res.statusText}`,
      );
    }
  }

  /** PUT /users/{id}/execute-actions-email with the list of actions. */
  async sendExecuteActionsEmail(
    id: string,
    actions: Array<'UPDATE_PASSWORD' | 'VERIFY_EMAIL' | 'UPDATE_PROFILE'>,
  ): Promise<void> {
    const token = await this.getAccessToken();
    const res = await fetch(
      this.adminUrl(`/users/${id}/execute-actions-email`),
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(actions),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new BadGatewayException(
        `Keycloak execute-actions-email failed: ${res.status} ${res.statusText} :: ${text}`,
      );
    }
  }
}

function combineName(
  firstName: string | undefined,
  lastName: string | undefined,
  username: string,
): string {
  const parts = [firstName, lastName].filter(
    (s): s is string => typeof s === 'string' && s.trim().length > 0,
  );
  if (parts.length > 0) return parts.join(' ');
  return username;
}
