// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Theme presets for Custom Web App rendering. Each preset is a
 * bundle of CSS-variable token values applied at the app root so
 * every widget inside (containers, content widgets, etc.) renders
 * with a consistent palette / typography / density.
 *
 * Why presets instead of per-token authoring: the "pick a vibe"
 * UX takes a single click and produces a coherent look. Authors
 * who want to override individual tokens can do so via the older
 * CustomAppData.theme block (accent, background); preset tokens
 * are the starting point those overrides apply on top of.
 *
 * The token names are stable wire shapes. New themes add new
 * entries; renaming a theme requires a migration step on any
 * persisted CustomAppData that references it (none ship yet).
 */
import type { AppThemePresetId } from './custom-app';

/**
 * Token values for one theme preset. All values are CSS strings
 * compatible with the `hsl(...)` / `rgb(...)` / `#...` forms.
 * Components inside the app render through Tailwind utility
 * classes that resolve these tokens, so swapping the preset
 * automatically restyles every widget.
 *
 * Tokens grouped:
 *   - Surface ladder: app shell, cards, popovers (with their ink
 *     pairs that always meet AA contrast against their surface).
 *   - Accent: primary actions, focus rings, active states.
 *   - Status: success, warn, danger, info — kept theme-agnostic
 *     enough that all themes use similar hues so a user doesn't
 *     mistake "error" for the brand color.
 *   - Border + muted: chrome / dividers / secondary text.
 *   - Geometry: corner radius + spacing density. Smaller radius
 *     reads as technical / engineering; larger reads as
 *     consumer-friendly.
 */
export interface AppThemeTokens {
  /** Display name shown in the picker UI. */
  label: string;
  /** One-line description shown under the label. */
  description: string;
  /**
   * Hue character for the preset; used by the picker's swatch
   * preview. Format: `hsl(h s% l%)` of the dominant surface.
   */
  swatch: string;
  /** Token values applied via `style.setProperty` at the app root. */
  tokens: {
    /** Page background (between widgets). */
    '--app-surface-0': string;
    /** Elevated card background (widget shells). */
    '--app-surface-1': string;
    /** Input / popover background (one step elevated again). */
    '--app-surface-2': string;
    /** Text color readable on surface-0. */
    '--app-ink-0': string;
    /** Text color readable on surface-1. */
    '--app-ink-1': string;
    /** Muted / secondary text. */
    '--app-muted': string;
    /** Borders + dividers. */
    '--app-border': string;
    /** Primary accent for buttons, focus rings, active states. */
    '--app-accent': string;
    /** Text color readable on accent backgrounds. */
    '--app-accent-ink': string;
    /** Hover state for accent surfaces. */
    '--app-accent-hover': string;
    /** Status colors. */
    '--app-success': string;
    '--app-warn': string;
    '--app-danger': string;
    '--app-info': string;
    /** Corner radius for cards / inputs / buttons. CSS length. */
    '--app-radius': string;
    /** Subtle card shadow. CSS box-shadow value. */
    '--app-shadow-card': string;
    /** Stronger shadow for popovers / overlays. */
    '--app-shadow-overlay': string;
    /** Spacing density. Multiplier on Tailwind spacing units. */
    '--app-density': string;
  };
}

/**
 * Registry of built-in theme presets. Add a new preset by adding
 * an entry here AND adding its id to the AppThemePresetId union
 * in custom-app.ts.
 */
export const APP_THEMES: Record<AppThemePresetId, AppThemeTokens> = {
  default: {
    label: 'Default',
    description: 'Portal-matching neutral palette with the system accent.',
    swatch: 'hsl(210 40% 96%)',
    tokens: {
      '--app-surface-0': 'hsl(0 0% 100%)',
      '--app-surface-1': 'hsl(210 40% 98%)',
      '--app-surface-2': 'hsl(210 40% 96%)',
      '--app-ink-0': 'hsl(222 47% 11%)',
      '--app-ink-1': 'hsl(222 47% 11%)',
      '--app-muted': 'hsl(215 20% 50%)',
      '--app-border': 'hsl(214 32% 91%)',
      '--app-accent': 'hsl(221 83% 53%)',
      '--app-accent-ink': 'hsl(0 0% 100%)',
      '--app-accent-hover': 'hsl(221 83% 47%)',
      '--app-success': 'hsl(142 72% 29%)',
      '--app-warn': 'hsl(35 92% 50%)',
      '--app-danger': 'hsl(0 72% 51%)',
      '--app-info': 'hsl(199 89% 48%)',
      '--app-radius': '0.5rem',
      '--app-shadow-card':
        '0 1px 2px rgba(15, 15, 16, 0.04), 0 1px 1px rgba(15, 15, 16, 0.03)',
      '--app-shadow-overlay':
        '0 10px 40px -10px rgba(15, 15, 16, 0.25), 0 2px 8px -2px rgba(15, 15, 16, 0.08)',
      '--app-density': '1',
    },
  },
  slate: {
    label: 'Slate',
    description: 'Cool gray + indigo accent. Technical, engineering-forward.',
    swatch: 'hsl(217 33% 17%)',
    tokens: {
      '--app-surface-0': 'hsl(220 26% 14%)',
      '--app-surface-1': 'hsl(217 33% 17%)',
      '--app-surface-2': 'hsl(215 28% 22%)',
      '--app-ink-0': 'hsl(213 31% 91%)',
      '--app-ink-1': 'hsl(213 31% 91%)',
      '--app-muted': 'hsl(215 16% 65%)',
      '--app-border': 'hsl(215 28% 28%)',
      '--app-accent': 'hsl(239 84% 67%)',
      '--app-accent-ink': 'hsl(220 26% 14%)',
      '--app-accent-hover': 'hsl(239 84% 73%)',
      '--app-success': 'hsl(142 64% 52%)',
      '--app-warn': 'hsl(35 92% 58%)',
      '--app-danger': 'hsl(0 74% 62%)',
      '--app-info': 'hsl(199 89% 58%)',
      '--app-radius': '0.5rem',
      '--app-shadow-card':
        '0 1px 2px rgba(0, 0, 0, 0.4), 0 1px 1px rgba(0, 0, 0, 0.3)',
      '--app-shadow-overlay':
        '0 10px 40px -10px rgba(0, 0, 0, 0.55), 0 2px 8px -2px rgba(0, 0, 0, 0.35)',
      '--app-density': '1',
    },
  },
  aurora: {
    label: 'Aurora',
    description: 'Off-white surfaces, teal accent, generous spacing.',
    swatch: 'hsl(180 30% 95%)',
    tokens: {
      '--app-surface-0': 'hsl(180 30% 97%)',
      '--app-surface-1': 'hsl(180 30% 99%)',
      '--app-surface-2': 'hsl(180 25% 94%)',
      '--app-ink-0': 'hsl(195 60% 11%)',
      '--app-ink-1': 'hsl(195 60% 18%)',
      '--app-muted': 'hsl(195 15% 45%)',
      '--app-border': 'hsl(180 20% 86%)',
      '--app-accent': 'hsl(173 80% 36%)',
      '--app-accent-ink': 'hsl(0 0% 100%)',
      '--app-accent-hover': 'hsl(173 80% 30%)',
      '--app-success': 'hsl(151 65% 32%)',
      '--app-warn': 'hsl(35 92% 50%)',
      '--app-danger': 'hsl(0 72% 51%)',
      '--app-info': 'hsl(199 89% 48%)',
      '--app-radius': '0.75rem',
      '--app-shadow-card':
        '0 2px 4px rgba(15, 60, 60, 0.06), 0 1px 2px rgba(15, 60, 60, 0.04)',
      '--app-shadow-overlay':
        '0 16px 48px -12px rgba(15, 60, 60, 0.28), 0 4px 12px -4px rgba(15, 60, 60, 0.12)',
      '--app-density': '1.1',
    },
  },
  forest: {
    label: 'Forest',
    description: 'Warm cream surfaces, forest green accent. Field-ready.',
    swatch: 'hsl(45 33% 95%)',
    tokens: {
      '--app-surface-0': 'hsl(45 33% 97%)',
      '--app-surface-1': 'hsl(45 33% 99%)',
      '--app-surface-2': 'hsl(45 25% 93%)',
      '--app-ink-0': 'hsl(150 40% 12%)',
      '--app-ink-1': 'hsl(150 40% 18%)',
      '--app-muted': 'hsl(30 10% 45%)',
      '--app-border': 'hsl(45 20% 85%)',
      '--app-accent': 'hsl(150 55% 32%)',
      '--app-accent-ink': 'hsl(45 33% 97%)',
      '--app-accent-hover': 'hsl(150 55% 26%)',
      '--app-success': 'hsl(142 72% 29%)',
      '--app-warn': 'hsl(35 92% 50%)',
      '--app-danger': 'hsl(0 72% 51%)',
      '--app-info': 'hsl(199 89% 48%)',
      '--app-radius': '0.375rem',
      '--app-shadow-card':
        '0 1px 2px rgba(60, 30, 0, 0.06), 0 1px 1px rgba(60, 30, 0, 0.04)',
      '--app-shadow-overlay':
        '0 10px 40px -10px rgba(60, 30, 0, 0.22), 0 2px 8px -2px rgba(60, 30, 0, 0.1)',
      '--app-density': '1',
    },
  },
  paper: {
    label: 'Paper',
    description: 'High-contrast print-style palette. Reports, public maps.',
    swatch: 'hsl(0 0% 99%)',
    tokens: {
      '--app-surface-0': 'hsl(0 0% 100%)',
      '--app-surface-1': 'hsl(0 0% 99%)',
      '--app-surface-2': 'hsl(0 0% 96%)',
      '--app-ink-0': 'hsl(0 0% 7%)',
      '--app-ink-1': 'hsl(0 0% 15%)',
      '--app-muted': 'hsl(0 0% 40%)',
      '--app-border': 'hsl(0 0% 86%)',
      '--app-accent': 'hsl(0 0% 7%)',
      '--app-accent-ink': 'hsl(0 0% 100%)',
      '--app-accent-hover': 'hsl(0 0% 20%)',
      '--app-success': 'hsl(142 72% 29%)',
      '--app-warn': 'hsl(35 92% 50%)',
      '--app-danger': 'hsl(0 72% 51%)',
      '--app-info': 'hsl(199 89% 48%)',
      '--app-radius': '0.25rem',
      '--app-shadow-card': 'none',
      '--app-shadow-overlay':
        '0 4px 16px -4px rgba(0, 0, 0, 0.18), 0 1px 4px -1px rgba(0, 0, 0, 0.1)',
      '--app-density': '0.95',
    },
  },
};

/**
 * Resolve a preset id to its token bundle. Falls back to 'default'
 * for any unknown id so a future deprecation of a theme name
 * doesn't break older saved apps.
 */
export function resolveAppTheme(id: AppThemePresetId | undefined): AppThemeTokens {
  if (id && APP_THEMES[id]) return APP_THEMES[id];
  return APP_THEMES.default;
}

/**
 * Minimal DOM surface this module touches. The shared-types package
 * doesn't pull in `lib.dom.d.ts` (it's consumed by both node-side
 * and browser-side code), so we declare the parts we need locally.
 * Any real HTMLElement satisfies this shape.
 */
interface CSSVariableSetter {
  style: { setProperty: (key: string, value: string) => void };
}

/**
 * Apply a theme's tokens to a DOM element by setting CSS custom
 * properties. Mount this on the app's root container in both the
 * designer preview and the runtime so widgets restyle live as the
 * author swaps presets.
 */
export function applyAppTheme(
  el: CSSVariableSetter,
  id: AppThemePresetId | undefined,
): void {
  const theme = resolveAppTheme(id);
  for (const [key, value] of Object.entries(theme.tokens)) {
    el.style.setProperty(key, value);
  }
}
