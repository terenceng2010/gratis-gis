// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #162 Phase 1.1 French seed catalog. Same scope as the Spanish
 * seed: only the keys actively wired into the UI as of Phase 1.1.
 * Missing keys fall back to English.
 */
import type { CatalogShape } from '../locales';

export const fr: Partial<CatalogShape> = {
  common: {
    save: 'Enregistrer',
    cancel: 'Annuler',
    delete: 'Supprimer',
    close: 'Fermer',
    edit: 'Modifier',
    loading: 'Chargement…',
    backToItems: 'Retour aux éléments',
    settings: 'Paramètres',
    language: 'Langue',
  },
  nav: {
    items: 'Éléments',
    home: 'Accueil',
    admin: 'Administration',
    profile: 'Profil',
    signOut: 'Se déconnecter',
    signIn: 'Se connecter',
  },
  print: {
    chooserTitle: 'Imprimer cette carte',
    startSection: 'Créer une nouvelle mise en page',
    startAction:
      'Créer une nouvelle mise en page d’impression liée à cette carte',
    startHint:
      'Ouvre le concepteur de mise en page avec cette carte déjà connectée aux éléments Carte, Légende, Échelle et Rose des vents.',
    pickSection: 'Utiliser une mise en page existante',
    pickEmpty:
      "Aucune mise en page d'impression pour le moment. Utilisez « Créer une nouvelle mise en page » ci-dessus pour en créer une.",
  },
};
