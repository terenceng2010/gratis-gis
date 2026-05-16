---
id: sharing-an-item
title: Sharing an item
summary: Every item carries its own ACL.  This page shows you the three sharing tiers and how to change them.
category: getting-started
order: 30
complexity: basic
controls:
  - id: sharing-panel
    label: "Sharing section on the item detail page"
tags:
  - sharing
  - permissions
related:
  - what-is-gratisgis
---

Every item in GratisGIS has a sharing tier.  The tier decides who
can find and open the item.

## The three tiers

- **Owner only** (default) — only you can see the item.
- **Organization** — anyone signed in to your organization can see
  the item.  They can read it; they can't edit unless they're the
  owner or an admin.
- **Public** — anyone with the link can see the item, even without
  signing in.  Used for shareable web apps and embeddable maps.

## How to change a tier

1. Open the item's detail page.
2. Scroll to the **Sharing** section.
3. Pick a tier.  The change saves immediately.

## What sharing does NOT do

- **It doesn't grant edit access.**  Sharing controls read access
  only.  Edit access stays with the item's owner (and the org's
  admins).  To let someone else edit, hand off ownership using
  **Reassign owner** (admin only).
- **It doesn't override file-system permissions.**  If a layer is
  shared publicly, its underlying PostGIS rows are readable through
  the API.  Don't share a layer publicly if any of its attributes
  are sensitive.

## Dependencies

If you share a map but not the data layer the map references, users
who can open the map still won't see the layer.  The **Dependency**
panel above Sharing surfaces this: a yellow warning appears when
the item depends on something less-shared than itself.

For forms, sharing is double-keyed: the **form item** controls who
can submit, the **paired data layer** controls who can view
submissions.  See **Forms → Sharing a form** for the details.
