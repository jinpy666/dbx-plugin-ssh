// 增量文案表（自 lib/i18n.ts 纯搬移）：七语键集与占位符一致性由
// workbench.spec.ts 与 i18nKeyReferences.spec.ts 双向校验；合并顺序见 i18n.ts。

// 串口会话增强（B1/replay，设计稿 docs/SERIAL_ENHANCE_DESIGN.zh-CN.md）：
// 回放缓冲绕回时的截断提示（§3：complete: false → 前端可显示截断提示）。

export const serialEnhanceMessages: Record<string, Record<string, string>> = {
  en: {
    "serial.replayTruncated": "Some earlier output was dropped from the scrollback buffer and cannot be restored.",
  },
  "zh-CN": {
    "serial.replayTruncated": "部分更早的输出已超出回放缓冲，无法恢复。",
  },
  "zh-TW": {
    "serial.replayTruncated": "部分更早的輸出已超出回放緩衝，無法復原。",
  },
  es: {
    "serial.replayTruncated": "Parte de la salida anterior salió del búfer de reproducción y no se puede restaurar.",
  },
  it: {
    "serial.replayTruncated": "Parte dell'output precedente è stata scartata dal buffer di replay e non può essere ripristinata.",
  },
  ja: {
    "serial.replayTruncated": "一部の以前の出力はリプレイバッファから破棄されており、復元できません。",
  },
  "pt-BR": {
    "serial.replayTruncated": "Parte da saída anterior foi descartada do buffer de replay e não pode ser restaurada.",
  },
};
