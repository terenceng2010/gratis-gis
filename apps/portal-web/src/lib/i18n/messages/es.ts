// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #162 Phase 1.1 Spanish catalog.
 *
 * Machine-translated seed (initial pass 2026-06-01). Native
 * speakers: please review and refine. Open a pull request with
 * fixes; the locale picker tags this locale "MT" until a native
 * speaker has signed off. See CONTRIBUTING-TRANSLATIONS.md.
 *
 * Conventions: neutral pan-Hispanic Spanish (avoids strongly
 * regional variants). Formality: tuteo by default to match the
 * casual tone of the source English ("Sign in," not "Please sign
 * in"). For Spain-specific or LATAM-specific refinements, open a
 * separate locale (e.g. `es-ES`, `es-MX`) rather than diverging
 * this catalog.
 */
import type { CatalogShape } from '../locales';

export const es: Partial<CatalogShape> = {
  common: {
    save: 'Guardar',
    cancel: 'Cancelar',
    delete: 'Eliminar',
    close: 'Cerrar',
    edit: 'Editar',
    loading: 'Cargando…',
    backToItems: 'Volver a los elementos',
    settings: 'Configuración',
    language: 'Idioma',
  },
  nav: {
    items: 'Elementos',
    home: 'Inicio',
    admin: 'Administración',
    profile: 'Perfil',
    signOut: 'Cerrar sesión',
    signIn: 'Iniciar sesión',
    overview: 'Resumen',
    folders: 'Carpetas',
    groups: 'Grupos',
    recentlyDeleted: 'Eliminados recientemente',
    users: 'Usuarios',
    landingPage: 'Página de inicio',
    backup: 'Copia de seguridad',
    housekeeping: 'Mantenimiento',
    notifications: 'Notificaciones',
    fieldQueues: 'Colas de campo',
    migrations: 'Migraciones',
  },
  shell: {
    notificationsLabel: 'Notificaciones',
    navigation: 'Navegación',
    openNavigation: 'Abrir navegación',
    closeNavigation: 'Cerrar navegación',
  },
  search: {
    placeholder: 'Buscar elementos...',
    label: 'Buscar elementos',
  },
  help: {
    buttonTitle: 'Ayuda (pulsa ? en cualquier momento)',
    openLabel: 'Abrir ayuda',
  },
  newItem: {
    pageTitle: 'Crear un nuevo elemento',
    pageIntro:
      'Elige lo que vas a crear y luego completa los detalles. Para servicios y archivos subidos, recopilaremos lo necesario en la siguiente pantalla para que el elemento quede listo para usar.',
    createButton: 'Crear elemento',
    backButton: 'Atrás',
  },
  mapEditor: {
    legendButton: 'Leyenda',
    tableButton: 'Tabla de atributos',
    markupButton: 'Anotaciones',
    commentsButton: 'Comentarios',
    printButton: 'Imprimir este mapa',
    layerAccessButton: 'Acceso a las capas',
    saveMapButton: 'Guardar mapa',
    savedIndicator: 'Guardado',
  },
  presence: {
    youSuffix: ' (tú)',
  },
  comments: {
    title: 'Comentarios',
    showResolved: 'Mostrar resueltos',
    startThread: 'Iniciar un nuevo hilo...',
    post: 'Publicar',
    reply: 'Responder...',
    resolve: 'Resolver',
    reopen: 'Reabrir',
    threadCount: '{count, plural, one {# hilo} other {# hilos}}',
    noOpen:
      'No hay hilos abiertos. Activa "Mostrar resueltos" para ver los cerrados.',
    noComments:
      'Aún no hay comentarios. Inicia la conversación a continuación.',
    signInPrompt: 'Inicia sesión para comentar en este mapa.',
  },
  markup: {
    title: 'Anotaciones',
    add: 'Añadir anotación',
    empty:
      'Aún no hay anotaciones. Añade un conjunto y luego coloca chinchetas para anotar el mapa.',
    dropPin: 'Colocar chincheta en el centro',
    signInPrompt: 'Inicia sesión para añadir anotaciones a este mapa.',
  },
  print: {
    chooserTitle: 'Imprimir este mapa',
    startSection: 'Crear un nuevo diseño',
    startAction:
      'Crear un nuevo diseño de impresión vinculado a este mapa',
    startHint:
      'Abre el diseñador de impresión con este mapa ya conectado a los elementos de Mapa, Leyenda, Escala y Flecha de norte.',
    pickSection: 'Usar un diseño existente',
    pickEmpty:
      'Aún no hay diseños de impresión disponibles. Usa "Crear un nuevo diseño de impresión" arriba para crear uno.',
  },
  errors: {
    generic: 'Algo salió mal',
    unauthorized: 'Inicia sesión para continuar',
    notFound: 'No encontrado',
  },
};
