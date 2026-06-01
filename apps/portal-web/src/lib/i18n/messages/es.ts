// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #162 Phase 1.1 Spanish seed catalog.
 *
 * Seeded with the keys actively wired into the UI as of Phase 1.1.
 * Missing keys fall back to the English reference catalog at
 * runtime, so a half-translated locale still produces a usable
 * page; only the wired-up surfaces flip to Spanish today.
 *
 * Community contributions extend this map as the i18n sweep
 * widens. Keep keys in the same nested order as `en.ts` for an
 * easy diff.
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
    backToItems: 'Volver a elementos',
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
};
