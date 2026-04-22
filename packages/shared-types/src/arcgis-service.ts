/**
 * Canonical shape stored in an Item's dataJson when `type = 'arcgis_service'`.
 *
 * An arcgis_service item is a thin pointer at a remote ArcGIS REST
 * MapServer or FeatureServer — no feature data lives in the item
 * itself. The viewer queries the service live by bounding box each
 * time a map draws the layer, so the item's job is just to persist
 * the minimum metadata a map layer needs (which URL, which sublayer,
 * what service type) plus a probed-at-creation snapshot of the layer
 * list so the picker doesn't have to re-hit the service every time
 * an author opens Add Layer.
 *
 * The `defaultLayerId` field names the layer a map uses when it picks
 * this item without specifying a sublayer. Services with a single
 * sublayer can omit it; multi-layer services typically point at the
 * most useful index.
 *
 * Authentication tokens are deliberately NOT stored here. That lives
 * on the item's secrets bag (once that infra ships) so share scopes
 * apply to credentials separately from the metadata.
 */
import type { ISODateString } from './ids';

export type ArcgisServiceKind = 'MapServer' | 'FeatureServer';

export interface ArcgisServiceLayerSnapshot {
  id: number;
  name: string;
  /** ArcGIS geometry enum when the layer has geometry (omit for tables). */
  geometryType?: string;
}

export interface ArcgisServiceData {
  version: 1;
  /** Root service URL, without a trailing /<layerId> segment. */
  url: string;
  serviceType: ArcgisServiceKind;
  /**
   * The sublayer the Portal picker should pre-select when a map
   * consumes this item. Optional so multi-layer services can leave
   * the choice to the map author.
   */
  defaultLayerId?: number;
  /** Probed at item-create time so the picker doesn't refetch. */
  layers: ArcgisServiceLayerSnapshot[];
  /**
   * Service-level full extent when the server reported it in WGS84.
   * Used to "Zoom to item" on the detail page without a round-trip.
   */
  bbox?: [number, number, number, number];
  probedAt?: ISODateString;
}

export const DEFAULT_ARCGIS_SERVICE: ArcgisServiceData = {
  version: 1,
  url: '',
  serviceType: 'MapServer',
  layers: [],
};
