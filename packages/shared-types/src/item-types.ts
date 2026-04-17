/**
 * The enumerated set of content types an Item can represent.
 * Add a new value here when introducing a new kind of platform content.
 */
export const ITEM_TYPES = [
  'web-map',
  'feature-service',
  'form',
  'form-submission-collection',
  'web-app',
  'report-template',
  'dashboard',
  'file',
  'layer-package',
  'notebook',
  'tool',
  'widget-package',
] as const;

export type ItemType = (typeof ITEM_TYPES)[number];

export function isItemType(value: unknown): value is ItemType {
  return typeof value === 'string' && (ITEM_TYPES as readonly string[]).includes(value);
}
