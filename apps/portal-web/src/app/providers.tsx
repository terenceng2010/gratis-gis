// SPDX-License-Identifier: AGPL-3.0-or-later
'use client';

import { SessionProvider } from 'next-auth/react';
import type { ReactNode } from 'react';

import { DialogProvider } from '@/components/dialog-provider';
import { HelpDrawerProvider } from '@/components/help-drawer';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <DialogProvider>
        <HelpDrawerProvider>{children}</HelpDrawerProvider>
      </DialogProvider>
    </SessionProvider>
  );
}
