-- #101 print_template item type.  Stores a PrintTemplateData
-- (paper size + free-positioned elements + declared parameters)
-- consumed by the Print tool widget on Custom Web Apps.  Built-in
-- starters (Letter portrait/landscape, Letter landscape large
-- legend, Tabloid landscape, Field summary) seed per-org via
-- auth-sync alongside user-authored templates.

ALTER TYPE "ItemType" ADD VALUE 'print-template';
