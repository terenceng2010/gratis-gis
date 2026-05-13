-- #22 app_template item type. Stores a reusable CustomAppData
-- blueprint that the new-item wizard can clone into a fresh web_app.
-- Built-in starters (sidebar-explorer / showcase-map / compact-drawer
-- / blank-canvas) are seeded per-org as items of this kind via the
-- org-bootstrap path, alongside any user-saved templates.

ALTER TYPE "ItemType" ADD VALUE 'app-template';
