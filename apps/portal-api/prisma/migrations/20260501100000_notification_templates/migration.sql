-- #229 Phase A: add three new notification types and the
-- per-org template override table.

-- New NotificationType enum values. Postgres ALTER TYPE ADD VALUE
-- can't be wrapped in a transaction so each runs as its own
-- statement. Existing values (share-created, share-expiring,
-- share-expired, user-auto-disable-warning, user-disabled,
-- editor-feature-created) keep their position; the new entries
-- appear at the end.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'user-invited';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'data-collection-feature-created';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'form-submission-received';

-- Per-(org, type, channel) customised template. Sparse: when a row
-- doesn't exist the renderer falls back to the hard-coded default
-- in notifications/templates.ts. Mustache-lite substitution against
-- the per-type payload schema; HTML-escape on substituted values
-- when rendering body_html.
CREATE TABLE "notification_template" (
  "org_id"     UUID NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "type"       "NotificationType" NOT NULL,
  "channel"    "NotificationChannel" NOT NULL,
  "subject"    TEXT NOT NULL,
  "body_text"  TEXT NOT NULL,
  "body_html"  TEXT NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("org_id", "type", "channel")
);
