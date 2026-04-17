import type { UserId, OrgId, ISODateString } from './ids';
import type { OrgRole } from './sharing';

export interface User {
  id: UserId;
  orgId: OrgId;
  username: string;
  email: string;
  fullName: string;
  orgRole: OrgRole;
  createdAt: ISODateString;
}
