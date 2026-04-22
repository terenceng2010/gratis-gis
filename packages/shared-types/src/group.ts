import type { GroupId, UserId, OrgId, ISODateString } from './ids';
import type { GroupAccess, GroupRole } from './sharing';

export interface Group {
  id: GroupId;
  orgId: OrgId;
  title: string;
  description: string;
  access: GroupAccess;
  ownerId: UserId;
  /**
   * Absolute URL to the group's thumbnail image, served from MinIO.
   * Null means we fall back to the auto-generated initial badge.
   */
  thumbnailUrl: string | null;
  createdAt: ISODateString;
  /**
   * Soft-delete timestamp. Non-null means the group is in the recycle
   * bin. See /docs/soft-delete.md.
   */
  deletedAt: ISODateString | null;
}

export interface GroupMember {
  groupId: GroupId;
  userId: UserId;
  role: GroupRole;
  joinedAt: ISODateString;
}
