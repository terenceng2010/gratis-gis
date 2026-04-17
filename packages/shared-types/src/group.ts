import type { GroupId, UserId, OrgId, ISODateString } from './ids';
import type { GroupAccess, GroupRole } from './sharing';

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
