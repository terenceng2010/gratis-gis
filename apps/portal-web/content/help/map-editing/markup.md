---
id: map-editing-markup
title: Markup and redlining
summary: Drop colored pins on a shared map to flag issues or call out specific places for the team to discuss.
category: map-editing
order: 40
complexity: basic
tags:
  - markup
  - collaboration
  - redline
related:
  - map-editing-comments
  - map-editing-presence
  - items-map
---

Markup is the fastest way to get team feedback on a map. Anyone who
can view the map can drop pins on it, group them into named markup
sets, and ship the link back to the team. No editor permission needed.

The classic use case: a project manager opens a shared parcel map,
spots three parcels with wrong boundaries, drops a pin on each one,
and emails the map URL to the analyst who can fix the underlying
data. The analyst sees the manager's pins overlaid on the map next
to their own work and knows exactly which features to look at.

## Opening the Markup panel

In the map editor toolbar, click the pencil icon. The Markup panel
slides in from the right.

## Adding markup

Click **Add markup**. A new markup set appears, named after you and
today's date, with an auto-assigned color so two reviewers' markups
don't clash. Each set is its own layer of pins.

To drop a pin: pan the map so the spot you want is at the center,
then click **Drop pin at center** inside the markup set. The pin
appears in the set's color.

## Multiple reviewers, distinct colors

When several people add markup to the same map, each person's set
gets its own color from a built-in palette. The colors are picked
so two adjacent ones never look the same, including for common
forms of color blindness.

You can rename your set (click the title), recolor it (click a
swatch), or hide it temporarily (eye icon). Hiding only affects
your own view; the set is still there for everyone else.

## Who can edit which markup

- The author of a markup set can edit or delete it at any time.
- A map editor (someone with edit permission on the map item) can
  edit or delete any markup set on that map. This is the cleanup
  path: an admin can remove abandoned markup from a long-running
  shared map without asking the author.
- Other viewers can see all markup sets but can only edit or
  delete their own.

## What ships in Phase 1

The Markup tool today supports point pins. Lines, polygons, arrows,
text labels, and free-form drawing tools are on the way in
Phase 1.5.

## Tips

- Drawings persist on the map item. A new visitor sees every set
  that's been added so far.
- A markup set isn't a data layer. To turn one into a real layer
  you can style and share with embeds, the upcoming "Promote to
  data layer" action will copy the pins into a new data layer
  owned by you.
- Comments threaded against the map and against individual pins
  pair nicely with markup. See [Comments](map-editing-comments)
  for the conversation side.

## Related

- [Comments](map-editing-comments) for threaded conversations on a map.
- [Live presence](map-editing-presence) to see who else is looking
  at the map in real time.
