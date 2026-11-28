// 增量文案表（自 lib/i18n.ts 纯搬移）：七语键集与占位符一致性由
// workbench.spec.ts 与 i18nKeyReferences.spec.ts 双向校验；合并顺序见 i18n.ts。

// 连接级 SFTP 文件名编码覆盖（M16）。七语齐套，缺一即被 workbenchMessageTable
// 的键集对比测试拦下。auto/latin-1 选项复用 transferCfg.encoding.* 文案。

export const connNameEncodingMessages: Record<string, Record<string, string>> = {
  en: {
    "connNameEncoding.sectionTitle": "Per-connection file name encoding",
    "connNameEncoding.label": "File name encoding (this connection)",
    "connNameEncoding.follow": "Follow global setting",
    "connNameEncoding.hint": "Overrides the global file name encoding for this connection only. The default follows Settings → Transfer; transfers always use the server's raw bytes either way.",
  },
  "zh-CN": {
    "connNameEncoding.sectionTitle": "连接级文件名编码",
    "connNameEncoding.label": "文件名编码（本连接）",
    "connNameEncoding.follow": "跟随全局设置",
    "connNameEncoding.hint": "仅覆盖本连接的文件名显示解码；缺省跟随 设置 → 传输 的全局偏好。无论选哪种，传输始终使用服务器原始字节。",
  },
  "zh-TW": {
    "connNameEncoding.sectionTitle": "連線層級檔名編碼",
    "connNameEncoding.label": "檔名編碼（本連線）",
    "connNameEncoding.follow": "跟隨全域設定",
    "connNameEncoding.hint": "僅覆蓋本連線的檔名顯示解碼；預設跟隨 設定 → 傳輸 的全域偏好。無論選擇哪種，傳輸一律使用伺服器原始位元組。",
  },
  es: {
    "connNameEncoding.sectionTitle": "Codificación de nombres por conexión",
    "connNameEncoding.label": "Codificación de nombres (esta conexión)",
    "connNameEncoding.follow": "Seguir ajuste global",
    "connNameEncoding.hint": "Anula la codificación global de nombres solo para esta conexión; por defecto sigue Ajustes → Transferencia. En cualquier caso, las transferencias usan siempre los bytes originales del servidor.",
  },
  it: {
    "connNameEncoding.sectionTitle": "Codifica nomi per connessione",
    "connNameEncoding.label": "Codifica dei nomi (questa connessione)",
    "connNameEncoding.follow": "Segui impostazione globale",
    "connNameEncoding.hint": "Sostituisce la codifica globale dei nomi solo per questa connessione; per impostazione predefinita segue Impostazioni → Trasferimento. In ogni caso i trasferimenti usano i byte originali del server.",
  },
  ja: {
    "connNameEncoding.sectionTitle": "接続ごとのファイル名エンコーディング",
    "connNameEncoding.label": "ファイル名エンコーディング（この接続）",
    "connNameEncoding.follow": "グローバル設定に従う",
    "connNameEncoding.hint": "この接続にのみグローバルのファイル名エンコーディングを上書きします。既定は 設定 → 転送 に従います。いずれの場合も転送は常にサーバーの生バイトを使用します。",
  },
  "pt-BR": {
    "connNameEncoding.sectionTitle": "Codificação de nomes por conexão",
    "connNameEncoding.label": "Codificação de nomes (esta conexão)",
    "connNameEncoding.follow": "Seguir configuração global",
    "connNameEncoding.hint": "Substitui a codificação global de nomes apenas nesta conexão; por padrão segue Configurações → Transferência. Em qualquer caso, as transferências sempre usam os bytes originais do servidor.",
  },
};
