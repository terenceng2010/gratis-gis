# Discoverability

Notes on how we make GratisGIS easy to find on GitHub and the wider web
once the repo goes public. Re-read this before any release announcement.

## GitHub repo description (160-char limit)

Recommended:

```
Open-source, self-hosted geospatial portal with web maps, app builder,
offline field data collection, notebooks, and a visual tool builder.
Built on PostGIS + MapLibre. Inspired by modern cloud-GIS platforms.
```

Trim for the 160-char About field on github.com.

## GitHub topics (max 20)

Pick the 20 highest-signal tags. GitHub uses these for search and the
Explore page.

```
gis
geospatial
mapping
webgis
open-source-gis
open-source
self-hosted
postgis
maplibre
offline-first
field-data-collection
form-builder
survey
jupyter
keycloak
typescript
nextjs
nestjs
react-native
monorepo
```

Apply with:

```bash
gh repo edit <owner>/gratis-gis \
  --description "Open-source, self-hosted geospatial portal. Web maps, app builder, offline field collection, notebooks, and a visual tool builder. Built on PostGIS + MapLibre." \
  --homepage "https://gratisgis.org" \
  --add-topic gis --add-topic geospatial --add-topic mapping --add-topic webgis \
  --add-topic open-source-gis --add-topic open-source --add-topic self-hosted \
  --add-topic postgis --add-topic maplibre --add-topic offline-first \
  --add-topic field-data-collection --add-topic form-builder --add-topic survey \
  --add-topic jupyter --add-topic keycloak --add-topic typescript \
  --add-topic nextjs --add-topic nestjs --add-topic react-native --add-topic monorepo
```

## README badges

Placed directly under the title so they render in listings. Keep the set
small; badge clutter looks unprofessional.

```markdown
[![CI](https://github.com/<owner>/gratis-gis/actions/workflows/ci.yml/badge.svg)](https://github.com/<owner>/gratis-gis/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)
[![PostgreSQL + PostGIS](https://img.shields.io/badge/PostgreSQL%20%2B%20PostGIS-16%20%2F%203-336791?logo=postgresql&logoColor=white)](https://postgis.net/)
[![OSS Geospatial](https://img.shields.io/badge/OSGeo-friendly-brightgreen)](https://www.osgeo.org/)
```

## package.json keywords

npm search and ecosystem tools index these. Added to root `package.json`.

## Social preview image

GitHub lets us upload a 1280x640 PNG shown in link previews (Twitter,
Slack, etc.). Track this as a Phase 1 design task; it should show the
wordmark over a subtle map texture, matching the design system.

## Once public: outreach targets

- `awesome-gis` list (PR ourselves in)
- `awesome-self-hosted` list
- OSGeo news and mailing lists
- Hacker News "Show HN"
- `r/gis`, `r/selfhosted`
- Dev.to + Hashnode launch posts

Draft announcements live in `docs/marketing/` (TBD).
