-- Rewrite persisted storage URLs for private-kind objects to point at
-- the new api-mediated download endpoint instead of the bare MinIO
-- URL.  This is the third step in the bucket-split sequence; it
-- lands BEFORE the bucket policy is tightened so working readers
-- never see a stale URL.
--
-- The api-mediated URL shape:
--
--   ${PUBLIC_URL}/api/portal/storage/private/<kind>/<key>
--
-- where <key> is the bare UUID (the `<kind>/` prefix is stripped
-- because the route segment already implies it).
--
-- Three places hold persisted URLs that need rewriting:
--
-- 1. feature_attachment.storage_url
-- 2. item.data ->> 'storageUrl'         (file items + tile-layer items)
-- 3. item.data ->> 'pmtilesUrl'         (tile-layer items, post-pyramid)
-- 4. item.data ->> 'cogUrl'             (tile-layer items, pre-pyramid)
--
-- Match shape: `https://<host>/<bucket>/<kind>/<uuid>`.  The
-- regex pulls out just the kind + uuid, so the new URL is
-- environment-agnostic (PUBLIC_URL is resolved at runtime, not
-- baked into the row).
--
-- Note: we intentionally do NOT rewrite item-thumb / group-thumb /
-- user-avatar / org-hero URLs.  Those keep their direct MinIO URLs
-- because the bucket policy will continue to allow anonymous GET
-- on those prefixes.

-- We can't bake the PUBLIC_URL hostname into a static SQL
-- migration because the hostname differs across local dev, staging,
-- and prod.  Use a relative path; the browser resolves it against
-- the portal origin.  feature_attachment.storage_url is consumed
-- only by the portal's own UI, so a relative URL is fine.

-- 1. feature_attachment.storage_url
UPDATE "feature_attachment"
SET "storage_url" = regexp_replace(
  "storage_url",
  '^https?://[^/]+/[^/]+/feature-attachment/([0-9a-f-]+)$',
  '/api/portal/storage/private/feature-attachment/\1'
)
WHERE "storage_url" ~ '^https?://[^/]+/[^/]+/feature-attachment/[0-9a-f-]+$';

-- 2. item.data ->> 'storageUrl' for file items
UPDATE "item"
SET "data_json" = jsonb_set(
  "data_json",
  '{storageUrl}',
  to_jsonb(
    regexp_replace(
      "data_json" ->> 'storageUrl',
      '^https?://[^/]+/[^/]+/(item-file|item-tile-layer)/([0-9a-f-]+)$',
      '/api/portal/storage/private/\1/\2'
    )
  )
)
WHERE "data_json" ? 'storageUrl'
  AND "data_json" ->> 'storageUrl' ~
      '^https?://[^/]+/[^/]+/(item-file|item-tile-layer)/[0-9a-f-]+$';

-- 3. item.data ->> 'pmtilesUrl' for tile-layer items (post-pyramid)
UPDATE "item"
SET "data_json" = jsonb_set(
  "data_json",
  '{pmtilesUrl}',
  to_jsonb(
    regexp_replace(
      "data_json" ->> 'pmtilesUrl',
      '^https?://[^/]+/[^/]+/item-tile-layer/([0-9a-f-]+)$',
      '/api/portal/storage/private/item-tile-layer/\1'
    )
  )
)
WHERE "data_json" ? 'pmtilesUrl'
  AND "data_json" ->> 'pmtilesUrl' ~
      '^https?://[^/]+/[^/]+/item-tile-layer/[0-9a-f-]+$';

-- 4. item.data ->> 'cogUrl' for tile-layer items (pre-pyramid)
UPDATE "item"
SET "data_json" = jsonb_set(
  "data_json",
  '{cogUrl}',
  to_jsonb(
    regexp_replace(
      "data_json" ->> 'cogUrl',
      '^https?://[^/]+/[^/]+/item-tile-layer/([0-9a-f-]+)$',
      '/api/portal/storage/private/item-tile-layer/\1'
    )
  )
)
WHERE "data_json" ? 'cogUrl'
  AND "data_json" ->> 'cogUrl' ~
      '^https?://[^/]+/[^/]+/item-tile-layer/[0-9a-f-]+$';
