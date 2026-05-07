// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * Layout segment for /field. Its only job is to override the root
 * layout's manifest URL so PWA installs from this route get a
 * field-scoped manifest (start_url=/field, scope=/field/). The root
 * manifest is global-scope, so without this an install from /field
 * would land on the apex when launched from the home screen.
 *
 * No JSX of its own -- the children render through to /field/page.tsx
 * and the per-deployment runtime under /items/[id]/field.
 */
export const metadata: Metadata = {
  manifest: '/field/manifest.webmanifest',
};

export default function FieldLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
