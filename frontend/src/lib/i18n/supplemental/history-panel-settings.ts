// 增量文案表（自 lib/i18n.ts 纯搬移）：七语键集与占位符一致性由
// workbench.spec.ts 与 i18nKeyReferences.spec.ts 双向校验；合并顺序见 i18n.ts。

// ---------------------------------------------------------------------------
// history 面板功能开关（issue #169）：默认开；关闭后面板整体不可唤起——
// Ctrl+R / Ctrl+Shift+H 都归还远端 shell（原生历史与反向搜索照常响应）。
// 裸 ↑ 唤起独立开关（issue #108 反馈二）：默认关——普通屏上的全屏程序
// （堡垒机服务器列表、mysql/psql REPL）靠 ↑ 导航且无从探测，↑ 恒透传；
// 面板由热键唤起。命令历史采集与建议浮层是独立功能，不受影响。
// 七语键集完全一致（workbench.spec / i18nKeyReferences.spec 双向校验）。
// ---------------------------------------------------------------------------

export const historyPanelSettingsMessages: Record<string, Record<string, string>> = {
  en: {
    "historyPanelSettings.sectionTitle": "Command history panel",
    "historyPanelSettings.enabledLabel": "Enable the command history panel",
    "historyPanelSettings.arrowUpLabel": "Open the panel with bare ↑",
    "historyPanelSettings.arrowUpHint": "Also opens the panel when ↑ is pressed at an idle prompt (Warp style). The plugin only claims ↑ inside sessions with confirmed shell integration (bash/zsh hook) while no command is running — bastion host menus, nested SSH sessions and REPLs like mysql/psql never get claimed, so ↑ keeps navigating them. Open the panel anywhere with Ctrl+R / Ctrl+Shift+H.",
    "historyPanelSettings.enabledHint": "On: ↑ at an idle prompt opens the command history panel, and Ctrl+R / Ctrl+Shift+H open it with search focused. Off: ↑ and Ctrl+R are passed to the remote shell, so its native history and reverse search (which record commands as completed by Tab) respond instead. Command history collection and suggestion popups are separate features and keep working.",
    "historyPanelSettings.typeCloseLabel": "Close panel when typing in the terminal",
    "historyPanelSettings.typeCloseHint": "On (default): typing in the terminal while the panel is open closes it, so it never covers what you are typing. Off: the panel stays open and filters live as you type; the best match is highlighted at the bottom (nearest the input line), ↑↓ move and Enter/Tab accept.",
    "historyPanelSettings.limitLabel": "History entries to keep",
    "historyPanelSettings.limitHint": "How many commands the panel, suggestions and ghost reuse keep per connection ({min}–{max}, default {def}). Lowering the value trims existing history immediately.",
  },
  es: {
    "historyPanelSettings.sectionTitle": "Panel de historial de comandos",
    "historyPanelSettings.enabledLabel": "Activar el panel de historial de comandos",
    "historyPanelSettings.arrowUpLabel": "Abrir el panel con la tecla ↑ sola",
    "historyPanelSettings.arrowUpHint": "También abre el panel al pulsar ↑ con el prompt en reposo (estilo Warp). El plugin solo captura ↑ en sesiones con integración de shell confirmada (hook de bash/zsh) y sin ningún comando en ejecución; los menús de bastión, las sesiones SSH anidadas y los REPL como mysql/psql nunca se capturan, así que ↑ sigue navegando en ellos. Abre el panel en cualquier contexto con Ctrl+R / Ctrl+Shift+H.",
    "historyPanelSettings.enabledHint": "Activado: ↑ con el prompt en reposo abre el panel de historial, y Ctrl+R / Ctrl+Shift+H lo abren con el buscador enfocado. Desactivado: ↑ y Ctrl+R se envían al shell remoto, que responde con su historial nativo y su búsqueda inversa (registran los comandos tal como quedaron tras el completado con Tab). La recolección de historial y las sugerencias son funciones independientes y siguen activas.",
    "historyPanelSettings.typeCloseLabel": "Cerrar el panel al escribir en el terminal",
    "historyPanelSettings.typeCloseHint": "Activado (predeterminado): al escribir en el terminal con el panel abierto, este se cierra y nunca tapa lo que escribes. Desactivado: el panel permanece abierto y filtra en vivo mientras escribes; la mejor coincidencia se resalta abajo (junto a la línea de entrada), ↑↓ mueven y Enter/Tab aceptan.",
    "historyPanelSettings.limitLabel": "Entradas de historial que se conservan",
    "historyPanelSettings.limitHint": "Cuántos comandos conservan el panel, las sugerencias y el ghost por conexión ({min}–{max}, por defecto {def}). Al reducir el valor, el historial existente se recorta de inmediato.",
  },
  it: {
    "historyPanelSettings.sectionTitle": "Pannello cronologia comandi",
    "historyPanelSettings.enabledLabel": "Attiva il pannello della cronologia comandi",
    "historyPanelSettings.arrowUpLabel": "Apri il pannello con il solo ↑",
    "historyPanelSettings.arrowUpHint": "Apre anche il pannello quando si preme ↑ con il prompt inattivo (stile Warp). Il plugin si riserva ↑ solo nelle sessioni con integrazione shell confermata (hook bash/zsh) e nessun comando in esecuzione; i menu dei bastion, le sessioni SSH annidate e i REPL come mysql/psql non vengono mai intercettati, quindi ↑ continua a navigarli. Apri il pannello in qualsiasi contesto con Ctrl+R / Ctrl+Shift+H.",
    "historyPanelSettings.enabledHint": "Attivo: ↑ con il prompt inattivo apre il pannello della cronologia, e Ctrl+R / Ctrl+Shift+H lo aprono con la ricerca attiva. Disattivo: ↑ e Ctrl+R vengono inviati alla shell remota, che risponde con la cronologia nativa e la ricerca inversa (registrano i comandi come risultano dopo il completamento con Tab). Raccolta della cronologia e suggerimenti sono funzioni indipendenti e continuano a funzionare.",
    "historyPanelSettings.typeCloseLabel": "Chiudi il pannello quando si digita nel terminale",
    "historyPanelSettings.typeCloseHint": "Attivo (predefinito): digitando nel terminale con il pannello aperto, il pannello si chiude e non copre mai ciò che scrivi. Disattivo: il pannello resta aperto e filtra in tempo reale durante la digitazione; la corrispondenza migliore è evidenziata in basso (vicino alla riga di input), ↑↓ spostano e Enter/Tab accettano.",
    "historyPanelSettings.limitLabel": "Voci di cronologia da conservare",
    "historyPanelSettings.limitHint": "Quanti comandi mantengono per connessione il pannello, i suggerimenti e il ghost ({min}–{max}, predefinito {def}). Riducendo il valore la cronologia esistente viene subito trimmata.",
  },
  ja: {
    "historyPanelSettings.sectionTitle": "コマンド履歴パネル",
    "historyPanelSettings.enabledLabel": "コマンド履歴パネルを有効にする",
    "historyPanelSettings.arrowUpLabel": "裸 ↑ でパネルを開く",
    "historyPanelSettings.arrowUpHint": "プロンプト待機中に ↑ を押したときもパネルを開きます（Warp 方式）。↑ が奪われるのは、シェル統合（bash/zsh フック）が確認できていて実行中コマンドがないセッションだけです。踏み台ホストのメニュー、ネストした SSH セッション、mysql/psql などの REPL では決して奪われず、↑ はそのまま操作に使えます。どの画面でも Ctrl+R / Ctrl+Shift+H で開けます。",
    "historyPanelSettings.enabledHint": "オン: プロンプト待機中に ↑ でコマンド履歴パネルが開き、Ctrl+R / Ctrl+Shift+H は検索フォーカス付きで開きます。オフ: ↑ と Ctrl+R はリモートシェルに渡され、ネイティブ履歴とインクリメンタル検索（Tab 補完後のコマンドをそのまま記録）が応答します。履歴の収集とサジェストは独立した機能のため、影響を受けません。",
    "historyPanelSettings.typeCloseLabel": "ターミナル入力時にパネルを閉じる",
    "historyPanelSettings.typeCloseHint": "オン（既定）: パネル開いている状態でターミナルに入力するとパネルが閉じ、入力行を遮りません。オフ: パネルは開いたままで入力に合わせリアルタイム絞り込み。最も一致する項目が下端（入力行側）にハイライトされ、↑↓ で移動、Enter/Tab で確定します。",
    "historyPanelSettings.limitLabel": "保持する履歴件数",
    "historyPanelSettings.limitHint": "接続ごとにパネル・サジェスト・ghost が保持するコマンド件数（{min}〜{max}、既定 {def}）。値を下げると既存の履歴は直ちに切り詰められます。",
  },
  "pt-BR": {
    "historyPanelSettings.sectionTitle": "Painel de histórico de comandos",
    "historyPanelSettings.enabledLabel": "Ativar o painel de histórico de comandos",
    "historyPanelSettings.arrowUpLabel": "Abrir o painel com ↑ sozinho",
    "historyPanelSettings.arrowUpHint": "Também abre o painel ao pressionar ↑ com o prompt ocioso (estilo Warp). O plugin só captura ↑ em sessões com integração de shell confirmada (hook bash/zsh) e nenhum comando em execução; menus de bastion, sessões SSH aninhadas e REPLs como mysql/psql nunca são capturados, então ↑ continua navegando neles. Abra o painel em qualquer contexto com Ctrl+R / Ctrl+Shift+H.",
    "historyPanelSettings.enabledHint": "Ativado: ↑ com o prompt ocioso abre o painel de histórico, e Ctrl+R / Ctrl+Shift+H o abrem com a busca focada. Desativado: ↑ e Ctrl+R são enviados ao shell remoto, que responde com o histórico nativo e a busca reversa (registram os comandos como ficaram após o completado com Tab). A coleta de histórico e as sugestões são funções independentes e continuam funcionando.",
    "historyPanelSettings.typeCloseLabel": "Fechar o painel ao digitar no terminal",
    "historyPanelSettings.typeCloseHint": "Ativado (padrão): digitar no terminal com o painel aberto o fecha, para que ele nunca cubra o que você digita. Desativado: o painel permanece aberto e filtra em tempo real enquanto você digita; a melhor correspondência é destacada na parte de baixo (junto à linha de entrada), ↑↓ movem e Enter/Tab aceitam.",
    "historyPanelSettings.limitLabel": "Entradas de histórico a manter",
    "historyPanelSettings.limitHint": "Quantos comandos o painel, as sugestões e o ghost mantêm por conexão ({min}–{max}, padrão {def}). Reduzir o valor aparar o histórico existente imediatamente.",
  },
  "zh-CN": {
    "historyPanelSettings.sectionTitle": "命令历史面板",
    "historyPanelSettings.enabledLabel": "启用命令历史面板",
    "historyPanelSettings.arrowUpLabel": "裸 ↑ 唤起历史面板（Warp 式）",
    "historyPanelSettings.arrowUpHint": "开启后，提示符空闲时按 ↑ 也会打开面板。↑ 只在已确认 shell 集成（bash/zsh 钩子）且无命令运行的会话中被接管——堡垒机菜单、嵌套 SSH 会话、mysql/psql 等 REPL 永远不会被接管，↑ 照常导航；任何场景都可用 Ctrl+R / Ctrl+Shift+H 打开面板。",
    "historyPanelSettings.enabledHint": "开启：提示符空闲时按 ↑ 打开命令历史面板，Ctrl+R / Ctrl+Shift+H 打开并聚焦搜索。关闭：↑ 和 Ctrl+R 直接透传远端 shell，由其原生历史与反向搜索（记录的是 Tab 补全后实际执行的命令）响应；命令历史采集与建议浮层是独立功能，不受影响。",
    "historyPanelSettings.typeCloseLabel": "在终端打字时关闭历史面板",
    "historyPanelSettings.typeCloseHint": "开启（默认）：面板打开时在终端打字即关闭面板，不再遮挡输入内容。关闭：面板保持打开并随输入实时过滤，最匹配项锚定在底部（靠近输入行），↑↓ 移动、Enter/Tab 快捷选中。",
    "historyPanelSettings.limitLabel": "历史记录保留条数",
    "historyPanelSettings.limitHint": "每个连接在面板、命令建议与行内 ghost 中保留的命令条数（{min}–{max}，默认 {def}）。调小后现有历史立即裁剪。",
  },
  "zh-TW": {
    "historyPanelSettings.sectionTitle": "命令歷史面板",
    "historyPanelSettings.enabledLabel": "啟用命令歷史面板",
    "historyPanelSettings.arrowUpLabel": "裸 ↑ 喚起歷史面板（Warp 式）",
    "historyPanelSettings.arrowUpHint": "開啟後，提示字元閒置時按 ↑ 也會開啟面板。↑ 只在已確認 shell 整合（bash/zsh 攔截鉤子）且無命令執行的連線中被接管——堡壘機選單、巢狀 SSH 連線、mysql/psql 等 REPL 永遠不會被接管，↑ 照常導航；任何情境都可用 Ctrl+R / Ctrl+Shift+H 開啟面板。",
    "historyPanelSettings.enabledHint": "開啟：提示字元閒置時按 ↑ 開啟命令歷史面板，Ctrl+R / Ctrl+Shift+H 開啟並聚焦搜尋。關閉：↑ 和 Ctrl+R 直接透傳遠端 shell，由其原生歷史與反向搜尋（記錄的是 Tab 補全後實際執行的命令）回應；命令歷史採集與建議浮層是獨立功能，不受影響。",
    "historyPanelSettings.typeCloseLabel": "在終端打字時關閉歷史面板",
    "historyPanelSettings.typeCloseHint": "開啟（預設）：面板開啟時在終端打字即關閉面板，不再遮擋輸入內容。關閉：面板保持開啟並隨輸入即時過濾，最匹配項錨定在底部（靠近輸入行），↑↓ 移動、Enter/Tab 快捷選中。",
    "historyPanelSettings.limitLabel": "歷史記錄保留筆數",
    "historyPanelSettings.limitHint": "每個連線在面板、命令建議與行內 ghost 中保留的命令筆數（{min}–{max}，預設 {def}）。調小後現有歷史立即裁剪。",
  },
};
