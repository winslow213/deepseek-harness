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
  'hint.submission': '提交后，{surfaceId} 的填写结果会作为一条消息发送给模型。',
}

/** English dictionary (same key set). */
export const en: Record<A2uiKey, string> = {
  'field.required': 'Required',
  'button.submit': 'Submit',
  'button.submitting': 'Submitting…',
  'error.required': 'Please fill in the required field: {name}',
  'error.busy': 'A message is being processed; please wait before submitting',
  'hint.submission': 'Submitting sends the collected values for {surfaceId} to the model as a message.',
}

/** Union of this namespace's dictionary keys. */
export type A2uiKey = keyof typeof zh
