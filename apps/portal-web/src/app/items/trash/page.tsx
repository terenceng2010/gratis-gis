// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from 'next/navigation';

// The per-section trash page was merged into the global
// /recently-deleted surface so there's a single safety net across
// every kind of content. This shim keeps any stale links working.
export default function ItemsTrashRedirect() {
  redirect('/recently-deleted?kind=items');
}
