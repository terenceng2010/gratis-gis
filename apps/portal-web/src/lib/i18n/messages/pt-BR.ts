// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #162 Phase 1.1 Brazilian Portuguese seed catalog. Same scope as
 * the Spanish seed: only the keys actively wired into the UI as of
 * Phase 1.1. Missing keys fall back to English.
 */
import type { CatalogShape } from '../locales';

export const ptBR: Partial<CatalogShape> = {
  common: {
    save: 'Salvar',
    cancel: 'Cancelar',
    delete: 'Excluir',
    close: 'Fechar',
    edit: 'Editar',
    loading: 'Carregando…',
    backToItems: 'Voltar aos itens',
    settings: 'Configurações',
    language: 'Idioma',
  },
  nav: {
    items: 'Itens',
    home: 'Início',
    admin: 'Administração',
    profile: 'Perfil',
    signOut: 'Sair',
    signIn: 'Entrar',
  },
  print: {
    chooserTitle: 'Imprimir este mapa',
    startSection: 'Criar um novo layout',
    startAction:
      'Criar um novo layout de impressão vinculado a este mapa',
    startHint:
      'Abre o designer de layout de impressão com este mapa já conectado aos elementos Mapa, Legenda, Escala e Seta de norte.',
    pickSection: 'Usar um layout existente',
    pickEmpty:
      'Ainda não há layouts de impressão disponíveis. Use "Criar um novo layout" acima para criar um.',
  },
};
