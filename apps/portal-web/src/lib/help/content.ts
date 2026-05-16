// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Help documentation loader (#118).
 *
 * Reads MDX-ish files from `apps/portal-web/content/help/`, parses
 * frontmatter via gray-matter, and converts the markdown body to
 * HTML via marked.  Runs server-side only -- the rendered HTML +
 * a slim search index ship to the client.
 *
 * File layout:
 *   content/help/<category>/<slug>.md   -> /help/<category>/<slug>
 *   content/help/<slug>.md              -> /help/<slug>     (top-level)
 *   content/help/index.md               -> /help            (landing)
 *
 * Each file's frontmatter is the single source of truth for nav
 * placement, search summary, control bindings (data-help ids that
 * point at this page), and prerequisites.  See `HelpFrontmatter`
 * below for the schema.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { marked } from 'marked';

/**
 * AI-ready metadata schema.  Every page must have at least
 * `title` and `summary`; the rest is optional.  Embeddings + LLM
 * retrieval will key off `summary` + `title` + body.
 */
export interface HelpFrontmatter {
  /** Stable id used in URLs, control data-help attributes, and
   *  cross-page refs.  Defaults to the file slug if omitted. */
  id?: string;
  /** Page title.  Required.  Used in nav + browser title. */
  title: string;
  /** One-paragraph summary.  Required.  Drives search + AI
   *  retrieval; should make sense without the body. */
  summary: string;
  /** Hierarchical category for sidebar grouping.  Example:
   *  "map-editing/symbology". */
  category?: string;
  /** Ordinal within the category (lower = earlier).  Sort key for
   *  the sidebar; defaults to 100 when omitted so explicit
   *  entries float to the top. */
  order?: number;
  /** Control ids on the in-portal `data-help="..."` attributes
   *  that link to this page.  When the user clicks one of those
   *  controls with the help drawer open, this page loads. */
  controls?: Array<{ id: string; label?: string }>;
  /** Pages the reader is expected to have read first.  Rendered
   *  inline as a "Prerequisites" callout. */
  prerequisites?: string[];
  /** "basic" | "intermediate" | "advanced" -- shown as a badge
   *  in the header so users know what they're getting into. */
  complexity?: 'basic' | 'intermediate' | 'advanced';
  /** Related pages.  Each entry is either a bare doc id or
   *  `{ id, label }` to override the link text. */
  related?: Array<string | { id: string; label?: string }>;
  /** Free-form tags for filter + search.  No fixed vocabulary. */
  tags?: string[];
}

export interface HelpDoc {
  /** URL slug, with category prefix.  Example:
   *  "map-editing/symbology/scale-classes". */
  slug: string;
  /** Stable id (frontmatter `id` or last path segment). */
  id: string;
  /** Path segments relative to content/help/. */
  pathSegments: string[];
  /** Resolved frontmatter. */
  frontmatter: HelpFrontmatter;
  /** Rendered HTML body.  Safe to drop straight into
   *  dangerouslySetInnerHTML -- the marked instance below is
   *  configured to escape user content. */
  html: string;
  /** Raw markdown body for search indexing + future AI retrieval. */
  raw: string;
  /** Headings extracted from the body for in-page nav + search.
   *  Each entry is `{ depth, text, id }` where id is a kebab-case
   *  anchor matching what marked emits. */
  headings: Array<{ depth: number; text: string; id: string }>;
}

/**
 * Resolve the content/help directory.  Two cases:
 *   - Dev: `next dev` runs from apps/portal-web, so
 *     <cwd>/content/help is correct.
 *   - Prod standalone: the Docker runtime's cwd is /app and the
 *     traced files live at /app/apps/portal-web/content/help (the
 *     tracing root is the repo, the package is apps/portal-web).
 * Try the local path first, fall back to the apps/portal-web
 * subpath.  `existsSync` check keeps both branches working without
 * a build-time mode switch.
 */
function resolveHelpRoot(): string {
  const local = path.join(process.cwd(), 'content', 'help');
  const standalone = path.join(
    process.cwd(),
    'apps',
    'portal-web',
    'content',
    'help',
  );
  // existsSync is sync + cheap; runs once at module load.  We
  // import statSync at top-of-file so the lookup doesn't sneak
  // through to runtime.
  try {
    const fs = require('node:fs') as typeof import('node:fs');
    if (fs.existsSync(local)) return local;
    if (fs.existsSync(standalone)) return standalone;
  } catch {
    /* fall through */
  }
  return local;
}

const HELP_ROOT = resolveHelpRoot();

// Configure marked with stable heading ids so in-page anchors
// stay consistent across builds, and so we can extract the same
// ids from the raw markdown for the TOC.
marked.use({
  gfm: true,
  breaks: false,
});

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function extractHeadings(
  raw: string,
): Array<{ depth: number; text: string; id: string }> {
  const out: Array<{ depth: number; text: string; id: string }> = [];
  // Match ATX-style headings (#, ##, etc.) at line start.  We
  // skip headings inside fenced code blocks by toggling a flag
  // when we see ```.
  const lines = raw.split(/\r?\n/);
  let inCode = false;
  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) {
      const depth = m[1]!.length;
      const text = m[2]!;
      out.push({ depth, text, id: slugify(text) });
    }
  }
  return out;
}

/**
 * Walk `content/help/` recursively, parse every `.md` / `.mdx`
 * file, and return a flat array of HelpDoc.  Called at build /
 * request time from Next.js server components.
 */
export async function loadAllDocs(): Promise<HelpDoc[]> {
  const out: HelpDoc[] = [];
  await walk(HELP_ROOT, [], out);
  // Sort: category alpha, then order asc, then title alpha.  The
  // sidebar consumer can re-sort if it wants a different traversal.
  out.sort((a, b) => {
    const ca = a.frontmatter.category ?? '';
    const cb = b.frontmatter.category ?? '';
    if (ca !== cb) return ca.localeCompare(cb);
    const oa = a.frontmatter.order ?? 100;
    const ob = b.frontmatter.order ?? 100;
    if (oa !== ob) return oa - ob;
    return a.frontmatter.title.localeCompare(b.frontmatter.title);
  });
  return out;
}

async function walk(
  dir: string,
  prefix: string[],
  out: HelpDoc[],
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Directory missing entirely (first run, or no docs yet).
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const st = await stat(full);
    if (st.isDirectory()) {
      await walk(full, [...prefix, entry], out);
      continue;
    }
    if (!/\.mdx?$/i.test(entry)) continue;
    const raw = await readFile(full, 'utf8');
    const parsed = matter(raw);
    const fm = parsed.data as HelpFrontmatter;
    if (!fm.title || !fm.summary) {
      console.warn(
        `[help] skipping ${entry}: missing required frontmatter (title, summary)`,
      );
      continue;
    }
    const baseName = entry.replace(/\.mdx?$/i, '');
    const segments = [...prefix, baseName === 'index' ? '' : baseName].filter(
      (s) => s !== '',
    );
    const slug = segments.join('/');
    const id = fm.id ?? baseName;
    const html = await marked.parse(parsed.content);
    const headings = extractHeadings(parsed.content);
    out.push({
      slug,
      id,
      pathSegments: segments,
      frontmatter: fm,
      html,
      raw: parsed.content,
      headings,
    });
  }
}

/** Look up one doc by its slug array (from a Next.js catch-all
 *  route's `params.slug`).  Empty array = the help landing page. */
export async function loadDocBySlug(
  slug: string[] | undefined,
): Promise<HelpDoc | null> {
  const docs = await loadAllDocs();
  const target = (slug ?? []).join('/');
  return docs.find((d) => d.slug === target) ?? null;
}

/**
 * Build a slim, JSON-serializable index for the client-side
 * search.  Each entry has just enough to score + render a result
 * snippet; full bodies stay on the server.
 */
export interface HelpSearchEntry {
  id: string;
  slug: string;
  title: string;
  summary: string;
  category: string;
  tags: string[];
  controls: string[];
  /** Lowercased blob of title + summary + headings + tags +
   *  control labels, used as the substring-search haystack. */
  haystack: string;
}

export async function buildSearchIndex(): Promise<HelpSearchEntry[]> {
  const docs = await loadAllDocs();
  return docs.map((d) => {
    const headingsText = d.headings.map((h) => h.text).join(' ');
    const tagsText = (d.frontmatter.tags ?? []).join(' ');
    const controlsText = (d.frontmatter.controls ?? [])
      .map((c) => `${c.id} ${c.label ?? ''}`)
      .join(' ');
    return {
      id: d.id,
      slug: d.slug,
      title: d.frontmatter.title,
      summary: d.frontmatter.summary,
      category: d.frontmatter.category ?? '',
      tags: d.frontmatter.tags ?? [],
      controls: (d.frontmatter.controls ?? []).map((c) => c.id),
      haystack: [
        d.frontmatter.title,
        d.frontmatter.summary,
        headingsText,
        tagsText,
        controlsText,
      ]
        .join(' ')
        .toLowerCase(),
    };
  });
}

/**
 * Reverse index: control id -> doc id (slug).  The portal's
 * help drawer queries this when the user clicks a `data-help`-
 * tagged control so it can open the right page.
 */
export async function buildControlIndex(): Promise<Record<string, string>> {
  const docs = await loadAllDocs();
  const out: Record<string, string> = {};
  for (const d of docs) {
    for (const c of d.frontmatter.controls ?? []) {
      // Don't overwrite -- first doc that claims a control wins.
      // The frontmatter author can switch by removing the binding
      // from the loser.
      if (!out[c.id]) out[c.id] = d.slug;
    }
  }
  return out;
}

/**
 * Build the nav tree used by the sidebar.  Categories collapse
 * naturally because they're slash-separated strings -- "map-
 * editing/symbology/scale-classes" lives under "map-editing" >
 * "symbology" > "Scale classes".
 */
export interface HelpNavNode {
  label: string;
  /** When set, this node is a leaf doc and the user can navigate
   *  to it.  When unset, the node is a category. */
  slug?: string;
  children: HelpNavNode[];
}

export async function buildNav(): Promise<HelpNavNode> {
  const docs = await loadAllDocs();
  const root: HelpNavNode = { label: 'root', children: [] };
  for (const d of docs) {
    const cat = d.frontmatter.category ?? '';
    const parts = cat ? cat.split('/').filter(Boolean) : [];
    let cursor = root;
    for (const part of parts) {
      // Compare against the pretty label since that's what we
      // store on the node.  Earlier I compared against the raw
      // `part` and pushed the pretty form, so the lookup never
      // matched and a fresh category node spawned per doc --
      // sidebar showed "Getting Started" three times with one
      // child each.
      const pretty = prettyLabel(part);
      let next = cursor.children.find(
        (c) => c.label === pretty && !c.slug,
      );
      if (!next) {
        next = { label: pretty, children: [] };
        cursor.children.push(next);
      }
      cursor = next;
    }
    cursor.children.push({
      label: d.frontmatter.title,
      slug: d.slug,
      children: [],
    });
  }
  return root;
}

function prettyLabel(rawSegment: string): string {
  return rawSegment
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
