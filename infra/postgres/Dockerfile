# GratisGIS Postgres image. Extends postgis/postgis with pg_partman
# so the engine's `observation` table can be range-partitioned by
# `tx_time` (see ROADMAP Phase 8 + the engine pivot doc). The base
# image already ships PostgreSQL 16 + PostGIS 3.4 + the PostgreSQL
# Global Development Group's apt repository, so `apt-get install`
# resolves the PG16-targeted partman package directly.
#
# Why we extend instead of using a third-party "postgis-partman"
# image: this keeps the upstream chain short (postgres -> postgis ->
# us) and lets us track postgis security updates without a second
# maintainer in the loop.
FROM postgis/postgis:16-3.4

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        postgresql-16-partman \
    && rm -rf /var/lib/apt/lists/*
