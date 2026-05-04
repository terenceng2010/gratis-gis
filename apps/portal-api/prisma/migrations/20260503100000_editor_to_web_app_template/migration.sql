-- #258: fold the `editor` item type into `web_app` with a
-- `template = 'editor'` discriminator. Historical context in
-- docs/item-type-guidance.md.
--
-- Migration shape:
--   - Take every Item where type='editor' and rewrite type to
--     'web_app' AND wrap data into the new WebAppData shape:
--     { version: 1, template: 'editor', config: { template: 'editor', editor: <old data> } }
--   - The old EditorData lives under config.editor so the new
--     readEditorData() helper in shared-types/web-app.ts can find
--     it. (The fallback branch tolerates a flat config.editor for
--     defense-in-depth, but this migration writes the canonical
--     nested shape.)
--   - Idempotent: only rewrites rows still on type='editor', so
--     re-running is a no-op.
--   - The 'editor' enum value stays on ItemType for the
--     deprecation window. Drop it in a follow-up migration once
--     all consumers are off the literal.

-- The Item model maps to lowercase `item` via @@map and the data
-- field maps to `data_json`. The ItemType enum's `web_app` value
-- is stored under the hyphenated raw name `web-app` (Prisma's
-- @map on the enum value). All three names need to be the DB
-- identifiers, not the Prisma model/property/enum-member names.
-- The `editor` enum value has no @map, so it stays as 'editor'.
UPDATE "item"
SET
  type = 'web-app',
  data_json = jsonb_build_object(
    'version', 1,
    'template', 'editor',
    'config', jsonb_build_object(
      'template', 'editor',
      'editor', COALESCE(data_json, '{}'::jsonb)
    )
  )
WHERE type = 'editor';
