/**
 * Canonical shape stored in an Item's data_json when `type = 'file'`.
 *
 * A file item is a thin wrapper around one MinIO object: a PDF, a CSV,
 * an image, a zipped shapefile, anything the user wants to share that
 * doesn't have a richer item type of its own. The portal stores
 * the bytes (presigned-PUT direct to MinIO at create time) and the
 * metadata; downloads serve the public URL gated by the item's
 * visibility + the share's download permission tier (#32).
 *
 * Files keep their original name in metadata so the download link
 * preserves it; the storage key is a UUID under `item-file/` to
 * avoid collisions and to keep the bucket browseable.
 */
import type { ISODateString } from './ids';

export interface FileData {
  version: 1;
  /** Object key inside the MinIO bucket (e.g. `item-file/abc...uuid`).
   *  Used by the API for cleanup on item delete; not surfaced to the
   *  user. */
  storageKey: string;
  /** Public URL the browser fetches for download. The MinIO bucket is
   *  anonymous-read by design (matches every other public asset), so
   *  this is a stable URL once the upload completes. Gating is at the
   *  item-visibility layer: a viewer who can see the item gets this
   *  URL; a non-viewer never receives it. */
  storageUrl: string;
  /** Original filename the user uploaded, preserved for the Download
   *  affordance + the Content-Disposition fallback. */
  fileName: string;
  /** MIME type the browser asserted at upload time. Used to pick a
   *  preview surface (image / PDF / generic). */
  mimeType: string;
  /** Size in bytes. Drives the file-size readout on the detail page;
   *  also lets the housekeeping storage card account for file items. */
  sizeBytes: number;
  /** When the upload completed. Distinct from item.updatedAt because
   *  a Replace-file action would keep updatedAt aligned but we want
   *  to know the bytes' age separately. */
  uploadedAt: ISODateString;
}

export const DEFAULT_FILE: FileData = {
  version: 1,
  storageKey: '',
  storageUrl: '',
  fileName: '',
  mimeType: 'application/octet-stream',
  sizeBytes: 0,
  uploadedAt: new Date(0).toISOString() as ISODateString,
};
