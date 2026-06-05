// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #162 Phase 1: English reference catalog.
 *
 * Single TypeScript object so the build-time type check enforces
 * the shape across every non-English catalog. Phase 1.0 seeds a
 * small initial slice — the most prominent surfaces a brand-new
 * visitor sees first — so the i18n plumbing is demonstrably
 * working without trying to translate every component in one
 * commit. Phase 1.1 ships the multi-week mechanical sweep across
 * the rest of the UI; until then, components that aren't yet
 * wired up just stay in English regardless of the selected
 * locale.
 *
 * Convention: namespace.subsection.key. Each value is plain text
 * or an ICU MessageFormat string. Interpolations use the
 * `{name}` syntax; pluralization uses `{count, plural, one {...}
 * other {...}}`. The runtime helper applies the same shape no
 * matter the locale, so a community translation only needs to
 * replace the values.
 */
export const en = {
  common: {
    save: 'Save',
    cancel: 'Cancel',
    delete: 'Delete',
    close: 'Close',
    edit: 'Edit',
    loading: 'Loading…',
    backToItems: 'Back to items',
    settings: 'Settings',
    language: 'Language',
  },
  nav: {
    items: 'Items',
    home: 'Home',
    admin: 'Admin',
    profile: 'Profile',
    signOut: 'Sign out',
    signIn: 'Sign in',
    overview: 'Overview',
    folders: 'Folders',
    groups: 'Groups',
    recentlyDeleted: 'Recently deleted',
    users: 'Users',
    landingPage: 'Landing page',
    backup: 'Backup',
    housekeeping: 'Housekeeping',
    notifications: 'Notifications',
    fieldQueues: 'Field queues',
    migrations: 'Migrations',
  },
  shell: {
    notificationsLabel: 'Notifications',
    navigation: 'Navigation',
    openNavigation: 'Open navigation',
    closeNavigation: 'Close navigation',
  },
  search: {
    placeholder: 'Search items...',
    label: 'Search items',
  },
  help: {
    buttonTitle: 'Help (press ? anywhere)',
    openLabel: 'Open help',
  },
  newItem: {
    pageTitle: 'Create a new item',
    pageIntro:
      "Pick what you're creating, then fill in the details. For services and uploads, we'll gather what we need on the next screen so the item lands ready to use.",
    createButton: 'Create item',
    backButton: 'Back',
  },
  mapEditor: {
    legendButton: 'Legend',
    tableButton: 'Attribute table',
    markupButton: 'Markup',
    commentsButton: 'Comments',
    printButton: 'Print this map',
    layerAccessButton: 'Layer access',
    saveMapButton: 'Save map',
    savedIndicator: 'Saved',
  },
  presence: {
    youSuffix: ' (you)',
  },
  comments: {
    title: 'Comments',
    showResolved: 'Show resolved',
    startThread: 'Start a new thread...',
    post: 'Post',
    reply: 'Reply...',
    resolve: 'Resolve',
    reopen: 'Reopen',
    threadCount:
      '{count, plural, one {# thread} other {# threads}}',
    noOpen:
      'No open threads. Toggle "Show resolved" to see closed ones.',
    noComments: 'No comments yet. Start the conversation below.',
    signInPrompt: 'Sign in to comment on this map.',
  },
  markup: {
    title: 'Markup',
    add: 'Add markup',
    empty:
      'No markup yet. Add a set, then drop pins to mark up the map.',
    dropPin: 'Drop pin at center',
    signInPrompt: 'Sign in to add markup to this map.',
  },
  print: {
    chooserTitle: 'Print this map',
    startSection: 'Start a new layout',
    startAction:
      'Create a new print layout pre-bound to this map',
    startHint:
      'Opens the print layout designer with this map already wired up to the Map, Legend, Scalebar, and North arrow elements.',
    pickSection: 'Use an existing layout',
    pickEmpty:
      'No print layouts to choose from yet. Use "Create a new print layout" above to make one.',
  },
  errors: {
    generic: 'Something went wrong',
    unauthorized: 'Sign in to continue',
    notFound: 'Not found',
  },
} as const;
