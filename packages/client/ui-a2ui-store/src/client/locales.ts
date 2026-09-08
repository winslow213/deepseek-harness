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
  'panel.loadError': '加载失败，请重试',
  'panel.needSession': '请先打开一个会话',
  'panel.openError': '打开失败，请重试',
  'row.remove': '删除',
} satisfies Record<string, string>

/** English dictionary (same key set). */
export const en: Record<A2uiStoreKey, string> = {
  'entry.title': 'A2UI tools',
  'entry.hint': 'Open a locally saved tool page',
  'panel.title': 'A2UI tools',
  'panel.close': 'Close',
  'panel.empty': 'No saved tools yet',
  'panel.loadError': 'Could not load tools, please retry',
  'panel.needSession': 'Open a session first',
  'panel.openError': 'Could not open, please retry',
  'row.remove': 'Remove',
}

/** Union of this namespace's dictionary keys. */
export type A2uiStoreKey = keyof typeof zh
