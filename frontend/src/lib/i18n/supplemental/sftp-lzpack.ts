// 增量文案表（自 lib/i18n.ts 纯搬移）：七语键集与占位符一致性由
// workbench.spec.ts 与 i18nKeyReferences.spec.ts 双向校验；合并顺序见 i18n.ts。

// ST10 显式压缩包模式（自研 lzpack）：文件菜单两入口 + 结果提示。

export const sftpLzpackMessages: Record<string, Record<string, string>> = {
  en: {
    "sftpLzpack.uploadAction": "Upload as compressed (.dbxz)",
    "sftpLzpack.expandAction": "Expand .dbxz here",
    "sftpLzpack.uploaded": "Compressed archive delivered: {name}",
    "sftpLzpack.filesOnly": "Expand download supports regular .dbxz files only.",
  },
  "zh-CN": {
    "sftpLzpack.uploadAction": "压缩上传为 .dbxz",
    "sftpLzpack.expandAction": "解压 .dbxz",
    "sftpLzpack.uploaded": "压缩包已交付：{name}",
    "sftpLzpack.filesOnly": "解压下载仅支持普通 .dbxz 文件。",
  },
  "zh-TW": {
    "sftpLzpack.uploadAction": "壓縮上傳為 .dbxz",
    "sftpLzpack.expandAction": "解壓 .dbxz",
    "sftpLzpack.uploaded": "壓縮檔已交付：{name}",
    "sftpLzpack.filesOnly": "解壓下載僅支援一般 .dbxz 檔案。",
  },
  es: {
    "sftpLzpack.uploadAction": "Subir comprimido (.dbxz)",
    "sftpLzpack.expandAction": "Descomprimir .dbxz",
    "sftpLzpack.uploaded": "Archivo comprimido entregado: {name}",
    "sftpLzpack.filesOnly": "La descarga con expansión solo admite archivos .dbxz normales.",
  },
  it: {
    "sftpLzpack.uploadAction": "Carica compresso (.dbxz)",
    "sftpLzpack.expandAction": "Decomprimi .dbxz",
    "sftpLzpack.uploaded": "Archivio compresso consegnato: {name}",
    "sftpLzpack.filesOnly": "Il download con espansione supporta solo file .dbxz normali.",
  },
  ja: {
    "sftpLzpack.uploadAction": "圧縮してアップロード（.dbxz）",
    "sftpLzpack.expandAction": ".dbxz を展開",
    "sftpLzpack.uploaded": "圧縮ファイルを配信しました：{name}",
    "sftpLzpack.filesOnly": "展開ダウンロードは通常の .dbxz ファイルのみ対応しています。",
  },
  "pt-BR": {
    "sftpLzpack.uploadAction": "Enviar comprimido (.dbxz)",
    "sftpLzpack.expandAction": "Extrair .dbxz",
    "sftpLzpack.uploaded": "Pacote comprimido entregue: {name}",
    "sftpLzpack.filesOnly": "O download com extração suporta apenas arquivos .dbxz comuns.",
  },
};
