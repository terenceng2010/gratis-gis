/**
 * GratisGIS Service Worker
 *
 * Caching strategy:
 *   - Static assets (JS, CSS, fonts, images): Cache-first with background revalidation.
 *   - GeoJSON feature data (/api/portal/items/:id/geojson): Network-first with
 *     cache fallback so maps render offline with the last-seen dataset.
 *   - Other portal-api reads (/api/portal/*): Network-first with no offline fallback
 *     (these need fresh auth tokens and change frequently).
 *   - Queued writes: Stored in IndexedDB and replayed when online via Background Sync.
 *
 * Versioning: bump CACHE_VERSION on every deploy so stale assets are evicted.
 */

const CACHE_VERSION = 'v1';
const STATIC_CACHE = `gratis-static-${CACHE_VERSION}`;
const GEOJSON_CACHE = `gratis-geojson-${CACHE_VERSION}`;
const SYNC_QUEUE_TAG = 'gratis-feature-sync';

// Detect the Next.js dev server. Dev chunks under /_next/static/ reuse
// filenames across restarts, so cache-first serves up stale JS whose
// module IDs no longer exist in the current webpack runtime — that
// produces the dreaded `options.factory undefined` crash. Short-
// circuit static asset caching when running on localhost so dev is
// always fresh. The SwRegistrar should prevent this SW from loading
// in dev at all, but this guard handles the case where an older SW
// from a prior session is still running.
const IS_DEV_HOST =
  self.location.hostname === 'localhost' ||
  self.location.hostname === '127.0.0.1' ||
  self.location.hostname.endsWith('.local') ||
  self.location.hostname.endsWith('.localhost');

// Next.js static assets are served from /_next/static/ — these are
// content-addressed (hash in filename) so they are safe to cache forever.
const STATIC_PATTERNS = [
  /^\/_next\/static\//,
  /^\/fonts\//,
  /\.(?:png|jpg|jpeg|svg|ico|webp|woff2?)$/,
];

const GEOJSON_PATTERN = /\/api\/portal\/items\/[^/]+\/geojson/;

// -------------------------------------------------------------------------
// Install: nothing special; let the browser manage static asset caching.
// -------------------------------------------------------------------------
self.addEventListener('install', (event) => {
  // Skip waiting so the new SW activates immediately on the next navigate.
  self.skipWaiting();
});

// -------------------------------------------------------------------------
// Activate: clean up old caches.
// -------------------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== STATIC_CACHE && k !== GEOJSON_CACHE)
          .map((k) => caches.delete(k)),
      ),
    ).then(() => self.clients.claim()),
  );
});

// -------------------------------------------------------------------------
// Fetch: intercept and apply caching strategy.
// -------------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only intercept same-origin requests. Third-party tiles, Keycloak, etc.
  // pass through unmodified.
  if (url.origin !== self.location.origin) return;

  // GeoJSON: network-first with cache fallback (enables offline map rendering).
  if (GEOJSON_PATTERN.test(url.pathname)) {
    event.respondWith(networkFirstWithCache(request, GEOJSON_CACHE));
    return;
  }

  // Static assets: cache-first in prod (content-addressed), pass-through
  // in dev (chunk filenames aren't stable across dev server restarts).
  if (STATIC_PATTERNS.some((p) => p.test(url.pathname))) {
    if (IS_DEV_HOST) return;
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // Everything else: pass through to the network. This includes auth flows
  // and API mutations which must be fresh.
});

// -------------------------------------------------------------------------
// Background Sync: replay queued feature writes when back online.
// -------------------------------------------------------------------------
self.addEventListener('sync', (event) => {
  if (event.tag === SYNC_QUEUE_TAG) {
    event.waitUntil(replayQueue());
  }
});

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirstWithCache(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Network failed — serve from cache.
    const cached = await cache.match(request);
    if (cached) return cached;
    // No cache either; return an empty FeatureCollection so MapLibre
    // doesn't crash when the layer source URL resolves.
    return new Response(
      JSON.stringify({ type: 'FeatureCollection', features: [] }),
      { headers: { 'content-type': 'application/json' } },
    );
  }
}

/**
 * Read pending writes from IndexedDB and replay them against the API.
 * Successfully replayed ops are removed from the queue. Failed ones
 * stay and will be retried on the next sync event.
 */
async function replayQueue() {
  let db;
  try {
    db = await openDb();
  } catch {
    return;
  }

  const tx = db.transaction('sync_queue', 'readwrite');
  const store = tx.objectStore('sync_queue');
  const ops = await idbAll(store);

  for (const op of ops) {
    try {
      await replayOp(op);
      // Remove on success.
      const delTx = db.transaction('sync_queue', 'readwrite');
      delTx.objectStore('sync_queue').delete(op.id);
      await idbComplete(delTx);
    } catch {
      // Leave in queue; will retry on next sync.
    }
  }
}

async function replayOp(op) {
  const { itemId, method, path, body } = op;
  const url = `/api/portal/items/${itemId}${path}`;
  const response = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`Sync failed: ${response.status}`);
  }
}

// -------------------------------------------------------------------------
// Minimal IndexedDB helpers (no library deps in SW scope)
// -------------------------------------------------------------------------

const DB_NAME = 'gratis-gis';
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('sync_queue')) {
        const store = db.createObjectStore('sync_queue', { keyPath: 'id' });
        store.createIndex('itemId', 'itemId', { unique: false });
        store.createIndex('queuedAt', 'queuedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('feature_cache')) {
        const fc = db.createObjectStore('feature_cache', { keyPath: ['itemId', 'globalId'] });
        fc.createIndex('itemId', 'itemId', { unique: false });
        fc.createIndex('syncedAt', 'syncedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('sync_cursors')) {
        db.createObjectStore('sync_cursors', { keyPath: 'itemId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbAll(store) {
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbComplete(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
