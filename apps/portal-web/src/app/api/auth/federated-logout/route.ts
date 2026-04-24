import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { keycloakEndSessionBase } from '@/lib/auth';

/**
 * Federated logout — the piece plain NextAuth doesn't do.
 *
 * Problem: calling `/api/auth/signout` only drops the portal-side
 * session cookie. Keycloak's own SSO session stays alive, so the next
 * click on "Sign in with Keycloak" silent-auths the same user right
 * back in. The fix is OIDC RP-Initiated Logout:
 *
 *   1. We build a redirect to Keycloak's `end_session_endpoint`
 *      with the stored `id_token_hint` and a `post_logout_redirect_uri`
 *      pointing at our /signed-out page.
 *   2. We also clear the NextAuth session / CSRF cookies on the same
 *      response so the portal side is dropped in the same round-trip.
 *   3. The browser → Keycloak → Keycloak clears its SSO session and
 *      redirects to /signed-out.
 *   4. /signed-out renders a clean "you are signed out" page with a
 *      fresh "Sign in" link. Next click goes through Keycloak's login
 *      form for real (no silent auth because Keycloak has no session).
 *
 * Route is GET so it can be the target of a normal `<Link>` / `<a>`
 * — the app-shell's "Sign out" menu item points here instead of
 * `/api/auth/signout`.
 */
export async function GET(req: NextRequest) {
  // getToken's `secret` field is required; fall back to an empty
  // string if the env is somehow missing so the call type-checks —
  // the worst case is a null token, which we handle gracefully below
  // by relying on client_id alone for the Keycloak round-trip.
  const token = await getToken({
    req,
    secret: process.env.NEXTAUTH_SECRET ?? '',
  });
  const idToken = token?.idToken as string | undefined;

  const base = (
    process.env.NEXTAUTH_URL ?? new URL(req.url).origin
  ).replace(/\/$/, '');
  const postLogoutRedirectUri = `${base}/signed-out`;

  const endSession = new URL(keycloakEndSessionBase);
  if (idToken) endSession.searchParams.set('id_token_hint', idToken);
  endSession.searchParams.set(
    'post_logout_redirect_uri',
    postLogoutRedirectUri,
  );
  // `client_id` is required by Keycloak 19+ when no id_token_hint is
  // available; set it unconditionally so first-load cases (missing
  // id_token on the JWT for whatever reason) still complete the
  // round-trip.
  endSession.searchParams.set(
    'client_id',
    process.env.KEYCLOAK_CLIENT_ID_WEB ?? 'portal-web',
  );

  const res = NextResponse.redirect(endSession);

  // Wipe every NextAuth cookie variant on the way out. The exact
  // cookie name varies by deployment (secure prefix in production,
  // non-prefixed locally) so we cover both.
  for (const name of [
    'next-auth.session-token',
    '__Secure-next-auth.session-token',
    'next-auth.csrf-token',
    '__Host-next-auth.csrf-token',
    'next-auth.callback-url',
    '__Secure-next-auth.callback-url',
  ]) {
    res.cookies.set(name, '', {
      path: '/',
      maxAge: 0,
      httpOnly: true,
      sameSite: 'lax',
    });
  }

  return res;
}
