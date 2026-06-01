// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #162 Phase 1.1 German seed catalog. Same scope as the Spanish
 * seed: only the keys actively wired into the UI as of Phase 1.1.
 * Missing keys fall back to English.
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
};
