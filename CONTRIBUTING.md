# Contributing to GratisGIS

Thanks for considering contributing! This doc explains how the project is
organized and how to propose changes.

## Project is in active scaffolding

We're in Phase 0. Expect the architecture to be fluid and the issue tracker
to reflect near-term milestones from [ROADMAP.md](./ROADMAP.md).

## Branching & PRs

- `main` is always deployable.
- Feature work happens on branches named `feat/<short-slug>`; bug fixes on
  `fix/<short-slug>`.
- PRs require passing CI (lint, typecheck, test, build) and at least one
  review.

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(portal-api): add /groups/:id/members endpoint
fix(portal-web): don't crash on items with no thumbnail
docs: flesh out deployment guide
```

## Code style

- Prettier + ESLint are enforced. Run `pnpm format && pnpm lint`.
- TypeScript strict mode is non-negotiable; don't `any`-your-way-out.
- Shared contracts go in `packages/shared-types`. If a type is used by
  two or more apps, move it there.

## UX: guided before raw input

A hard product rule, not a suggestion. If a feature asks a user for a
non-trivial input (polygon, schema, list of values, URL, color, rows
of data), the **primary path must be visual, guided, or upload**:
draw on a map, pick from a list, upload a file, choose an existing
portal item, step through a wizard. Raw paste / typed-JSON / manual
coordinate entry is an *advanced fallback* behind a disclosure, not
the default way in. See the full rule in
[docs/design-system.md](./docs/design-system.md#principles) (rule 7).

Reviewers: if a PR adds a surface that lands on a textarea or a long
text input as the primary entry point, push back and ask for the
guided path first. The paste field can live in the PR, just not at
the front.

## Writing style (code comments, docs, commits, PRs)

These rules apply everywhere we write prose for this project: code
comments, commit messages, PR descriptions, docs, and markdown files.

- **No em dashes.** Do not use the `—` character. Do not use `--` as a
  substitute for an em dash. Pick a comma, colon, period, or parenthesis
  based on what the sentence actually needs.
- **No AI attribution or tells.** No `Claude`, `Anthropic`, `AI`,
  `Co-Authored-By` lines that reference an LLM, `Generated with`, or
  similar. Write in your own voice.
- **Plain, direct prose.** Short sentences over long ones. Concrete nouns
  over puffy abstractions. No "we're excited to announce" style.
- **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org/)
  and contain no em dashes, no AI attribution, and no marketing tone.

A pre-commit check may be added later to enforce the first two rules
automatically; until then, self-policing is expected.

## Tests

- Unit tests live next to source (`foo.ts` → `foo.spec.ts`).
- The authorization algorithm (`items/sharing.service.ts`) must have
  high coverage. it's the bedrock.

## Where should my change go?

| Change | Location |
| --- | --- |
| Add a new item type | `packages/shared-types` + `prisma/schema.prisma` + docs |
| New backend endpoint | `apps/portal-api/src/<module>` |
| Change how sharing works | `apps/portal-api/src/items/sharing.service.ts` (review carefully!) |
| New shared UI component | `packages/ui` |
| New app (field-app, app-builder, …) | `apps/<name>` |
| Infra (docker, helm, installer) | `/infra` (dev) or `/deploy` (prod) |

## Licensing

Contributions are accepted under the repo's license (Apache-2.0, TBD final).
