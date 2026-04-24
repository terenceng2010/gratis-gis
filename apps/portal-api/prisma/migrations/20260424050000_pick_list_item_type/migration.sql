-- Add the `pick-list` variant to ItemType. Pick lists are a
-- first-class shared item type: a named, authoritative list of coded
-- values referenced by feature-service field domains, form choices,
-- dashboard filters, etc. Postgres enums can't be altered inside a
-- transaction block, so Prisma's migration runner executes this
-- statement standalone. Existing rows are untouched; the new value
-- is available for future inserts.
ALTER TYPE "ItemType" ADD VALUE 'pick-list';
