-- Follow-up to 20260518230000_rewrite_storage_urls_to_api.
--
-- That migration only rewrote the well-known top-level keys
-- (data.storageUrl, data.pmtilesUrl, data.cogUrl, plus
-- feature_attachment.storage_url).  It missed the asset-picker's
-- denormalized `cachedUrl` field, which lives nested inside web-app
-- / editor / viewer / custom configs as part of a `file-item` asset
-- ref (see apps/portal-web/src/components/asset-picker.tsx).  Those
-- cachedUrl values were snapshotted from the source file item's
-- storageUrl at pick time; the source got rewritten yesterday but
-- the cached copies were left pointing at the bare MinIO URL,
-- which now 403s because the bucket policy private-by-default split
-- excludes the `item-file` prefix.
--
-- This migration does a text-level substitution on data_json so it
-- catches `cachedUrl` and any other nested field that holds the
-- same URL pattern.  The match is anchored by quotes on both sides
-- so it only fires on full JSON string values, not on substrings of
-- something larger.  Three private prefixes participate (same set
-- the previous migration covered): item-file, item-tile-layer,
-- feature-attachment.  item-thumb / group-thumb / user-avatar /
-- org-hero stay on direct MinIO URLs and are explicitly excluded.

UPDATE "item"
SET "data_json" = (
  regexp_replace(
    "data_json"::text,
    '"https?://[^/"]+/[^/"]+/(item-file|item-tile-layer|feature-attachment)/([0-9a-f-]+)"',
    '"/api/portal/storage/private/\1/\2"',
    'g'
  )
)::jsonb
WHERE "data_json"::text ~
      '"https?://[^/"]+/[^/"]+/(item-file|item-tile-layer|feature-attachment)/[0-9a-f-]+"';
