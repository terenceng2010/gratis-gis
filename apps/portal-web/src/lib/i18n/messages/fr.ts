// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #162 Phase 1.1 French catalog.
 *
 * Machine-translated seed (initial pass 2026-06-01). Native
 * speakers: please review and refine. Open a pull request with
 * fixes; the locale picker tags this locale "MT" until a native
 * speaker has signed off. See CONTRIBUTING-TRANSLATIONS.md.
 *
 * Conventions: standard metropolitan French. Formal "vous" for
 * direct user-addressing (matches the formality typical in pro
 * GIS tools); imperative form for buttons ("Enregistrer," not
 * "Enregistrez").
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
    overview: "Vue d'ensemble",
    folders: 'Dossiers',
    groups: 'Groupes',
    recentlyDeleted: 'Récemment supprimés',
    users: 'Utilisateurs',
    landingPage: "Page d'accueil",
    backup: 'Sauvegarde',
    housekeeping: 'Maintenance',
    notifications: 'Notifications',
    fieldQueues: 'Files de terrain',
    migrations: 'Migrations',
  },
  shell: {
    notificationsLabel: 'Notifications',
    navigation: 'Navigation',
    openNavigation: 'Ouvrir la navigation',
    closeNavigation: 'Fermer la navigation',
  },
  search: {
    placeholder: 'Rechercher des éléments...',
    label: 'Rechercher des éléments',
  },
  help: {
    buttonTitle: 'Aide (appuyez sur ? à tout moment)',
    openLabel: "Ouvrir l'aide",
  },
  newItem: {
    pageTitle: 'Créer un nouvel élément',
    pageIntro:
      "Choisissez ce que vous créez, puis remplissez les détails. Pour les services et les fichiers téléversés, nous rassemblerons les informations nécessaires sur l'écran suivant pour que l'élément soit prêt à l'emploi.",
    createButton: "Créer l'élément",
    backButton: 'Retour',
  },
  mapEditor: {
    legendButton: 'Légende',
    tableButton: 'Table attributaire',
    markupButton: 'Annotations',
    commentsButton: 'Commentaires',
    printButton: 'Imprimer cette carte',
    layerAccessButton: 'Accès aux couches',
    saveMapButton: 'Enregistrer la carte',
    savedIndicator: 'Enregistré',
  },
  presence: {
    youSuffix: ' (vous)',
  },
  comments: {
    title: 'Commentaires',
    showResolved: 'Afficher les résolus',
    startThread: 'Démarrer un nouveau fil...',
    post: 'Publier',
    reply: 'Répondre...',
    resolve: 'Résoudre',
    reopen: 'Rouvrir',
    threadCount: '{count, plural, one {# fil} other {# fils}}',
    noOpen:
      "Aucun fil ouvert. Activez « Afficher les résolus » pour voir les fils fermés.",
    noComments:
      'Aucun commentaire pour le moment. Démarrez la conversation ci-dessous.',
    signInPrompt: 'Connectez-vous pour commenter cette carte.',
  },
  markup: {
    title: 'Annotations',
    add: 'Ajouter une annotation',
    empty:
      'Aucune annotation pour le moment. Ajoutez un ensemble, puis déposez des épingles pour annoter la carte.',
    dropPin: 'Déposer une épingle au centre',
    signInPrompt: 'Connectez-vous pour ajouter des annotations à cette carte.',
  },
  print: {
    chooserTitle: 'Imprimer cette carte',
    startSection: 'Créer une nouvelle mise en page',
    startAction:
      "Créer une nouvelle mise en page d'impression liée à cette carte",
    startHint:
      'Ouvre le concepteur de mise en page avec cette carte déjà connectée aux éléments Carte, Légende, Échelle et Rose des vents.',
    pickSection: 'Utiliser une mise en page existante',
    pickEmpty:
      "Aucune mise en page d'impression pour le moment. Utilisez « Créer une nouvelle mise en page » ci-dessus pour en créer une.",
  },
  errors: {
    generic: 'Une erreur est survenue',
    unauthorized: 'Connectez-vous pour continuer',
    notFound: 'Introuvable',
  },
};
