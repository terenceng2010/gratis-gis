import type { GroupId, UserId, OrgId, ISODateString } from './ids.js';
import type { GroupAccess, GroupRole } from './sharing.js';

export interface Group {
  id: GroupId;
  orgId: OrgId;
  title: string;
  description: string;
  access: GroupAccess;
  ownerId: UserId;
  createdAt: ISODateString;
}

export interface GroupMember {
  groupId: GroupId;
  userId: UserId;
  role: GroupRole;
  joinedAt: ISODateString;
}
