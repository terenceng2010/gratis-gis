// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #162 Phase 1.1 locale-switch endpoint.
 *
 * POST /api/locale  { locale: '<supported>' }
 *
 * Sets the gg_locale cookie and returns 204. The client then
 * reloads so the server-rendered tree picks up the new locale on
 * the next request.
 *
 * Stays on the portal-web side (not portal-api) because the locale
 * is a UI-layer preference: the backend API is locale-agnostic and
 * always returns canonical English strings.
 */
import { NextResponse } from 'next/server';

import { LOCALES, type SupportedLocale } from '@/lib/i18n/locales';
import { LOCALE_COOKIE_NAME } from '@/lib/i18n/server';

const SUPPORTED = new Set<string>(LOCALES.map((l) => l.code));

export async function POST(req: Request) {
  let body: { locale?: unknown };
  try {
    body = (await req.json()) as { locale?: unknown };
  } catch {
    return NextResponse.json(
      { error: 'invalid_json' },
      { status: 400 },
    );
  }
  const locale = typeof body.locale === 'string' ? body.locale : '';
  if (!SUPPORTED.has(locale)) {
    return NextResponse.json(
      { error: 'unsupported_locale' },
      { status: 400 },
    );
  }
  const res = new NextResponse(null, { status: 204 });
  res.cookies.set({
    name: LOCALE_COOKIE_NAME,
    value: locale as SupportedLocale,
    // 1 year — locale prefs persist across browser restarts.
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
    path: '/',
    httpOnly: false,
  });
  return res;
}
