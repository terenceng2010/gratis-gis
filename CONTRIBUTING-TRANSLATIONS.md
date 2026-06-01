# Translating GratisGIS

Thanks for helping translate GratisGIS into a new language. This
file is the operator and contributor guide for the i18n surface.

## What's here right now

Phase 1 of the i18n work ships the infrastructure pieces:

- The supported-locale list at
  `apps/portal-web/src/lib/i18n/locales.ts`.
- The English reference catalog at
  `apps/portal-web/src/lib/i18n/messages/en.ts`.
- A vanilla `t(key, params?, locale?)` runtime at
  `apps/portal-web/src/lib/i18n/index.ts` that handles catalog
  lookup, `{name}` placeholders, and ICU-style plural cases.
- Accept-Language negotiation in the same module.

The Phase 1 catalog is intentionally small: just the strings on
the most prominent surfaces a brand-new visitor sees first.
Phase 1.1 will sweep the rest of the UI's hard-coded strings
into the catalog (every component import a `t()` call); Phase 1.2
swaps the lookup runtime for `next-intl` and sets up the
self-hosted translation platform.

## Currently supported locales

| Code | Native name | Status |
|---|---|---|
| `en` | English | Reference catalog, 100% |
| `es` | Español | Empty (falls back to English) |
| `pt-BR` | Português (Brasil) | Empty (falls back to English) |
| `fr` | Français | Empty (falls back to English) |
| `de` | Deutsch | Empty (falls back to English) |

A missing translation in a non-English catalog falls back to the
English value automatically, so a partial catalog never breaks
the UI.

## Adding a translation by hand (Phase 1)

1. Open `apps/portal-web/src/lib/i18n/messages/en.ts` to see the
   key structure and which strings need translating.
2. Create a sibling file like
   `apps/portal-web/src/lib/i18n/messages/es.ts`, copy the
   English structure, and translate each value.
3. Edit `apps/portal-web/src/lib/i18n/index.ts` to import your
   catalog and register it in the `CATALOGS` record next to `en`.
4. Open a pull request. Mention which strings you've covered
   and which still fall back to English. Anything you don't
   translate keeps showing the English value at runtime — no
   half-done states.

## Adding a new locale

1. Add the BCP-47 code to `SupportedLocale` in `locales.ts`.
2. Add an entry to `LOCALES` with the native + English names
   and starting completeness of 0.
3. Extend the `negotiateLocale` helper so the Accept-Language
   matcher picks up the new locale's primary subtag.
4. Add the locale to the `CATALOGS` record in `index.ts` with
   an empty object — English fall-through covers everything
   until you start translating.
5. Add your translations following the section above.

## Conventions

- **Key names** are dot-separated, namespaced by surface
  (`common`, `nav`, `newItem`, `mapEditor`, `comments`, etc.).
  Keep them grouped semantically, not by where they appear in
  the JSX.
- **Placeholders** use `{name}` syntax. Plural cases use
  `{count, plural, one {…} other {…}}`. The runtime currently
  ships English-default cardinal logic; locales with more
  cardinal categories (Russian's `few` / `many`, Arabic's
  `zero` / `two` / `few` / `many`) work when you supply the
  right case bodies, but the case picker is English-only in
  Phase 1.0. Phase 1.1 swaps to `Intl.PluralRules` per-locale
  so a translator can use the full cardinal vocabulary their
  language requires.
- **Don't translate proper nouns** like product names,
  organization names, "GratisGIS", or "PostGIS".
- **Keep the tone** consistent with the rest of the locale's
  catalog. Match the formality level of similar open-source GIS
  projects in that language community.

## Phase 1.2 will swap to `next-intl` and Weblate

The roadmap calls for the runtime to switch to `next-intl` and
the contribution platform to switch to a self-hosted Weblate
instance once the mechanical i18n-readiness sweep is done. Your
hand-translated catalogs from Phase 1 will be imported into
Weblate at that point; the contribution flow becomes a web UI
instead of pull requests.

If you'd rather wait for Weblate before contributing, that's
also fine — the English fallback keeps the UI usable in every
locale today.

## Questions

Open an issue with the `i18n` label.
