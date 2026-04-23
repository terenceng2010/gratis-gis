'use client';

import { useEffect } from 'react';
import { listenForOnline } from '@/lib/sync';

/**
 * Registers the GratisGIS service worker and sets up an online-reconnect
 * handler to flush the pending write queue. Renders nothing.
 *
 * Must be a client component — placed in the root layout so it runs once
 * per browser session regardless of which page is visited first.
 */
export function SwRegistrar() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .catch((err) => console.warn('[SW] Registration failed:', err));

    // Flush queued writes whenever connectivity is restored.
    const cleanup = listenForOnline();
    return cleanup;
  }, []);

  return null;
}
