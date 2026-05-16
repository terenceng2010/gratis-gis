---
id: admin-geocoders
title: Geocoders
summary: Configure address-to-location services used by the search bar, the form designer's location-pick widget, and reverse geocoding in popups.
category: admin
order: 20
complexity: intermediate
tags:
  - admin
  - geocoder
  - nominatim
related:
  - admin-organization-settings
---

A **geocoder** is a service that turns addresses into coordinates
(and vice versa). The portal uses geocoders for the map search
bar, form location-picker widgets, and the reverse-geocode column
on form submissions. Configure one or more in admin →
geocoders.

## Supported services

- **Nominatim** (OpenStreetMap, self-hosted). The default for
 GratisGIS deployments. The portal ships with a Docker compose
 add-on (`infra/NOMINATIM.md`) that runs a local Nominatim
 against your region's OSM extract.
- **Photon** (OpenStreetMap, self-hosted). Faster fuzzy
 matching than Nominatim; less precise on full addresses.
- **Pelias** (self-hosted). Heavier setup, more capable.
- **Esri World Geocoding** (external, requires a key).
- **Google Geocoding** (external, requires a key, has
 commercial terms).
- **Custom HTTP** (any service that returns a documented JSON
 shape).

Multiple geocoders can be configured simultaneously. Maps
reference them by name; the org default is the geocoder used
when nothing else is specified.

## Adding a geocoder

1. **Admin → Geocoders → New**.
2. Pick the service type.
3. Fill in:
   - **Name** (visible to users when they pick a geocoder).
   - **Endpoint URL**.
   - **Auth** (key, token, basic auth) if required.
   - **Default country / language hints**.
   - **Result limits** (max results per query).
4. Click **Test** with a known address; verify the response.
5. Save.

## Per-map geocoder

A map can override the org default by referencing a specific
geocoder item. Useful when one map is country-specific and
another is regional.

## Reverse geocoding

The reverse-geocode column on forms uses the same geocoder
config. When a form respondent picks a location, the portal
asynchronously reverse-geocodes and stores the resulting
address as a separate field. The reverse-geocode is best-effort;
failures don't block submission.

## Rate limits and quotas

Self-hosted geocoders (Nominatim, Photon) are typically
unlimited; commercial ones meter per request. The portal
respects per-geocoder rate limits configured here and falls
back to the next available geocoder if a primary fails.

## Notes

- **Nominatim usage policy** for the public server is **not**
 OK for production. Run your own instance for any deployment
 with real users. The infra add-on builds one off an OSM
 region extract you supply.
- **Coordinate systems**. Geocoders return WGS-84 (EPSG:4326)
 lat/lon. The portal stores everything in 4326 anyway, no
 conversion needed.
- **No PII storage**. The portal doesn't cache search queries
 against the user; only the result coordinate is kept (when
 a form respondent picks a location).
