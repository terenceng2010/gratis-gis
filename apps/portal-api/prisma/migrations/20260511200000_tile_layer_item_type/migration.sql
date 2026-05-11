-- #179 tile_layer item type. Wraps a PMTiles file uploaded to
-- MinIO, exposes a range-request proxy endpoint that MapLibre's
-- pmtiles protocol plugin consumes. data_json shape is
-- TileLayerData from shared-types.

ALTER TYPE "ItemType" ADD VALUE 'tile-layer';
