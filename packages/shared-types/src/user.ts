import type { UserId, OrgId, ISODateString } from './ids.js';
import type { OrgRole } from './sharing.js';

export interface User {
  id: UserId;
  orgId: OrgId;
  username: string;
  email: string;
  fullName: string;
  orgRole: OrgRole;
  createdAt: ISODateString;
}
