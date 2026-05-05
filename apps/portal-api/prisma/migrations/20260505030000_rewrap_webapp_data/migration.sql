-- #258 / #259: rewrap unwrapped EditorData / ViewerData stored on
-- web_app items back into the canonical WebAppData shape. The
-- detail-page PATCH was sending raw EditorData / ViewerData and
-- the API replaces data_json wholesale, which stripped the
-- `template` + `config` wrapper that isEditorItem / isViewerItem
-- rely on for routing. Symptom: viewer/run returned 404, editor
-- detail fell through to ComingSoon.
--
-- Idempotent: gated on `NOT (data_json ? 'template')` so re-runs
-- and rows already in the canonical shape are skipped.
--
-- Discriminator between editor and viewer in the unwrapped state:
-- editor data has `snapping` (drawing-snap settings), viewer data
-- does not. Both have `targets` + `tools` so the distinguishing
-- field has to come from a property only one of them carries.
--
-- The 'editor' enum value also still appears in legacy rows; this
-- migration does NOT touch those (they fall through to the
-- legacy-type branch in isEditorItem / readEditorData unchanged).

-- Step 1: editor-shaped rows.
UPDATE "item"
SET data_json = jsonb_build_object(
  'version', 1,
  'template', 'editor',
  'config', jsonb_build_object(
    'template', 'editor',
    'editor', data_json
  )
)
WHERE type = 'web-app'
  AND data_json IS NOT NULL
  AND NOT (data_json ? 'template')
  AND data_json ? 'targets'
  AND data_json ? 'snapping';

-- Step 2: viewer-shaped rows.
UPDATE "item"
SET data_json = jsonb_build_object(
  'version', 1,
  'template', 'viewer',
  'config', jsonb_build_object(
    'template', 'viewer',
    'viewer', data_json
  )
)
WHERE type = 'web-app'
  AND data_json IS NOT NULL
  AND NOT (data_json ? 'template')
  AND data_json ? 'targets'
  AND data_json ? 'tools'
  AND NOT (data_json ? 'snapping');
