import type { ItemId, UserId, OrgId, ISODateString } from './ids';
import type { ItemAccess, SharePermission } from './sharing';
import type { ItemType } from './item-types';

export type PrincipalType = 'user' | 'group';

export interface Item<TData = unknown> {
  id: ItemId;
  orgId: OrgId;
  ownerId: UserId;
  type: ItemType;
  title: string;
  description: string;
  tags: string[];
  thumbnailUrl: string | null;
  data: TData;
  storageRef: string | null;
  access: ItemAccess;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  /**
   * Soft-delete timestamp. Non-null means the item is in the recycle
   * bin and will be permanently removed after the retention window.
   * See /docs/soft-delete.md.
   */
  deletedAt: ISODateString | null;
}

export interface ItemShare {
  itemId: ItemId;
  principalType: PrincipalType;
  /** Either a UserId or a GroupId depending on principalType. */
  principalId: string;
  permission: SharePermission;
  createdAt: ISODateString;
}

/**
 * Item joined with its share rows. Returned by list + get endpoints so
 * UIs can render sharing indicators (and the full sharing panel on
 * detail pages) without a second round-trip per item.
 */
export type ItemWithShares<TData = unknown> = Item<TData> & {
  shares: ItemShare[];
};

/** Input shape for creating a new Item via the API. */
export interface CreateItemInput<TData = unknown> {
  type: ItemType;
  title: string;
  description?: string;
  tags?: string[];
  data: TData;
  access?: ItemAccess;
}
