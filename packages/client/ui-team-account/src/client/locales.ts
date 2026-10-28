/** `settings.teamAccount` namespace dictionaries (Sign out, Pairing code, Keep-instance-running, and Message Center rows). */

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
  'idleExemptTitle': '保持实例常驻',
  'idleExemptHint': '开启后长时间不活跃也不会被自动回收',
  'idleExemptError': '设置失败，请重试',
  'messageCenterTitle': '消息中心',
  'messageCenterHint': '和团队成员互发站内信与任务',
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
  'idleExemptTitle': 'Keep instance running',
  'idleExemptHint': 'When on, your instance stays up even if idle for a long time',
  'idleExemptError': 'Could not update the setting, please retry',
  'messageCenterTitle': 'Message Center',
  'messageCenterHint': 'Send messages and tasks to your teammates',
} satisfies Record<TeamAccountLocaleKey, string>

/** Japanese dictionary, checked complete against the zh key set. */
export const ja = {
  'title': 'ログアウト',
  'hint': '続けて使用するには再度ログインが必要です',
  'pairTitle': 'ペアリングコード',
  'pairHint': 'ローカルディレクトリをワークスペースにマウントします',
  'pairError': 'ペアリングコードを発行できませんでした。再試行してください',
  'pairExpiry': '有効期限 {time}',
  'pairMulti': '1 つのコードで複数のデバイスをマウントできます',
  'pairCodeLabel': 'ペアリングコード',
  'pairCommandLabel': '対象ホストで実行',
  'pairCommand': 'dsh-shell remote agent --pair {code} --hub {host}:7101 --root <dir> [--allow-command ...]',
  'copy': 'コピー',
  'idleExemptTitle': 'インスタンスを常時起動',
  'idleExemptHint': 'オンの場合、長期間操作がなくても自動回収されません',
  'idleExemptError': '設定を更新できませんでした。再試行してください',
  'messageCenterTitle': 'メッセージセンター',
  'messageCenterHint': 'チームメンバーとメッセージやタスクをやり取りします',
} satisfies Record<TeamAccountLocaleKey, string>

/** Spanish dictionary, checked complete against the zh key set. */
export const es = {
  'title': 'Cerrar sesión',
  'hint': 'Tendrás que iniciar sesión de nuevo para continuar',
  'pairTitle': 'Código de emparejamiento',
  'pairHint': 'Monta un directorio local en tu espacio de trabajo',
  'pairError': 'No se pudo generar el código de emparejamiento, vuelve a intentarlo',
  'pairExpiry': 'Válido hasta {time}',
  'pairMulti': 'Un código monta varios dispositivos',
  'pairCodeLabel': 'Código de emparejamiento',
  'pairCommandLabel': 'Ejecutar en el host de destino',
  'pairCommand': 'dsh-shell remote agent --pair {code} --hub {host}:7101 --root <dir> [--allow-command ...]',
  'copy': 'Copiar',
  'idleExemptTitle': 'Mantener la instancia en ejecución',
  'idleExemptHint': 'Con esto activado, tu instancia sigue activa aunque esté inactiva mucho tiempo',
  'idleExemptError': 'No se pudo actualizar el ajuste, vuelve a intentarlo',
  'messageCenterTitle': 'Centro de mensajes',
  'messageCenterHint': 'Envía mensajes y tareas a tus compañeros de equipo',
} satisfies Record<TeamAccountLocaleKey, string>

/** French dictionary, checked complete against the zh key set. */
export const fr = {
  'title': 'Se déconnecter',
  'hint': 'Vous devrez vous reconnecter pour continuer',
  'pairTitle': 'Code d’appairage',
  'pairHint': 'Montez un répertoire local dans votre espace de travail',
  'pairError': 'Impossible de générer un code d’appairage, veuillez réessayer',
  'pairExpiry': 'Valable jusqu’au {time}',
  'pairMulti': 'Un code monte plusieurs appareils',
  'pairCodeLabel': 'Code d’appairage',
  'pairCommandLabel': 'Exécuter sur l’hôte cible',
  'pairCommand': 'dsh-shell remote agent --pair {code} --hub {host}:7101 --root <dir> [--allow-command ...]',
  'copy': 'Copier',
  'idleExemptTitle': 'Garder l’instance active',
  'idleExemptHint': 'Activé, votre instance reste en marche même après une longue inactivité',
  'idleExemptError': 'Impossible de mettre à jour le réglage, veuillez réessayer',
  'messageCenterTitle': 'Centre de messages',
  'messageCenterHint': 'Envoyez des messages et des tâches à vos coéquipiers',
} satisfies Record<TeamAccountLocaleKey, string>

/** German dictionary, checked complete against the zh key set. */
export const de = {
  'title': 'Abmelden',
  'hint': 'Sie müssen sich erneut anmelden, um fortzufahren',
  'pairTitle': 'Kopplungscode',
  'pairHint': 'Binden Sie ein lokales Verzeichnis in Ihren Arbeitsbereich ein',
  'pairError': 'Kopplungscode konnte nicht erzeugt werden, bitte erneut versuchen',
  'pairExpiry': 'Gültig bis {time}',
  'pairMulti': 'Ein Code bindet mehrere Geräte ein',
  'pairCodeLabel': 'Kopplungscode',
  'pairCommandLabel': 'Auf dem Zielhost ausführen',
  'pairCommand': 'dsh-shell remote agent --pair {code} --hub {host}:7101 --root <dir> [--allow-command ...]',
  'copy': 'Kopieren',
  'idleExemptTitle': 'Instanz dauerhaft laufen lassen',
  'idleExemptHint': 'Wenn aktiv, bleibt Ihre Instanz auch nach langer Inaktivität bestehen',
  'idleExemptError': 'Einstellung konnte nicht aktualisiert werden, bitte erneut versuchen',
  'messageCenterTitle': 'Nachrichtenzentrale',
  'messageCenterHint': 'Senden Sie Nachrichten und Aufgaben an Ihr Team',
} satisfies Record<TeamAccountLocaleKey, string>

/** Russian dictionary, checked complete against the zh key set. */
export const ru = {
  'title': 'Выйти',
  'hint': 'Чтобы продолжить, потребуется войти снова',
  'pairTitle': 'Код привязки',
  'pairHint': 'Смонтируйте локальный каталог в своё рабочее пространство',
  'pairError': 'Не удалось создать код привязки, повторите попытку',
  'pairExpiry': 'Действует до {time}',
  'pairMulti': 'Один код монтирует несколько устройств',
  'pairCodeLabel': 'Код привязки',
  'pairCommandLabel': 'Выполнить на целевом хосте',
  'pairCommand': 'dsh-shell remote agent --pair {code} --hub {host}:7101 --root <dir> [--allow-command ...]',
  'copy': 'Копировать',
  'idleExemptTitle': 'Держать экземпляр запущенным',
  'idleExemptHint': 'Если включено, экземпляр не освобождается даже после долгого простоя',
  'idleExemptError': 'Не удалось обновить настройку, повторите попытку',
  'messageCenterTitle': 'Центр сообщений',
  'messageCenterHint': 'Отправляйте сообщения и задачи участникам команды',
} satisfies Record<TeamAccountLocaleKey, string>

/** Portuguese dictionary, checked complete against the zh key set. */
export const pt = {
  'title': 'Sair',
  'hint': 'Você precisará entrar novamente para continuar',
  'pairTitle': 'Código de emparelhamento',
  'pairHint': 'Monte um diretório local no seu espaço de trabalho',
  'pairError': 'Não foi possível gerar um código de emparelhamento, tente novamente',
  'pairExpiry': 'Válido até {time}',
  'pairMulti': 'Um código monta vários dispositivos',
  'pairCodeLabel': 'Código de emparelhamento',
  'pairCommandLabel': 'Executar no host de destino',
  'pairCommand': 'dsh-shell remote agent --pair {code} --hub {host}:7101 --root <dir> [--allow-command ...]',
  'copy': 'Copiar',
  'idleExemptTitle': 'Manter a instância em execução',
  'idleExemptHint': 'Quando ativado, sua instância continua no ar mesmo após longa inatividade',
  'idleExemptError': 'Não foi possível atualizar a configuração, tente novamente',
  'messageCenterTitle': 'Central de mensagens',
  'messageCenterHint': 'Envie mensagens e tarefas aos membros da equipe',
} satisfies Record<TeamAccountLocaleKey, string>
