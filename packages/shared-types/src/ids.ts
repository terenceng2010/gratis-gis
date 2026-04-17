/** Branded ID types. Prevents accidentally passing a UserId where an ItemId is expected. */

type Brand<T, B extends string> = T & { readonly __brand: B };

export type UserId = Brand<string, 'UserId'>;
export type OrgId = Brand<string, 'OrgId'>;
export type GroupId = Brand<string, 'GroupId'>;
export type ItemId = Brand<string, 'ItemId'>;

export const UserId = (s: string): UserId => s as UserId;
export const OrgId = (s: string): OrgId => s as OrgId;
export const GroupId = (s: string): GroupId => s as GroupId;
export const ItemId = (s: string): ItemId => s as ItemId;

export type ISODateString = Brand<string, 'ISODateString'>;
