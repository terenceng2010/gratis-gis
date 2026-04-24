-- Rename OrgRole.publisher -> OrgRole.contributor.
-- "Publisher" is one of Esri's named roles in ArcGIS Online; since
-- GratisGIS is positioned as an open-source alternative, we steer
-- clear of their specific term in favour of the generic SaaS
-- vocabulary used by GitHub, Notion, Asana, etc.
--
-- Postgres doesn't support renaming an enum value directly, so we
-- swap the whole type: rename the old enum out of the way, create a
-- fresh one with the new values, then recast the column using a
-- CASE expression that maps 'publisher' -> 'contributor'. All runs
-- in one transaction so the table is never in an invalid state.

ALTER TABLE "user" ALTER COLUMN "org_role" DROP DEFAULT;
ALTER TYPE "OrgRole" RENAME TO "OrgRole_old";
CREATE TYPE "OrgRole" AS ENUM ('viewer', 'contributor', 'admin');

ALTER TABLE "user"
  ALTER COLUMN "org_role" TYPE "OrgRole"
  USING (
    CASE "org_role"::text
      WHEN 'publisher' THEN 'contributor'::"OrgRole"
      ELSE "org_role"::text::"OrgRole"
    END
  );

ALTER TABLE "user" ALTER COLUMN "org_role" SET DEFAULT 'viewer';
DROP TYPE "OrgRole_old";
