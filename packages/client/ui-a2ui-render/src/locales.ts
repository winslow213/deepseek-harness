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
  'run.stop': '停止',
  'run.waiting': '等待命令输出…',
  'run.noValue': '（无返回值）',
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
  'run.stop': 'Stop',
  'run.waiting': 'Waiting for command output…',
  'run.noValue': '(no value)',
  'node.editHint': 'Double-click to edit this node',
  'node.labelPlaceholder': 'Node label',
  'node.detailPlaceholder': 'Custom content…',
  'edge.editHint': 'Double-click to edit this label',
  'edge.labelPlaceholder': 'Edge label',
}

/** Japanese dictionary (same key set). */
export const ja: Record<A2uiKey, string> = {
  'field.required': '必須',
  'button.submit': '送信',
  'button.submitting': '送信中…',
  'error.required': '必須項目を入力してください：{name}',
  'error.busy': 'メッセージを処理中です。しばらく待ってから送信してください',
  'action.localDone': '完了',
  'launcher.open': 'ウィンドウで開く',
  'launcher.hint': '独立したウィンドウで操作します',
  'launcher.popupBlocked': 'ポップアップがブラウザにブロックされました。このサイトのポップアップを許可して再試行してください。',
  'hint.submission': '送信すると、{surfaceId} の入力内容が 1 通のメッセージとしてモデルに送られます。',
  'run.stop': '停止',
  'run.waiting': 'コマンド出力を待っています…',
  'run.noValue': '（戻り値なし）',
  'node.editHint': 'ダブルクリックでノードを編集',
  'node.labelPlaceholder': 'ノードのタイトル',
  'node.detailPlaceholder': 'カスタム内容…',
  'edge.editHint': 'ダブルクリックで接続線のテキストを編集',
  'edge.labelPlaceholder': '接続線のテキスト',
}

/** Spanish dictionary (same key set). */
export const es: Record<A2uiKey, string> = {
  'field.required': 'Obligatorio',
  'button.submit': 'Enviar',
  'button.submitting': 'Enviando…',
  'error.required': 'Rellena el campo obligatorio: {name}',
  'error.busy': 'Se está procesando un mensaje; espera antes de enviar',
  'action.localDone': 'Hecho',
  'launcher.open': 'Abrir en una ventana',
  'launcher.hint': 'Interactúa en una ventana aparte',
  'launcher.popupBlocked': 'El navegador bloqueó la ventana emergente; permite las de este sitio y vuelve a intentarlo.',
  'hint.submission': 'Al enviar, los valores introducidos en {surfaceId} se mandan al modelo como un mensaje.',
  'run.stop': 'Detener',
  'run.waiting': 'Esperando la salida del comando…',
  'run.noValue': '(sin valor)',
  'node.editHint': 'Haz doble clic para editar este nodo',
  'node.labelPlaceholder': 'Título del nodo',
  'node.detailPlaceholder': 'Contenido personalizado…',
  'edge.editHint': 'Haz doble clic para editar este texto de conexión',
  'edge.labelPlaceholder': 'Texto de la conexión',
}

/** French dictionary (same key set). */
export const fr: Record<A2uiKey, string> = {
  'field.required': 'Obligatoire',
  'button.submit': 'Envoyer',
  'button.submitting': 'Envoi…',
  'error.required': 'Renseignez le champ obligatoire : {name}',
  'error.busy': 'Un message est en cours de traitement ; attendez avant d’envoyer',
  'action.localDone': 'Terminé',
  'launcher.open': 'Ouvrir dans une fenêtre',
  'launcher.hint': 'Interagir dans une fenêtre séparée',
  'launcher.popupBlocked': 'La fenêtre a été bloquée par le navigateur ; autorisez les fenêtres de ce site et réessayez.',
  'hint.submission': 'L’envoi transmet au modèle les valeurs saisies pour {surfaceId} sous forme de message.',
  'run.stop': 'Arrêter',
  'run.waiting': 'En attente de la sortie de la commande…',
  'run.noValue': '(aucune valeur)',
  'node.editHint': 'Double-cliquez pour modifier ce nœud',
  'node.labelPlaceholder': 'Titre du nœud',
  'node.detailPlaceholder': 'Contenu personnalisé…',
  'edge.editHint': 'Double-cliquez pour modifier ce libellé',
  'edge.labelPlaceholder': 'Libellé de la liaison',
}

/** German dictionary (same key set). */
export const de: Record<A2uiKey, string> = {
  'field.required': 'Pflichtfeld',
  'button.submit': 'Senden',
  'button.submitting': 'Wird gesendet…',
  'error.required': 'Bitte das Pflichtfeld ausfüllen: {name}',
  'error.busy': 'Eine Nachricht wird gerade verarbeitet; bitte vor dem Senden warten',
  'action.localDone': 'Fertig',
  'launcher.open': 'Im Fenster öffnen',
  'launcher.hint': 'In einem eigenen Fenster bedienen',
  'launcher.popupBlocked': 'Das Popup wurde vom Browser blockiert; erlauben Sie Popups für diese Seite und versuchen Sie es erneut.',
  'hint.submission': 'Beim Senden werden die eingegebenen Werte für {surfaceId} als Nachricht an das Modell übertragen.',
  'run.stop': 'Stoppen',
  'run.waiting': 'Warte auf die Befehlsausgabe…',
  'run.noValue': '(kein Wert)',
  'node.editHint': 'Doppelklick zum Bearbeiten des Knotens',
  'node.labelPlaceholder': 'Knotentitel',
  'node.detailPlaceholder': 'Eigener Inhalt…',
  'edge.editHint': 'Doppelklick zum Bearbeiten der Verbindungsbeschriftung',
  'edge.labelPlaceholder': 'Beschriftung der Verbindung',
}

/** Russian dictionary (same key set). */
export const ru: Record<A2uiKey, string> = {
  'field.required': 'Обязательное поле',
  'button.submit': 'Отправить',
  'button.submitting': 'Отправка…',
  'error.required': 'Заполните обязательное поле: {name}',
  'error.busy': 'Сейчас обрабатывается сообщение; дождитесь завершения перед отправкой',
  'action.localDone': 'Готово',
  'launcher.open': 'Открыть в окне',
  'launcher.hint': 'Работать в отдельном окне',
  'launcher.popupBlocked': 'Браузер заблокировал всплывающее окно; разрешите всплывающие окна для этого сайта и повторите попытку.',
  'hint.submission': 'После отправки введённые для {surfaceId} значения уйдут модели одним сообщением.',
  'run.stop': 'Остановить',
  'run.waiting': 'Ожидание вывода команды…',
  'run.noValue': '(нет значения)',
  'node.editHint': 'Двойной щелчок — изменить узел',
  'node.labelPlaceholder': 'Заголовок узла',
  'node.detailPlaceholder': 'Своё содержимое…',
  'edge.editHint': 'Двойной щелчок — изменить подпись связи',
  'edge.labelPlaceholder': 'Подпись связи',
}

/** Portuguese dictionary (same key set). */
export const pt: Record<A2uiKey, string> = {
  'field.required': 'Obrigatório',
  'button.submit': 'Enviar',
  'button.submitting': 'Enviando…',
  'error.required': 'Preencha o campo obrigatório: {name}',
  'error.busy': 'Há uma mensagem em processamento; aguarde antes de enviar',
  'action.localDone': 'Concluído',
  'launcher.open': 'Abrir em janela',
  'launcher.hint': 'Interagir em uma janela separada',
  'launcher.popupBlocked': 'O navegador bloqueou a janela; permita pop-ups para este site e tente novamente.',
  'hint.submission': 'Ao enviar, os valores preenchidos em {surfaceId} são enviados ao modelo como uma mensagem.',
  'run.stop': 'Parar',
  'run.waiting': 'Aguardando a saída do comando…',
  'run.noValue': '(sem valor)',
  'node.editHint': 'Clique duas vezes para editar este nó',
  'node.labelPlaceholder': 'Título do nó',
  'node.detailPlaceholder': 'Conteúdo personalizado…',
  'edge.editHint': 'Clique duas vezes para editar este texto de conexão',
  'edge.labelPlaceholder': 'Texto da conexão',
}

/** Union of this namespace's dictionary keys. */
export type A2uiKey = keyof typeof zh
