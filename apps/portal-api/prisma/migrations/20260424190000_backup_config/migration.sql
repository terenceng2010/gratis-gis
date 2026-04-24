-- Singleton table holding admin-editable backup settings. Each
-- nullable column falls back to the equivalent env var so fresh
-- deployments behave as before until an admin saves the form.
CREATE TABLE "backup_config" (
  "id"                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "archive_directory"     TEXT,
  "schedule_mode"         TEXT         NOT NULL DEFAULT 'daily',
  "schedule_hour"         INT          NOT NULL DEFAULT 2,
  "schedule_minute"       INT          NOT NULL DEFAULT 0,
  "schedule_day_of_week"  INT,
  "schedule_day_of_month" INT,
  "custom_cron"           TEXT,
  "retention_count"       INT,
  "updated_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_by"            UUID
);
