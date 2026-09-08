/** `a2ui` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'a2ui'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'field.required': '必填',
  'button.submit': '提交',
  'button.submitting': '提交中…',
  'error.required': '请填写必填字段：{name}',
  'error.busy': '当前有消息正在处理，请稍后再提交',
  'action.localDone': '已完成',
  'launcher.open': '在窗口打开',
  'launcher.hint': '在独立窗口中交互',
  'launcher.popupBlocked': '弹窗被浏览器拦截，请允许本站弹窗后重试',
  'hint.submission': '提交后，{surfaceId} 的填写结果会作为一条消息发送给模型。',
  'node.editHint': '双击编辑节点内容',
  'node.labelPlaceholder': '节点标题',
  'node.detailPlaceholder': '自定义内容…',
  'edge.editHint': '双击编辑连线文字',
  'edge.labelPlaceholder': '连线文字',
}

/** English dictionary (same key set). */
export const en: Record<A2uiKey, string> = {
  'field.required': 'Required',
  'button.submit': 'Submit',
  'button.submitting': 'Submitting…',
  'error.required': 'Please fill in the required field: {name}',
  'error.busy': 'A message is being processed; please wait before submitting',
  'action.localDone': 'Done',
  'launcher.open': 'Open in window',
  'launcher.hint': 'Interact in a separate window',
  'launcher.popupBlocked': 'The popup was blocked by the browser; allow popups for this site and retry.',
  'hint.submission': 'Submitting sends the collected values for {surfaceId} to the model as a message.',
  'node.editHint': 'Double-click to edit this node',
  'node.labelPlaceholder': 'Node label',
  'node.detailPlaceholder': 'Custom content…',
  'edge.editHint': 'Double-click to edit this label',
  'edge.labelPlaceholder': 'Edge label',
}

/** Union of this namespace's dictionary keys. */
export type A2uiKey = keyof typeof zh
