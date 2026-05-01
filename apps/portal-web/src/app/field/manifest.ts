import type { MetadataRoute } from 'next';

/**
 * Field-scoped Web App Manifest, served at /field/manifest.webmanifest
 * via Next's metadata-file convention. The root manifest at
 * /manifest.json is scoped at "/" so installs from anywhere in the
 * portal land on the apex on launch. Installing from /field should
 * pin the PWA to the field catalog so home-screen taps go straight
 * to "what am I collecting today" instead of the desktop-leaning
 * items list.
 *
 * /field/layout.tsx references this via metadata.manifest, so
 * Chrome / Android pick up the field-scoped values when the user
 * installs from /field. The root /manifest.json stays untouched for
 * any other install entry point.
 *
 * iOS Safari's Add-to-Home-Screen flow is governed by
 * apple-mobile-web-app-* tags on the page, not the manifest, so
 * adding /field on iOS still gets /field as start_url even without
 * this manifest. The metadata route covers Chrome / Edge Android
 * and any standards-compliant PWA installer.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'GratisGIS Field',
    short_name: 'GratisGIS Field',
    description: 'Field deployments for offline data collection.',
    // The two values that matter: the install scopes itself to
    // /field/ and launches into the catalog at /field. Everything
    // under /field stays in standalone-mode chrome; navigating up
    // and out (e.g. tapping into an item detail at /items/<id>) is
    // still allowed; "scope" only governs which paths render in
    // standalone vs falling back to a regular browser tab.
    start_url: '/field',
    scope: '/field/',
    display: 'standalone',
    background_color: '#0f0f10',
    theme_color: '#0f0f10',
    orientation: 'any',
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
    ],
    categories: ['productivity', 'utilities'],
  };
}
