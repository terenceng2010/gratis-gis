// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Loader + parser for the public-facing changelog rendered as a
 * "What's new" card on the landing page (#90 follow-up).
 *
 * The source of truth is
 * apps/portal-web/content/changelog/user-visible.md.  It lives next
 * to the help content (rather than under docs/) so the Next.js
 * standalone build traces it into the deployed image.  The docs/
 * tree carries a one-line pointer for discoverability.
 *
 * The file format is intentionally tiny:
 *
 *   ## YYYY-MM-DD - Short feature name
 *   One short paragraph of plain-English description.
 *
 *   ## YYYY-MM-DD - Another feature
 *   ...
 *
 * Entries return in source order (newest first by convention).  The
 * parser is forgiving: anything that doesn't match an entry heading
 * is skipped.  File read is wrapped in try/catch so a missing file
 * degrades to an empty list rather than blowing up the landing.
 */

export interface WhatsNewEntry {
  /** ISO YYYY-MM-DD date string from the heading. */
  date: string;
  /** Short feature name from the heading (post-dash). */
  name: string;
  /** Plain-text body paragraph. */
  description: string;
}

/**
 * Match a heading line of the form `## YYYY-MM-DD - Name`.  The
 * separator can be a hyphen, en-dash, or em-dash so the parser
 * tolerates files edited in either editors that auto-replace
 * dashes or markdown that keeps a plain hyphen.
 */
const HEADING_RE = /^##\s+(\d{4}-\d{2}-\d{2})\s*[-–—]\s*(.+?)\s*$/;

/**
 * Resolve the changelog file path across both dev and standalone
 * production builds.  Mirrors the help-content loader's
 * dev-cwd-vs-traced-files pattern so a `next dev` from
 * apps/portal-web and a standalone Docker container both find the
 * file.
 *
 *   - Dev: `next dev` runs from apps/portal-web; the file lives at
 *     <cwd>/content/changelog/user-visible.md.
 *   - Prod standalone: cwd is /app and the traced files live at
 *     /app/apps/portal-web/content/changelog/user-visible.md.
 */
function resolveChangelogPath(): string {
  const local = path.join(
    process.cwd(),
    'content',
    'changelog',
    'user-visible.md',
  );
  const standalone = path.join(
    process.cwd(),
    'apps',
    'portal-web',
    'content',
    'changelog',
    'user-visible.md',
  );
  if (existsSync(local)) return local;
  if (existsSync(standalone)) return standalone;
  return local;
}

export async function loadWhatsNewEntries(
  limit?: number,
): Promise<WhatsNewEntry[]> {
  let raw: string;
  try {
    raw = await readFile(resolveChangelogPath(), 'utf8');
  } catch {
    return [];
  }
  const entries = parseEntries(raw);
  return typeof limit === 'number' ? entries.slice(0, limit) : entries;
}

export function parseEntries(raw: string): WhatsNewEntry[] {
  const lines = raw.split(/\r?\n/);
  const out: WhatsNewEntry[] = [];
  let current: { date: string; name: string; body: string[] } | null = null;
  for (const line of lines) {
    const match = line.match(HEADING_RE);
    if (match) {
      // Close the prior entry, if any.
      if (current) {
        out.push({
          date: current.date,
          name: current.name,
          description: current.body.join(' ').trim(),
        });
      }
      current = { date: match[1]!, name: match[2]!, body: [] };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('#')) {
      // A higher-level heading (e.g. `# What's new`) closes the
      // current entry without starting a new one.
      out.push({
        date: current.date,
        name: current.name,
        description: current.body.join(' ').trim(),
      });
      current = null;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith('<!--') || trimmed.length === 0) {
      // Blank lines and HTML comments are body separators, not
      // content.  Push a space to keep paragraph word boundaries
      // when the body wraps; the join + trim above absorbs runs.
      if (current.body.length > 0) current.body.push(' ');
      continue;
    }
    current.body.push(trimmed);
  }
  if (current) {
    out.push({
      date: current.date,
      name: current.name,
      description: current.body.join(' ').trim(),
    });
  }
  return out.filter((e) => e.description.length > 0);
}
