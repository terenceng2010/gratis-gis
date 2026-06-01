// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #162 Phase 1.1 German catalog.
 *
 * Machine-translated seed (initial pass 2026-06-01). Native
 * speakers: please review and refine. Open a pull request with
 * fixes; the locale picker tags this locale "MT" until a native
 * speaker has signed off. See CONTRIBUTING-TRANSLATIONS.md.
 *
 * Conventions: standard German (Bundesdeutsch). Formal "Sie" for
 * user-addressing (matches the convention of professional GIS
 * software in German-speaking markets). Single-word button labels
 * use the infinitive ("Speichern," not "Speichere").
 */
import type { CatalogShape } from '../locales';

export const de: Partial<CatalogShape> = {
  common: {
    save: 'Speichern',
    cancel: 'Abbrechen',
    delete: 'Löschen',
    close: 'Schließen',
    edit: 'Bearbeiten',
    loading: 'Wird geladen…',
    backToItems: 'Zurück zu Elementen',
    settings: 'Einstellungen',
    language: 'Sprache',
  },
  nav: {
    items: 'Elemente',
    home: 'Startseite',
    admin: 'Verwaltung',
    profile: 'Profil',
    signOut: 'Abmelden',
    signIn: 'Anmelden',
  },
  newItem: {
    pageTitle: 'Neues Element erstellen',
    pageIntro:
      'Wählen Sie aus, was Sie erstellen, und füllen Sie dann die Details aus. Für Dienste und Uploads sammeln wir auf dem nächsten Bildschirm, was wir benötigen, damit das Element einsatzbereit ist.',
    createButton: 'Element erstellen',
    backButton: 'Zurück',
  },
  mapEditor: {
    legendButton: 'Legende',
    tableButton: 'Attributtabelle',
    markupButton: 'Markierungen',
    commentsButton: 'Kommentare',
    printButton: 'Diese Karte drucken',
    layerAccessButton: 'Ebenenzugriff',
    saveMapButton: 'Karte speichern',
    savedIndicator: 'Gespeichert',
  },
  presence: {
    youSuffix: ' (Sie)',
  },
  comments: {
    title: 'Kommentare',
    showResolved: 'Gelöste anzeigen',
    startThread: 'Neuen Thread starten...',
    post: 'Veröffentlichen',
    reply: 'Antworten...',
    resolve: 'Lösen',
    reopen: 'Wieder öffnen',
    threadCount: '{count, plural, one {# Thread} other {# Threads}}',
    noOpen:
      'Keine offenen Threads. Aktivieren Sie „Gelöste anzeigen", um geschlossene zu sehen.',
    noComments:
      'Noch keine Kommentare. Starten Sie die Unterhaltung unten.',
    signInPrompt: 'Melden Sie sich an, um diese Karte zu kommentieren.',
  },
  markup: {
    title: 'Markierungen',
    add: 'Markierung hinzufügen',
    empty:
      'Noch keine Markierungen. Fügen Sie einen Satz hinzu und setzen Sie dann Pins, um die Karte zu markieren.',
    dropPin: 'Pin in der Mitte setzen',
    signInPrompt:
      'Melden Sie sich an, um Markierungen zu dieser Karte hinzuzufügen.',
  },
  print: {
    chooserTitle: 'Diese Karte drucken',
    startSection: 'Neues Layout erstellen',
    startAction:
      'Neues Drucklayout erstellen, das mit dieser Karte verknüpft ist',
    startHint:
      'Öffnet den Drucklayout-Designer, in dem diese Karte bereits mit den Elementen Karte, Legende, Maßstab und Nordpfeil verbunden ist.',
    pickSection: 'Vorhandenes Layout verwenden',
    pickEmpty:
      'Noch keine Drucklayouts verfügbar. Verwenden Sie oben „Neues Layout erstellen", um eins zu erstellen.',
  },
  errors: {
    generic: 'Etwas ist schiefgelaufen',
    unauthorized: 'Melden Sie sich an, um fortzufahren',
    notFound: 'Nicht gefunden',
  },
};
