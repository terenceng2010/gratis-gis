/**
 * Field-scoped Web App Manifest. The root manifest at /manifest.json
 * is scoped at "/" so installs from anywhere in the portal land on
 * the apex on launch. Installing from /field should pin the PWA to
 * the field catalog so home-screen taps go straight to "what am I
 * collecting today" instead of the desktop-leaning items list.
 *
 * /field/layout.tsx points its metadata.manifest at this route, so
 * Chrome / Android pick up the field-scoped values when the user
 * installs from /field. The root manifest stays untouched for any
 * other install entry point (e.g. installing from the items list).
 *
 * iOS Safari's Add-to-Home-Screen flow is governed by
 * apple-mobile-web-app-* tags on the page, not the manifest, so the
 * apple* metadata in the root layout still applies. The start URL
 * iOS uses is the page that was open when the user tapped Share, so
 * "Add to Home Screen" from /field gets /field as start_url even
 * without this manifest -- but the manifest covers Chrome / Edge
 * Android and any standards-compliant PWA installer.
 */
export function GET() {
  const body = {
    name: 'GratisGIS Field',
    short_name: 'GratisGIS Field',
    description: 'Field deployments for offline data collection.',
    // The two values that matter: the install scopes itself to
    // /field/ and launches into the catalog at /field. Everything
    // under /field stays in standalone-mode chrome; navigating up
    // and out (e.g. tapping into an item detail at /items/<id>) is
    // still allowed -- "scope" only governs which paths render in
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
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/manifest+json',
      // Manifests don't change often; let the browser hold onto one
      // for a day. Bump the path or invalidate via the SW if we
      // ever need to ship a new manifest mid-session.
      'cache-control': 'public, max-age=86400',
    },
  });
}
