// 增量文案表（自 lib/i18n.ts 纯搬移）：七语键集与占位符一致性由
// workbench.spec.ts 与 i18nKeyReferences.spec.ts 双向校验；合并顺序见 i18n.ts。

// —— sudo 下载（M14-C DownloadSudo）：文件列表「以 root 下载」入口 ——

export const sudoDownloadMessages: Record<string, Record<string, string>> = {
  en: { "sudoDownload.action": "Download as root", "sudoDownload.filesOnly": "Sudo download supports regular files only." },
  "zh-CN": { "sudoDownload.action": "以 root 下载", "sudoDownload.filesOnly": "sudo 下载仅支持普通文件。" },
  "zh-TW": { "sudoDownload.action": "以 root 下載", "sudoDownload.filesOnly": "sudo 下載僅支援一般檔案。" },
  es: { "sudoDownload.action": "Descargar como root", "sudoDownload.filesOnly": "La descarga con sudo solo admite archivos normales." },
  it: { "sudoDownload.action": "Scarica come root", "sudoDownload.filesOnly": "Il download con sudo supporta solo file normali." },
  ja: { "sudoDownload.action": "root としてダウンロード", "sudoDownload.filesOnly": "sudo ダウンロードは通常ファイルのみ対応しています。" },
  "pt-BR": { "sudoDownload.action": "Baixar como root", "sudoDownload.filesOnly": "O download com sudo suporta apenas arquivos comuns." },
};
