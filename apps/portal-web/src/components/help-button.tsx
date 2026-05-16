// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

/**
 * Top-bar Help button.  Opens the global HelpDrawer (which lives
 * at the layout level so it survives route changes).  Separate
 * file so the button can be imported into AppShellChrome without
 * dragging the whole drawer into the chrome's bundle.
 */
import { HelpCircle } from 'lucide-react';
import { useHelpDrawer } from './help-drawer';

export function HelpButton() {
  const { open } = useHelpDrawer();
  return (
    <button
      type="button"
      onClick={open}
      title="Help (press ? anywhere)"
      aria-label="Open help"
      className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted hover:bg-surface-2"
    >
      <HelpCircle className="h-4 w-4" />
    </button>
  );
}
