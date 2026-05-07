// SPDX-License-Identifier: AGPL-3.0-or-later
import type { UserId, OrgId, ISODateString } from './ids';
import type { OrgRole } from './sharing';

export interface User {
  id: UserId;
  orgId: OrgId;
  username: string;
  email: string;
  fullName: string;
  orgRole: OrgRole;
  /**
   * Absolute URL to the user's avatar image, served from MinIO.
   * Null falls back to the auto-generated initial badge.
   */
  avatarUrl: string | null;
  createdAt: ISODateString;
}
