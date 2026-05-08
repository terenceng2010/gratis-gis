-- Phase 2.6 of the observation-log engine pivot. After Phase 2.2
-- the v3 service stopped writing to per-layer fs_ tables, and
-- Phases 2.4 / 2.5 / 2.7 cut over the remaining read paths and the
-- DDL provisioning that kept creating empty new ones. The legacy
-- fs_<itemIdNoDashes>_<sanitizedLayerId> tables that are still in
-- the database are dead orphans for any read path; this migration
-- backfills their rows into the observation log and drops them.
--
-- Two fs_ name shapes exist:
--   - fs_<32hex>           : v2 single-table-per-item storage. Still
--                            in use by data_layer items with
--                            data.storageType='postgis' and version
--                            != 3. NOT TOUCHED here.
--   - fs_<32hex>_<suffix>  : v3 per-layer storage. Drop targets.
--
-- Backfill mapping (fs_ row -> observation row):
--   id          := gen_random_uuid()
--   tx_time     := edited_at      (best available; an existing
--                                  default of now() would falsify
--                                  ordering against natural writes)
--   valid_from  := valid_from
--   valid_to    := valid_to
--   scope       := 'data_layer:<itemId>:<layerId>'
--   entity      := global_id
--   kind        := 'update'        (the engine read path filters by
--                                  kind <> 'delete' and orders by
--                                  valid_from DESC, so 'update' is
--                                  semantically correct for both
--                                  current and historical fs_ rows)
--   attrs       := properties
--   geom        := geom            (omitted for table-shaped layers)
--   cell        := NULL            (optional engine optimisation;
--                                  re-derived lazily from geom by
--                                  the cell-stamping job)
--   author_sub  := edited_by::text
--   source      := {backfill, fs_table_name}
--   parents     := DEFAULT '{}'
--
-- The layerId portion of the table name went through sanitizeIdentifier
-- (lowercase, non-alnum-or-underscore -> '_', trim leading/trailing
-- underscores, truncate to 20 chars). To recover the original
-- layerId we scan the matching item.data.layers (including trashed
-- items, since they retain their fs_ tables until purge) and pick
-- the entry whose sanitized id matches the table-name suffix.
--
-- If a non-empty fs_ table can't be matched to an item.layer entry
-- (orphan from a long-purged item, schema lost, etc.) the migration
-- aborts loudly so the operator can decide what to do with the
-- residual data.

-- Local sanitizer matching apps/portal-api features-v3 sanitizeIdentifier.
CREATE OR REPLACE FUNCTION pg_temp.gg_sanitize_id(raw TEXT) RETURNS TEXT AS $$
BEGIN
  RETURN LEFT(
    regexp_replace(
      regexp_replace(lower(raw), '[^a-z0-9_]+', '_', 'g'),
      '^_+|_+$',
      '',
      'g'
    ),
    20
  );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

DO $migration$
DECLARE
  rec        RECORD;
  row_count  BIGINT;
  has_geom   BOOLEAN;
  hex_part   TEXT;
  suffix     TEXT;
  item_uuid  UUID;
  layer_id   TEXT;
  scope_str  TEXT;
  geom_expr  TEXT;
  inserted   BIGINT;
  total_drop INT := 0;
  total_rows BIGINT := 0;
BEGIN
  FOR rec IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename ~ '^fs_[0-9a-f]{32}_'
    ORDER BY tablename
  LOOP
    EXECUTE format('SELECT COUNT(*) FROM public.%I', rec.tablename)
      INTO row_count;

    -- Empty? Just drop it; nothing to backfill.
    IF row_count = 0 THEN
      EXECUTE format('DROP TABLE public.%I CASCADE', rec.tablename);
      total_drop := total_drop + 1;
      RAISE NOTICE 'Phase 2.6: dropped empty %', rec.tablename;
      CONTINUE;
    END IF;

    -- Recover (itemId, layerId) from the table name. The 32-hex
    -- segment is the item UUID with dashes stripped; the suffix is
    -- the sanitized layer id.
    hex_part := substr(rec.tablename, 4, 32);
    suffix   := substr(rec.tablename, 37);
    item_uuid := (
      substr(hex_part, 1, 8)  || '-' ||
      substr(hex_part, 9, 4)  || '-' ||
      substr(hex_part, 13, 4) || '-' ||
      substr(hex_part, 17, 4) || '-' ||
      substr(hex_part, 21, 12)
    )::uuid;

    -- Match the suffix against a current layer id on the item. We
    -- include trashed items (deletedAt IS NOT NULL) because purge
    -- is the only thing that drops the fs_ table, and pre-Phase-2.5
    -- it called dropAll inside purge; trashed items in flight at
    -- migration time still have their fs_ tables alive.
    -- Prisma maps Item.data -> column data_json; reference the
    -- physical column name here.
    SELECT (l->>'id')::text
    INTO layer_id
    FROM "item" i,
         jsonb_array_elements(i.data_json->'layers') l
    WHERE i.id = item_uuid
      AND pg_temp.gg_sanitize_id(l->>'id') = suffix
    LIMIT 1;

    IF layer_id IS NULL THEN
      RAISE EXCEPTION
        'Phase 2.6 abort: % has % rows but no matching item.data.layers entry (item % suffix %). Investigate manually before re-running.',
        rec.tablename, row_count, item_uuid, suffix;
    END IF;

    scope_str := 'data_layer:' || item_uuid::text || ':' || layer_id;

    -- Detect whether this table has a geom column. Layers with
    -- geometryType=null were provisioned without one.
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = rec.tablename
        AND column_name = 'geom'
    ) INTO has_geom;
    geom_expr := CASE WHEN has_geom THEN 'geom' ELSE 'NULL::geometry' END;

    -- Backfill into the observation log. Both current rows
    -- (valid_to IS NULL) and historical rows (valid_to set) move
    -- across so that point-in-time reads keep working through the
    -- cutover.
    EXECUTE format($q$
      INSERT INTO observation (
        id, tx_time, valid_from, valid_to, scope, entity, kind,
        attrs, geom, cell, author_sub, source, parents
      )
      SELECT
        gen_random_uuid(),
        edited_at,
        valid_from,
        valid_to,
        %L,
        global_id,
        'update',
        COALESCE(properties, '{}'::jsonb),
        %s,
        NULL,
        edited_by::text,
        jsonb_build_object('backfill', 'phase-2.6', 'from_table', %L),
        '{}'::uuid[]
      FROM public.%I
    $q$,
      scope_str,
      geom_expr,
      rec.tablename,
      rec.tablename
    );
    GET DIAGNOSTICS inserted = ROW_COUNT;
    total_rows := total_rows + inserted;

    EXECUTE format('DROP TABLE public.%I CASCADE', rec.tablename);
    total_drop := total_drop + 1;
    RAISE NOTICE 'Phase 2.6: backfilled % rows from % into scope %, dropped table',
      inserted, rec.tablename, scope_str;
  END LOOP;

  RAISE NOTICE 'Phase 2.6 complete: % tables dropped, % rows backfilled to observation log',
    total_drop, total_rows;
END $migration$;
