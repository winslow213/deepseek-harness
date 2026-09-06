/** `settings.teamAccount` namespace dictionaries (Sign out + Pairing code rows). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'title': '退出登录',
  'hint': '退出后需重新登录才能继续使用',
  'pairTitle': '生成配对码',
  'pairHint': '把本机目录挂载到你的工作区',
  'pairError': '生成配对码失败，请重试',
  'pairExpiry': '有效期至 {time}',
  'pairMulti': '一个码可挂载多台设备',
  'pairCodeLabel': '配对码',
  'pairCommandLabel': '在目标主机运行',
  'pairCommand': 'dsh-shell remote agent --pair {code} --hub {host}:7101 --root <dir> [--allow-command ...]',
  'copy': '复制',
} satisfies Record<string, string>

/** The settings.teamAccount namespace key union. */
export type TeamAccountLocaleKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'title': 'Sign out',
  'hint': 'You will need to sign in again to continue',
  'pairTitle': 'Pairing code',
  'pairHint': 'Mount a local directory into your workspace',
  'pairError': 'Could not mint a pairing code, please retry',
  'pairExpiry': 'Valid until {time}',
  'pairMulti': 'One code mounts multiple devices',
  'pairCodeLabel': 'Pairing code',
  'pairCommandLabel': 'Run on the target host',
  'pairCommand': 'dsh-shell remote agent --pair {code} --hub {host}:7101 --root <dir> [--allow-command ...]',
  'copy': 'Copy',
} satisfies Record<TeamAccountLocaleKey, string>
