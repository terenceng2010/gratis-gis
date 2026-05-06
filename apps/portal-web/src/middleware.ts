/**
 * Route-level auth guard. Redirects unauthenticated users to sign-in and
 * preserves the originally requested URL as callbackUrl, so they land
 * where they intended after authenticating.
 *
 * Also stamps an `x-gratis-pathname` request header on every protected
 * request so server components downstream can branch on the current
 * route without a custom server. Used by AppShell to suppress its own
 * chrome on the field-deployment runtime (which owns the full
 * viewport).
 *
 * The `matcher` below is the list of routes that require a session. Public
 * pages (the home page, the /api/auth/* routes) are intentionally excluded.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { withAuth } from 'next-auth/middleware';

export default withAuth(
  function onAuthorized(req: NextRequest) {
    // Forward the path to the downstream handlers so a server
    // component can read it via headers().get('x-gratis-pathname').
    // Re-issuing the request is the documented Next.js pattern for
    // injecting headers from middleware.
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set('x-gratis-pathname', req.nextUrl.pathname);
    return NextResponse.next({ request: { headers: requestHeaders } });
  },
  {
    pages: {
      // Mirror authOptions.pages.signIn so middleware redirects skip
      // the default provider picker and go straight to /signin, which
      // immediately calls signIn('keycloak'). One provider == one less
      // click for the user.
      signIn: '/signin',
    },
    callbacks: {
      // Default behavior is "authorized iff token present". We allow
      // a small allowlist of paths under matcher coverage to be
      // public. The Web App Manifest under /field/manifest.webmanifest
      // is the obvious one: PWA installers fetch it without the
      // user's session cookies (different fetch context), and a
      // 307-to-/signin breaks the install. Manifest files contain
      // no protected data; serving them anonymously is safe.
      authorized: ({ req, token }) => {
        if (req.nextUrl.pathname === '/field/manifest.webmanifest') {
          return true;
        }
        // #307 anonymous public access: a shared viewer link has the
        // form /items/:id/viewer/run. Let it through without a token
        // and let the page itself decide whether the item is
        // public-shared (render) or private (redirect to sign-in).
        // This is the AGOL model: the public link works for anyone
        // when the admin marked the item public, and falls back to
        // sign-in otherwise. The /editor/run path is left auth'd --
        // public anonymous editing is not a thing.
        //
        // #260: /items/:id/survey/run is also a read-only runtime
        // (you "view responses, never edit a submission"), so it
        // shares the same anonymous-public allowlist behavior.
        if (
          /^\/items\/[^/]+\/(?:viewer|survey)\/run(?:\/|$)/.test(
            req.nextUrl.pathname,
          )
        ) {
          return true;
        }
        return !!token;
      },
    },
  },
);

export const config = {
  matcher: [
    '/items/:path*',
    '/groups/:path*',
    '/reports/:path*',
    '/recently-deleted/:path*',
    '/profile/:path*',
    '/field/:path*',
  ],
};
