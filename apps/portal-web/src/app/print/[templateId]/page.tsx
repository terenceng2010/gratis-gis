// SPDX-License-Identifier: AGPL-3.0-or-later
import { PrintRenderClient } from './print-render-client';

/**
 * #101: print render page.  Server component shell that hands the
 * template id + URL params off to the client renderer, which fetches
 * the template, resolves bindings, and triggers `window.print()`.
 *
 * Why a dedicated page (vs. a modal in the runtime widget): the
 * browser's print-to-PDF preview is invoked on the page that owns
 * `window`, so the rendered layout has to be the entire page body.
 * A dedicated route also gives the user a stable URL they can keep
 * open / re-print without round-tripping through the web app.
 */
export default async function PrintRenderPage(
  props: {
    params: Promise<{ templateId: string }>;
  }
) {
  const params = await props.params;
  return <PrintRenderClient templateId={params.templateId} />;
}
