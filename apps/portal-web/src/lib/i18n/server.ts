// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #162 Phase 1.1 server-side locale resolver.
 *
 * Called from the root layout (and from any server component that
 * needs the active locale for a `t()` call). Order of precedence:
 *
 *   1. The `gg_locale` cookie set by the LocaleSwitcher. Picking a
 *      locale from the UI is an explicit user choice and overrides
 *      anything the browser reports.
 *   2. The Accept-Language header. Negotiated against the
 *      SupportedLocale set with q-value handling.
 *   3. The English default.
 *
 * The cookie is named `gg_locale` rather than just `locale` to
 * minimize collision with other apps on a shared dev domain.
 *
 * Cookie / header reads happen inside next/headers which is
 * server-side-only; this module is never bundled into a client
 * chunk.
 */
import { cookies, headers } from 'next/headers';

import {
  DEFAULT_LOCALE,
  LOCALES,
  negotiateLocale,
  type SupportedLocale,
} from './locales';

const COOKIE_NAME = 'gg_locale';
const SUPPORTED = new Set<string>(LOCALES.map((l) => l.code));

export async function getServerLocale(): Promise<SupportedLocale> {
  // Cookie wins when it carries a known locale. Next 15+ returns
  // a Promise from cookies() / headers() in server components and
  // route handlers; await both rather than reach for the
  // sync-shim shape.
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(COOKIE_NAME)?.value;
  if (cookieValue && SUPPORTED.has(cookieValue)) {
    return cookieValue as SupportedLocale;
  }
  const headerStore = await headers();
  const accept = headerStore.get('accept-language');
  if (accept) return negotiateLocale(accept);
  return DEFAULT_LOCALE;
}

export { COOKIE_NAME as LOCALE_COOKIE_NAME };
