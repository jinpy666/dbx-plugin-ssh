// 增量文案表（自 lib/i18n.ts 纯搬移）：七语键集与占位符一致性由
// workbench.spec.ts 与 i18nKeyReferences.spec.ts 双向校验；合并顺序见 i18n.ts。

// 字体/字号/间距控件已移入「外观」分类，终端分类留一条指路说明（避免老用户
// 在「终端」里找不到字体设置）。

export const terminalFontMovedMessages: Record<string, Record<string, string>> = {
  en: { "terminalFont.movedHint": "Terminal font, size and spacing are now configured in the Appearance section." },
  "zh-CN": { "terminalFont.movedHint": "终端字体、字号与间距已移至「外观」分类。" },
  "zh-TW": { "terminalFont.movedHint": "終端字型、字號與間距已移至「外觀」分類。" },
  es: { "terminalFont.movedHint": "La fuente, el tamaño y el espaciado del terminal ahora se configuran en la sección Apariencia." },
  it: { "terminalFont.movedHint": "Font, dimensione e spaziatura del terminale ora si configurano nella sezione Aspetto." },
  ja: { "terminalFont.movedHint": "ターミナルのフォント・サイズ・間隔は「外観」で設定します。" },
  "pt-BR": { "terminalFont.movedHint": "Fonte, tamanho e espaçamento do terminal agora ficam na seção Aparência." },
};
