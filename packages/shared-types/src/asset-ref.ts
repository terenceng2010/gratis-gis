// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * AssetRef — a portable reference to an image / document / other
 * file asset that widget configs, theme settings, item branding
 * blocks, etc. can store instead of a bare URL string.
 *
 * Why this exists: the portal had a proliferation of `url?: string`
 * fields scattered across widget and item configs. Each one was a
 * free-floating string the runtime had to trust. When an author
 * uploaded an image as a File item and used the file's storage URL
 * elsewhere, the system had no way to know which apps depended on
 * that file -- deleting it left dangling references and re-uploading
 * the bytes meant every dependent app had to be edited by hand.
 *
 * AssetRef makes the relationship explicit. Two shapes:
 *
 *   - 'file-item': the asset is a portal File item, referenced by
 *     its UUID. The runtime resolves to the file's current
 *     storageUrl at render time, so swapping the file's bytes
 *     reflects in every dependent app without re-saving. Deleting
 *     the file item leaves the reference dangling; the runtime
 *     should fall back to a sensible placeholder.
 *
 *   - 'external-url': the asset is a fully-qualified URL the
 *     author pasted (a CDN image, an external icon, etc.). No
 *     resolution needed; render as-is.
 *
 * The optional `cachedUrl` on file-item is a denormalization that
 * lets server-render paths embed the resolved URL without a
 * fresh API hit. The runtime checks the cache against the file
 * item's current URL and refreshes if stale; it's purely a
 * latency optimization, not a security boundary.
 */
export type AssetRef =
  | {
      kind: 'file-item';
      /** UUID of a portal item with type='file'. */
      itemId: string;
      /**
       * Denormalized snapshot of the file's storage URL at the
       * time the reference was saved. Optional; the runtime
       * refetches if missing or stale (file replaced).
       */
      cachedUrl?: string;
      /** Denormalized filename for UI labels (alt text, etc.). */
      cachedFileName?: string;
    }
  | {
      kind: 'external-url';
      /** Fully-qualified http(s) URL. */
      url: string;
    };

/**
 * Resolve an AssetRef to a URL string. For external-url refs,
 * returns `ref.url` directly. For file-item refs, returns the
 * cached URL if present; otherwise null (the caller is expected
 * to fetch the file item's current storageUrl). Authors of new
 * code should prefer `resolveAssetRefAsync` (defined in
 * portal-web's asset utilities) which handles the fetch case.
 */
export function resolveAssetRefSync(ref: AssetRef | null | undefined): string | null {
  if (!ref) return null;
  if (ref.kind === 'external-url') return ref.url;
  // file-item: cached URL takes priority for SSR / immediate render.
  // The async resolver upgrades stale caches on the client.
  return ref.cachedUrl ?? null;
}

/**
 * Type guard. Useful in switch statements that branch on the kind.
 */
export function isFileItemAssetRef(
  ref: AssetRef | null | undefined,
): ref is { kind: 'file-item'; itemId: string; cachedUrl?: string; cachedFileName?: string } {
  return !!ref && ref.kind === 'file-item';
}

/**
 * Type guard for the external-url branch.
 */
export function isExternalUrlAssetRef(
  ref: AssetRef | null | undefined,
): ref is { kind: 'external-url'; url: string } {
  return !!ref && ref.kind === 'external-url';
}
