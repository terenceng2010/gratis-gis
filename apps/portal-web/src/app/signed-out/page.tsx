import Link from 'next/link';
import { LogIn } from 'lucide-react';

/**
 * Landing page after federated logout. Keycloak redirects here once
 * it's cleared its own SSO session (see /api/auth/federated-logout).
 * We explicitly DON'T auto-redirect to the sign-in flow — that would
 * defeat the whole purpose of signing out and immediately re-enter
 * the auth loop. The user clicks "Sign in" when they're ready.
 *
 * Page is public (no auth required) and sits outside the app-shell
 * so there's no nav chrome prompting re-auth.
 */
export const metadata = { title: 'Signed out' };

export default function SignedOutPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-0 p-6">
      <div className="w-full max-w-md space-y-4 rounded-lg border border-border bg-surface-1 p-6 shadow-card">
        <h1 className="text-2xl font-semibold tracking-tight text-ink-0">
          You&apos;re signed out
        </h1>
        <p className="text-sm text-muted">
          Your session has ended here and in the identity provider. The
          next sign-in will prompt for credentials.
        </p>
        <Link
          href="/api/auth/signin"
          className="inline-flex h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground shadow-card hover:opacity-90"
        >
          <LogIn className="h-4 w-4" />
          Sign in
        </Link>
      </div>
    </main>
  );
}
