// 增量文案表（自 lib/i18n.ts 纯搬移）：七语键集与占位符一致性由
// workbench.spec.ts 与 i18nKeyReferences.spec.ts 双向校验；合并顺序见 i18n.ts。

// M32-A3：快速命令的新建/编辑/导入移入「设置 · 终端」，工具条弹层只留执行，
// footer 留一条指路说明（对齐 terminalFont.movedHint 的做法）。

export const quickCommandsManageMessages: Record<string, Record<string, string>> = {
  en: { "quickCommands.manageHint": "Create, edit and import commands in Settings → Terminal." },
  "zh-CN": { "quickCommands.manageHint": "新建/编辑/导入命令已移至「设置 · 终端」。" },
  "zh-TW": { "quickCommands.manageHint": "新增/編輯/匯入指令已移至「設定 · 終端機」。" },
  es: { "quickCommands.manageHint": "Crea, edita e importa comandos en Ajustes → Terminal." },
  it: { "quickCommands.manageHint": "Crea, modifica e importa comandi in Impostazioni → Terminale." },
  ja: { "quickCommands.manageHint": "コマンドの作成・編集・インポートは「設定 → ターミナル」で行います。" },
  "pt-BR": { "quickCommands.manageHint": "Crie, edite e importe comandos em Configurações → Terminal." },
};
