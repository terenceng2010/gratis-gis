// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Minimal className joiner. We intentionally don't pull in clsx/tailwind-merge
 * from this package to keep the peer-dep surface small; apps can use their
 * own utility if they need conflict resolution.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
