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
