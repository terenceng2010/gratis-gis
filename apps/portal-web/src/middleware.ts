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
