-- Registered OAuth apps per AGO portal (#43 follow-up).
--
-- AGO requires per-portal app registration for OAuth. Storing the
-- resulting client_id in a portal DB row (instead of an env var)
-- lets admins manage AGO connections from the portal UI and
-- supports multiple AGO orgs side by side.
--
-- The client_id is not a secret on AGO's implicit-grant flow:
-- it's embedded in the authorize URL anyway. AGO app secrets live
-- on the AGO side. Plain text is fine here.
--
-- org_host is unique because a single AGO host registers a single
-- "GratisGIS Importer" app; if the operator wants to swap the
-- client_id they edit the existing row rather than juggling
-- duplicates.

CREATE TABLE "ago_oauth_connection" (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_url       TEXT NOT NULL,
  org_host      TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  client_id     TEXT NOT NULL,
  created_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by_id UUID NOT NULL
);

-- Unique on org_host so the OAuth start path can look up a
-- connection by host without scanning every row, and so the UI
-- can refuse to create duplicate rows for the same portal.
CREATE UNIQUE INDEX "ago_oauth_connection_org_host_key"
  ON "ago_oauth_connection" (org_host);
