// 增量文案表（自 lib/i18n.ts 纯搬移）：七语键集与占位符一致性由
// workbench.spec.ts 与 i18nKeyReferences.spec.ts 双向校验；合并顺序见 i18n.ts。

// 拖拽上传门禁的拒绝提示（终端/SFTP 面板/宿主级拖入三条链路共用）：未连接、
// 只读会话或传输协议占用终端时，拒绝要有反馈而不是静默吞掉。
// terminalDropToPanel 是面板打开时终端拖入的专属指引：面板是可见落点，
// 终端不再接收拖拽，提示用户拖到面板而不是落进看不见的目录。

export const dropGateMessages: Record<string, Record<string, string>> = {
  "zh-CN": {
    dropRefused: "已忽略拖入的文件：会话未连接、为只读或正在传输中",
    terminalDropToPanel: "SFTP 面板已打开：请把文件拖到 SFTP 面板上传",
  },
  "zh-TW": {
    dropRefused: "已忽略拖入的檔案：工作階段未連線、為唯讀或正在傳輸中",
    terminalDropToPanel: "SFTP 面板已開啟：請把檔案拖到 SFTP 面板上傳",
  },
  en: {
    dropRefused: "Dropped files ignored: the session is not connected, is read-only, or a transfer is in progress",
    terminalDropToPanel: "The SFTP panel is open — drop files onto the SFTP panel to upload",
  },
  es: {
    dropRefused: "Archivos soltados ignorados: la sesión no está conectada, es de solo lectura o hay una transferencia en curso",
    terminalDropToPanel: "El panel SFTP está abierto: suelta los archivos en el panel SFTP para subirlos",
  },
  it: {
    dropRefused: "File rilasciati ignorati: la sessione non è connessa, è in sola lettura o è in corso un trasferimento",
    terminalDropToPanel: "Il pannello SFTP è aperto: rilascia i file sul pannello SFTP per caricarli",
  },
  ja: {
    dropRefused: "ドロップされたファイルを無視しました：セッションが未接続、読み取り専用、または転送中です",
    terminalDropToPanel: "SFTP パネルが開いています：ファイルは SFTP パネルにドロップしてアップロードしてください",
  },
  "pt-BR": {
    dropRefused: "Arquivos soltados ignorados: a sessão não está conectada, é somente leitura ou há uma transferência em andamento",
    terminalDropToPanel: "O painel SFTP está aberto — solte os arquivos no painel SFTP para enviá-los",
  },
};
