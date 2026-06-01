// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * #162 Phase 1.1 Brazilian Portuguese catalog.
 *
 * Machine-translated seed (initial pass 2026-06-01). Native
 * speakers: please review and refine. Open a pull request with
 * fixes; the locale picker tags this locale "MT" until a native
 * speaker has signed off. See CONTRIBUTING-TRANSLATIONS.md.
 *
 * Conventions: Brazilian Portuguese (not European). Casual second
 * person ("você") to match the source English's friendly tone.
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
  newItem: {
    pageTitle: 'Criar um novo item',
    pageIntro:
      'Escolha o que você está criando e preencha os detalhes. Para serviços e uploads, vamos coletar o necessário na próxima tela para que o item fique pronto para uso.',
    createButton: 'Criar item',
    backButton: 'Voltar',
  },
  mapEditor: {
    legendButton: 'Legenda',
    tableButton: 'Tabela de atributos',
    markupButton: 'Anotações',
    commentsButton: 'Comentários',
    printButton: 'Imprimir este mapa',
    layerAccessButton: 'Acesso às camadas',
    saveMapButton: 'Salvar mapa',
    savedIndicator: 'Salvo',
  },
  presence: {
    youSuffix: ' (você)',
  },
  comments: {
    title: 'Comentários',
    showResolved: 'Mostrar resolvidos',
    startThread: 'Iniciar um novo tópico...',
    post: 'Publicar',
    reply: 'Responder...',
    resolve: 'Resolver',
    reopen: 'Reabrir',
    threadCount: '{count, plural, one {# tópico} other {# tópicos}}',
    noOpen:
      'Nenhum tópico aberto. Ative "Mostrar resolvidos" para ver os fechados.',
    noComments:
      'Ainda sem comentários. Inicie a conversa abaixo.',
    signInPrompt: 'Entre para comentar neste mapa.',
  },
  markup: {
    title: 'Anotações',
    add: 'Adicionar anotação',
    empty:
      'Sem anotações ainda. Adicione um conjunto e então coloque marcadores para anotar o mapa.',
    dropPin: 'Colocar marcador no centro',
    signInPrompt: 'Entre para adicionar anotações neste mapa.',
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
  errors: {
    generic: 'Algo deu errado',
    unauthorized: 'Entre para continuar',
    notFound: 'Não encontrado',
  },
};
