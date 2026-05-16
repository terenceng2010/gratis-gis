---
id: analysis-spatial-join
title: Spatial join
summary: Attach attributes from one layer to features of another, based on a spatial relationship (intersects, within, contains, nearest).
category: analysis
order: 30
complexity: intermediate
tags:
  - analysis
  - derived-layer
  - spatial-join
related:
  - items-derived-layer
  - analysis-group-by
---

A **spatial join** step attaches attributes from one layer (the
"join") to features of another (the "target") based on a spatial
relationship. The output has the target's geometry and the
combined attributes.

This is the workhorse of "tell me which X each Y is in".
Hydrants per parcel. Parcels per neighborhood. Points within a
buffer.

## Inputs

- **Target layer**. Features keep their geometry; their rows are
 in the output.
- **Join layer**. Features whose attributes get attached.
- **Predicate** (the relationship):
  - **Intersects**. Any overlap. Default for most cases.
  - **Within**. Target is entirely inside join.
  - **Contains**. Target entirely contains join.
  - **Nearest** (one-to-one). Pick the single closest join
    feature per target.
  - **Within distance**. Target is within N meters/feet of join.
- **Field selection**. Which join fields to attach to the
 output. By default all of them, prefixed `join_`.
- **Cardinality**:
  - **One-to-one** (`nearest`): one output row per target row.
  - **One-to-many** (default): one output row per matching pair.
    If a target intersects three join features, it produces three
    output rows.

## Output

- Geometry: from the target.
- Attributes: target's fields + selected join fields.
- Row count: depends on cardinality (see above).

## How to use it on its own

1. New-item wizard → **Derived layer**.
2. Pick **Target**.
3. Add a **Spatial join** step.
4. Pick the **Join** layer.
5. Choose the **Predicate** and **Cardinality**.
6. (Optional) Trim the join-field selection.
7. Save.

## Examples

- **Hydrants in each parcel**. Target: parcels. Join: hydrants.
 Predicate: contains. Cardinality: one-to-many → one row per
 (parcel, hydrant) pair. Pair this with a **group-by** step to
 count hydrants per parcel.
- **Nearest fire station per parcel**. Target: parcels. Join:
 fire stations. Predicate: nearest. Cardinality: one-to-one.
 The output adds a `join_station_id` and a `join_distance` per
 parcel.
- **Parcels in a neighborhood**. Target: parcels. Join:
 neighborhoods. Predicate: within. Cardinality: one-to-one (each
 parcel is in exactly one neighborhood, in well-formed data).

## Notes

- **Geometry index helps.** Both layers should have GIST indexes
 (data layers do by default). Without indexes, spatial joins on
 100k-feature layers slow down sharply.
- **Coordinate systems are reconciled automatically.** Both
 layers are reprojected to a common SRS for the join; no manual
 step.
- **NULL geometry** in either side drops the row from the join
 output. The original target features with NULL geometry are
 still present elsewhere; they just don't get join attributes.
