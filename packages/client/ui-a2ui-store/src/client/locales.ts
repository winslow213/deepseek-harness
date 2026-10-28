/** `a2uiStore` namespace dictionaries for the saved-tools sidebar panel. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'a2uiStore'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'entry.title': 'A2UI 工具',
  'entry.hint': '打开本地保存的工具页面',
  'panel.title': 'A2UI 工具',
  'panel.close': '关闭',
  'panel.empty': '暂无已保存的工具',
  'panel.loading': '加载中…',
  'panel.loadError': '加载失败，请重试',
  'panel.needSession': '请先打开一个会话',
  'panel.openError': '打开失败，请重试',
  'panel.import': '导入',
  'panel.importPlaceholder': '粘贴分享令牌导入…',
  'panel.importError': '导入失败，请检查令牌',
  'panel.shareError': '复制分享令牌失败，请重试',
  'panel.shared': '已复制 {name} 的分享令牌',
  'row.remove': '删除',
  'row.share': '分享',
} satisfies Record<string, string>

/** English dictionary (same key set). */
export const en: Record<A2uiStoreKey, string> = {
  'entry.title': 'A2UI tools',
  'entry.hint': 'Open a locally saved tool page',
  'panel.title': 'A2UI tools',
  'panel.close': 'Close',
  'panel.empty': 'No saved tools yet',
  'panel.loading': 'Loading…',
  'panel.loadError': 'Could not load tools, please retry',
  'panel.needSession': 'Open a session first',
  'panel.openError': 'Could not open, please retry',
  'panel.import': 'Import',
  'panel.importPlaceholder': 'Paste a share token to import…',
  'panel.importError': 'Could not import, check the token',
  'panel.shareError': 'Could not copy the share token, please retry',
  'panel.shared': 'Copied the share token for {name}',
  'row.remove': 'Remove',
  'row.share': 'Share',
}

/** Union of this namespace's dictionary keys. */
export type A2uiStoreKey = keyof typeof zh

/** Japanese dictionary (same key set). */
export const ja: Record<A2uiStoreKey, string> = {
  'entry.title': 'A2UI ツール',
  'entry.hint': 'ローカルに保存したツールのページを開く',
  'panel.title': 'A2UI ツール',
  'panel.close': '閉じる',
  'panel.empty': '保存されたツールはまだありません',
  'panel.loading': '読み込み中…',
  'panel.loadError': '読み込みに失敗しました。再試行してください',
  'panel.needSession': '先にセッションを開いてください',
  'panel.openError': '開けませんでした。再試行してください',
  'panel.import': 'インポート',
  'panel.importPlaceholder': '共有トークンを貼り付けてインポート…',
  'panel.importError': 'インポートに失敗しました。トークンを確認してください',
  'panel.shareError': '共有トークンをコピーできませんでした。再試行してください',
  'panel.shared': '{name} の共有トークンをコピーしました',
  'row.remove': '削除',
  'row.share': '共有',
}

/** Spanish dictionary (same key set). */
export const es: Record<A2uiStoreKey, string> = {
  'entry.title': 'Herramientas A2UI',
  'entry.hint': 'Abre una página de herramienta guardada localmente',
  'panel.title': 'Herramientas A2UI',
  'panel.close': 'Cerrar',
  'panel.empty': 'Aún no hay herramientas guardadas',
  'panel.loading': 'Cargando…',
  'panel.loadError': 'No se pudieron cargar las herramientas, vuelve a intentarlo',
  'panel.needSession': 'Abre primero una sesión',
  'panel.openError': 'No se pudo abrir, vuelve a intentarlo',
  'panel.import': 'Importar',
  'panel.importPlaceholder': 'Pega un token de uso compartido para importar…',
  'panel.importError': 'No se pudo importar, revisa el token',
  'panel.shareError': 'No se pudo copiar el token de uso compartido, vuelve a intentarlo',
  'panel.shared': 'Se copió el token de uso compartido de {name}',
  'row.remove': 'Eliminar',
  'row.share': 'Compartir',
}

/** French dictionary (same key set). */
export const fr: Record<A2uiStoreKey, string> = {
  'entry.title': 'Outils A2UI',
  'entry.hint': 'Ouvrir une page d’outil enregistrée localement',
  'panel.title': 'Outils A2UI',
  'panel.close': 'Fermer',
  'panel.empty': 'Aucun outil enregistré pour l’instant',
  'panel.loading': 'Chargement…',
  'panel.loadError': 'Impossible de charger les outils, veuillez réessayer',
  'panel.needSession': 'Ouvrez d’abord une session',
  'panel.openError': 'Impossible d’ouvrir, veuillez réessayer',
  'panel.import': 'Importer',
  'panel.importPlaceholder': 'Collez un jeton de partage pour importer…',
  'panel.importError': 'Importation impossible, vérifiez le jeton',
  'panel.shareError': 'Impossible de copier le jeton de partage, veuillez réessayer',
  'panel.shared': 'Jeton de partage de {name} copié',
  'row.remove': 'Supprimer',
  'row.share': 'Partager',
}

/** German dictionary (same key set). */
export const de: Record<A2uiStoreKey, string> = {
  'entry.title': 'A2UI-Werkzeuge',
  'entry.hint': 'Eine lokal gespeicherte Werkzeugseite öffnen',
  'panel.title': 'A2UI-Werkzeuge',
  'panel.close': 'Schließen',
  'panel.empty': 'Noch keine gespeicherten Werkzeuge',
  'panel.loading': 'Wird geladen…',
  'panel.loadError': 'Werkzeuge konnten nicht geladen werden, bitte erneut versuchen',
  'panel.needSession': 'Zuerst eine Sitzung öffnen',
  'panel.openError': 'Öffnen fehlgeschlagen, bitte erneut versuchen',
  'panel.import': 'Importieren',
  'panel.importPlaceholder': 'Freigabe-Token zum Importieren einfügen…',
  'panel.importError': 'Import fehlgeschlagen, Token prüfen',
  'panel.shareError': 'Freigabe-Token konnte nicht kopiert werden, bitte erneut versuchen',
  'panel.shared': 'Freigabe-Token für {name} kopiert',
  'row.remove': 'Entfernen',
  'row.share': 'Teilen',
}

/** Russian dictionary (same key set). */
export const ru: Record<A2uiStoreKey, string> = {
  'entry.title': 'Инструменты A2UI',
  'entry.hint': 'Открыть локально сохранённую страницу инструмента',
  'panel.title': 'Инструменты A2UI',
  'panel.close': 'Закрыть',
  'panel.empty': 'Сохранённых инструментов пока нет',
  'panel.loading': 'Загрузка…',
  'panel.loadError': 'Не удалось загрузить инструменты, повторите попытку',
  'panel.needSession': 'Сначала откройте сессию',
  'panel.openError': 'Не удалось открыть, повторите попытку',
  'panel.import': 'Импорт',
  'panel.importPlaceholder': 'Вставьте токен общего доступа для импорта…',
  'panel.importError': 'Импорт не удался, проверьте токен',
  'panel.shareError': 'Не удалось скопировать токен общего доступа, повторите попытку',
  'panel.shared': 'Токен общего доступа для {name} скопирован',
  'row.remove': 'Удалить',
  'row.share': 'Поделиться',
}

/** Portuguese dictionary (same key set). */
export const pt: Record<A2uiStoreKey, string> = {
  'entry.title': 'Ferramentas A2UI',
  'entry.hint': 'Abrir uma página de ferramenta salva localmente',
  'panel.title': 'Ferramentas A2UI',
  'panel.close': 'Fechar',
  'panel.empty': 'Nenhuma ferramenta salva ainda',
  'panel.loading': 'Carregando…',
  'panel.loadError': 'Não foi possível carregar as ferramentas, tente novamente',
  'panel.needSession': 'Abra uma sessão primeiro',
  'panel.openError': 'Não foi possível abrir, tente novamente',
  'panel.import': 'Importar',
  'panel.importPlaceholder': 'Cole um token de compartilhamento para importar…',
  'panel.importError': 'Não foi possível importar, verifique o token',
  'panel.shareError': 'Não foi possível copiar o token de compartilhamento, tente novamente',
  'panel.shared': 'Token de compartilhamento de {name} copiado',
  'row.remove': 'Remover',
  'row.share': 'Compartilhar',
}
