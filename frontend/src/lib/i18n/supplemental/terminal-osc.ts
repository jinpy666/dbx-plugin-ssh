// 增量文案表（自 lib/i18n.ts 纯搬移）：七语键集与占位符一致性由
// workbench.spec.ts 与 i18nKeyReferences.spec.ts 双向校验；合并顺序见 i18n.ts。

// —— 终端 OSC 通知/SetUserVar 白名单通道（WT-2，App.vue createTerminal 接线）：
// 远端经 OSC 9 / OSC 777 发来的通知在无标题时以此来源标题兜底，与 SFTP/下载
// 等同面通知区分开。七语齐套，缺一即被 workbenchMessageTable 的键集对比测试拦下。——

export const terminalOscMessages: Record<string, Record<string, string>> = {
  en: { "terminalOsc.defaultTitle": "Terminal" },
  "zh-CN": { "terminalOsc.defaultTitle": "终端" },
  "zh-TW": { "terminalOsc.defaultTitle": "終端" },
  es: { "terminalOsc.defaultTitle": "Terminal" },
  it: { "terminalOsc.defaultTitle": "Terminale" },
  ja: { "terminalOsc.defaultTitle": "ターミナル" },
  "pt-BR": { "terminalOsc.defaultTitle": "Terminal" },
};
