// 增量文案表（自 lib/i18n.ts 纯搬移）：七语键集与占位符一致性由
// workbench.spec.ts 与 i18nKeyReferences.spec.ts 双向校验；合并顺序见 i18n.ts。

// 结构化补全（FIG wave-1 最终架构，completionMenu.*）：CompletionMenu 浮层
// 与 SettingsDialog 引擎下拉。只增不改 —— 走 supplemental 平铺 dotted key
// 合并，七语键集与占位符完全一致。engine* 五键为引擎三态选择
// （ssh-completion-engine：fig-safe 默认 / fig / off）；批次 2-1 起声明式
// generator 经 completion/execute 在目标机执行，fig 与 fig-safe 行为相同，
// off 无任何结构化补全。loading 为 generator 在途占位行（两段渲染 §31）。

export const completionMenuMessages: Record<string, Record<string, string>> = {
  en: {
    "completionMenu.title": "Command completion",
    "completionMenu.kbdHint": "↑↓ Select · Tab Fill · Enter Run · Esc Close",
    "completionMenu.engine": "Completion engine",
    "completionMenu.engineFigSafe": "fig specs (safe, default)",
    "completionMenu.engineFig": "fig specs (full)",
    "completionMenu.engineOff": "Off",
    "completionMenu.engineHint": "Source of the structured subcommand/option/value candidates below the cursor. Off disables the structured popup entirely — history suggestions and the inline ghost are unaffected. Both fig (full) and fig (safe) run spec generators on the target machine over the completion/execute channel; their behaviour is identical in this release.",
    "completionMenu.loading": "Fetching dynamic suggestions…",
  },
  es: {
    "completionMenu.title": "Autocompletado de comandos",
    "completionMenu.kbdHint": "↑↓ Seleccionar · Tab completar · Enter ejecutar · Esc cerrar",
    "completionMenu.engine": "Motor de autocompletado",
    "completionMenu.engineFigSafe": "Especificaciones fig (seguro, predeterminado)",
    "completionMenu.engineFig": "Especificaciones fig (completo)",
    "completionMenu.engineOff": "Desactivado",
    "completionMenu.engineHint": "Origen de los candidatos estructurados de subcomandos, opciones y valores bajo el cursor. «Desactivado» oculta por completo la ventana estructurada: las sugerencias del historial y la autosugerencia fantasma no se ven afectadas. Tanto «fig (completo)» como «fig (seguro)» ejecutan los generadores de especificaciones en la máquina de destino por el canal completion/execute; su comportamiento es idéntico en esta versión.",
    "completionMenu.loading": "Obteniendo sugerencias dinámicas…",
  },
  it: {
    "completionMenu.title": "Completamento comandi",
    "completionMenu.kbdHint": "↑↓ Seleziona · Tab compila · Invio esegui · Esc chiudi",
    "completionMenu.engine": "Motore di completamento",
    "completionMenu.engineFigSafe": "Specifiche fig (sicuro, predefinito)",
    "completionMenu.engineFig": "Specifiche fig (completo)",
    "completionMenu.engineOff": "Disattivato",
    "completionMenu.engineHint": "Origine dei candidati strutturati di sottocomandi, opzioni e valori sotto il cursore. «Disattivato» nasconde completamente il pannello strutturato: i suggerimenti dalla cronologia e il suggerimento fantasma non sono interessati. Sia «fig (completo)» che «fig (sicuro)» eseguono i generatori di specifiche sulla macchina di destinazione tramite il canale completion/execute; il comportamento è identico in questa versione.",
    "completionMenu.loading": "Recupero dei suggerimenti dinamici…",
  },
  ja: {
    "completionMenu.title": "コマンド補完",
    "completionMenu.kbdHint": "↑↓ 選択 · Tab 入力 · Enter 実行 · Esc 閉じる",
    "completionMenu.engine": "補完エンジン",
    "completionMenu.engineFigSafe": "fig スペック（セーフ、デフォルト）",
    "completionMenu.engineFig": "fig スペック（フル）",
    "completionMenu.engineOff": "オフ",
    "completionMenu.engineHint": "カーソル下に表示する構造化候補（サブコマンド・オプション・値）の提供元。「オフ」で構造化ポップアップを完全に無効化します（履歴候補と行内ゴーストには影響しません）。「fig（フル）」と「fig（セーフ）」はどちらも completion/execute チャネル経由で対象マシン上のスペックジェネレーターを実行します（本リリースでは挙動は同じです）。",
    "completionMenu.loading": "動的候補を取得中…",
  },
  "pt-BR": {
    "completionMenu.title": "Autocompletar comandos",
    "completionMenu.kbdHint": "↑↓ Selecionar · Tab preencher · Enter executar · Esc fechar",
    "completionMenu.engine": "Motor de autocompletar",
    "completionMenu.engineFigSafe": "Specs do fig (seguro, padrão)",
    "completionMenu.engineFig": "Specs do fig (completo)",
    "completionMenu.engineOff": "Desativado",
    "completionMenu.engineHint": "Origem dos candidatos estruturados de subcomandos, opções e valores abaixo do cursor. «Desativado» oculta completamente o painel estruturado: as sugestões do histórico e a sugestão fantasma não são afetadas. Tanto «fig (completo)» quanto «fig (seguro)» executam os geradores de specs na máquina de destino pelo canal completion/execute; o comportamento é idêntico nesta versão.",
    "completionMenu.loading": "Buscando sugestões dinâmicas…",
  },
  "zh-CN": {
    "completionMenu.title": "命令结构补全",
    "completionMenu.kbdHint": "↑↓ 选择 · Tab 填充 · Enter 执行 · Esc 关闭",
    "completionMenu.engine": "补全引擎",
    "completionMenu.engineFigSafe": "fig 语料（安全模式，默认）",
    "completionMenu.engineFig": "fig 语料（完整）",
    "completionMenu.engineOff": "关闭",
    "completionMenu.engineHint": "光标下方结构化候选（子命令/选项/取值）的来源。「关闭」时不出现任何结构化浮层，命令历史建议与行内 ghost 自动建议不受影响。「fig 语料（完整）」与「安全模式」都会经 completion/execute 通道在目标机上运行声明式 generator，本版本两者行为相同。",
    "completionMenu.loading": "正在获取动态候选…",
  },
  "zh-TW": {
    "completionMenu.title": "命令結構補全",
    "completionMenu.kbdHint": "↑↓ 選擇 · Tab 填入 · Enter 執行 · Esc 關閉",
    "completionMenu.engine": "補全引擎",
    "completionMenu.engineFigSafe": "fig 語料（安全模式，預設）",
    "completionMenu.engineFig": "fig 語料（完整）",
    "completionMenu.engineOff": "關閉",
    "completionMenu.engineHint": "游標下方結構化候選（子命令/選項/取值）的來源。「關閉」時不出現任何結構化浮層，命令歷史建議與行內 ghost 自動建議不受影響。「fig 語料（完整）」與「安全模式」都會經 completion/execute 通道在目標機上執行宣告式 generator，本版本兩者行為相同。",
    "completionMenu.loading": "正在取得動態候選…",
  },
};
