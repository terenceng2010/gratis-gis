// SPDX-License-Identifier: AGPL-3.0-or-later
import { ImageResponse } from 'next/og';

/**
 * Open Graph + Twitter card image (#SEO).  Next.js serves this at
 * /opengraph-image at the size declared in `size` below; the URL
 * is auto-injected into `<meta property="og:image">` by the
 * framework so we don't have to declare it ourselves in
 * `metadata.openGraph.images`.
 *
 * Generated dynamically rather than shipped as a static .png so the
 * card visual lives next to the code that informs it (project
 * tagline, accent colors).  Replace this file with a hand-tuned PNG
 * later if you want pixel-perfect typography; the route name +
 * exports stay the same.
 *
 * Twitter reuses this same image via the `images` field in
 * `metadata.twitter` in layout.tsx (matching dimensions; Twitter
 * accepts the 1200x630 OG card directly).
 */

export const runtime = 'edge';
export const alt =
  'GratisGIS — open-source self-hosted geospatial portal';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          width: '100%',
          height: '100%',
          padding: '80px',
          // Forest-theme cream + sage accent so the card matches
          // the portal's visual identity instead of looking like
          // every other dev-tool launch.
          background:
            'linear-gradient(135deg, #f4f0e6 0%, #e8e2d4 60%, #d8d3c1 100%)',
          color: '#2d3a2f',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div
            style={{
              fontSize: 32,
              fontWeight: 500,
              letterSpacing: 4,
              color: '#5e6e5f',
              textTransform: 'uppercase',
            }}
          >
            GratisGIS
          </div>
          <div
            style={{
              fontSize: 84,
              fontWeight: 700,
              lineHeight: 1.05,
              color: '#1f2920',
              maxWidth: 980,
            }}
          >
            Open-source, self-hosted geospatial portal.
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          <div
            style={{
              fontSize: 36,
              fontWeight: 500,
              color: '#5e6e5f',
              lineHeight: 1.3,
              maxWidth: 1040,
            }}
          >
            Maps · app builder · offline field collection · visual
            tool builder. Built on PostGIS + MapLibre.
          </div>
          <div
            style={{
              display: 'flex',
              gap: 24,
              fontSize: 24,
              color: '#7a8a7b',
              marginTop: 16,
            }}
          >
            <span>gratisgis.org</span>
            <span>·</span>
            <span>AGPL-3.0</span>
            <span>·</span>
            <span>github.com/palavido-dev/gratis-gis</span>
          </div>
        </div>
      </div>
    ),
    {
      ...size,
    },
  );
}
