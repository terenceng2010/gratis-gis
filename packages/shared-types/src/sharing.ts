/** Baseline access level applied to every Item. */
export type ItemAccess = 'private' | 'org' | 'public';

/** Permission an individual share row grants beyond the baseline. */
export type SharePermission = 'view' | 'edit' | 'admin';

/** Role a user holds within their Organization. */
export type OrgRole = 'viewer' | 'publisher' | 'admin';

/** Role a user holds within a specific Group. */
export type GroupRole = 'member' | 'admin';

/** Access level on a Group itself (who can find/see the group). */
export type GroupAccess = 'private' | 'org' | 'public';
