// 增量文案表（自 lib/i18n.ts 纯搬移）：七语键集与占位符一致性由
// workbench.spec.ts 与 i18nKeyReferences.spec.ts 双向校验；合并顺序见 i18n.ts。

// #337：传输设置分组（上传相关设置独立成「上传设置」组 + 传输 tab 导航标签
// 中性化，不再叫「下载设置」）与 SFTP 面板快捷键说明。七语齐套，缺一即被
// workbench.spec 的键集对比测试拦下。

export const transferSettingsGroupMessages: Record<string, Record<string, string>> = {
  en: {
    "settingsNav.transfer": "Transfer",
    "uploadSettings.title": "Uploads",
    "settingsHotkeys.sftpNote": "SFTP panel shortcuts: F2 rename · Delete delete (single or multi-selection)",
  },
  "zh-CN": {
    "settingsNav.transfer": "传输",
    "uploadSettings.title": "上传设置",
    "settingsHotkeys.sftpNote": "SFTP 面板快捷键：F2 重命名 · Delete 删除（单选/多选均生效）",
  },
  "zh-TW": {
    "settingsNav.transfer": "傳輸",
    "uploadSettings.title": "上傳設定",
    "settingsHotkeys.sftpNote": "SFTP 面板快捷鍵：F2 重新命名 · Delete 刪除（單選/多選均生效）",
  },
  es: {
    "settingsNav.transfer": "Transferencias",
    "uploadSettings.title": "Subidas",
    "settingsHotkeys.sftpNote": "Atajos del panel SFTP: F2 renombrar · Supr eliminar (selección simple o múltiple)",
  },
  it: {
    "settingsNav.transfer": "Trasferimenti",
    "uploadSettings.title": "Caricamenti",
    "settingsHotkeys.sftpNote": "Scorciatoie del pannello SFTP: F2 rinomina · Canc elimina (selezione singola o multipla)",
  },
  ja: {
    "settingsNav.transfer": "転送",
    "uploadSettings.title": "アップロード",
    "settingsHotkeys.sftpNote": "SFTP パネルのショートカット：F2 名前変更 · Delete 削除（単一・複数選択の両方に対応）",
  },
  "pt-BR": {
    "settingsNav.transfer": "Transferências",
    "uploadSettings.title": "Envios",
    "settingsHotkeys.sftpNote": "Atalhos do painel SFTP: F2 renomear · Delete excluir (seleção única ou múltipla)",
  },
};
