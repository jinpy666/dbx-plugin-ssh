// 增量文案表（自 lib/i18n.ts 纯搬移）：七语键集与占位符一致性由
// workbench.spec.ts 与 i18nKeyReferences.spec.ts 双向校验；合并顺序见 i18n.ts。

// ---------------------------------------------------------------------------
// 外部编辑器回传（IMPL_PLAN v2 P2-5 前端半）追加文案块：只增不改 ——
// supplemental 平铺 dotted key 合并，七语键集与占位符完全一致。
// ---------------------------------------------------------------------------

export const remoteEditMessages: Record<string, Record<string, string>> = {
  en: {
    "remoteEdit.openAction": "Open in external editor",
    "remoteEdit.opened": "\"{name}\" downloaded — open it with your editor; you will be asked to upload after saving",
    "remoteEdit.pathCopied": "Local path copied to clipboard",
    "remoteEdit.downloadFailed": "Download finished without a local path",
    "remoteEdit.promptTitle": "File changed in external editor",
    "remoteEdit.promptMessage": "\"{name}\" was saved in your editor. Upload it back to the server?",
    "remoteEdit.once": "Upload once",
    "remoteEdit.always": "Always upload (this session)",
    "remoteEdit.uploaded": "\"{name}\" uploaded",
  },
  "zh-CN": {
    "remoteEdit.openAction": "在外部编辑器中打开",
    "remoteEdit.opened": "「{name}」已下载——用你的编辑器打开，保存后将询问是否回传",
    "remoteEdit.pathCopied": "本地路径已复制到剪贴板",
    "remoteEdit.downloadFailed": "下载完成但未获得本地路径",
    "remoteEdit.promptTitle": "文件已在外部编辑器中修改",
    "remoteEdit.promptMessage": "「{name}」已在编辑器中保存，是否回传到服务器？",
    "remoteEdit.once": "上传一次",
    "remoteEdit.always": "总是上传（本次会话记住）",
    "remoteEdit.uploaded": "「{name}」已回传",
  },
  "zh-TW": {
    "remoteEdit.openAction": "在外部編輯器中開啟",
    "remoteEdit.opened": "「{name}」已下載——用你的編輯器開啟，儲存後將詢問是否回傳",
    "remoteEdit.pathCopied": "本機路徑已複製到剪貼簿",
    "remoteEdit.downloadFailed": "下載完成但未取得本機路徑",
    "remoteEdit.promptTitle": "檔案已在外部編輯器中修改",
    "remoteEdit.promptMessage": "「{name}」已在編輯器中儲存，是否回傳到伺服器？",
    "remoteEdit.once": "上傳一次",
    "remoteEdit.always": "永遠上傳（本次會話記住）",
    "remoteEdit.uploaded": "「{name}」已回傳",
  },
  es: {
    "remoteEdit.openAction": "Abrir en editor externo",
    "remoteEdit.opened": "\"{name}\" descargado — ábrelo con tu editor; se preguntará si subir tras guardar",
    "remoteEdit.pathCopied": "Ruta local copiada al portapapeles",
    "remoteEdit.downloadFailed": "La descarga terminó sin una ruta local",
    "remoteEdit.promptTitle": "Archivo modificado en editor externo",
    "remoteEdit.promptMessage": "\"{name}\" se guardó en tu editor. ¿Subirlo de nuevo al servidor?",
    "remoteEdit.once": "Subir una vez",
    "remoteEdit.always": "Subir siempre (esta sesión)",
    "remoteEdit.uploaded": "\"{name}\" subido",
  },
  it: {
    "remoteEdit.openAction": "Apri nell'editor esterno",
    "remoteEdit.opened": "\"{name}\" scaricato — aprilo con il tuo editor; dopo il salvataggio verrà chiesto se ricaricarlo",
    "remoteEdit.pathCopied": "Percorso locale copiato negli appunti",
    "remoteEdit.downloadFailed": "Il download è terminato senza un percorso locale",
    "remoteEdit.promptTitle": "File modificato nell'editor esterno",
    "remoteEdit.promptMessage": "\"{name}\" è stato salvato nel tuo editor. Ricaricarlo sul server?",
    "remoteEdit.once": "Carica una volta",
    "remoteEdit.always": "Carica sempre (questa sessione)",
    "remoteEdit.uploaded": "\"{name}\" caricato",
  },
  ja: {
    "remoteEdit.openAction": "外部エディターで開く",
    "remoteEdit.opened": "「{name}」をダウンロードしました。エディターで開き、保存後にアップロードするか確認します",
    "remoteEdit.pathCopied": "ローカルパスをクリップボードにコピーしました",
    "remoteEdit.downloadFailed": "ダウンロード完了時にローカルパスを取得できませんでした",
    "remoteEdit.promptTitle": "ファイルが外部エディターで変更されました",
    "remoteEdit.promptMessage": "「{name}」がエディターで保存されました。サーバーへアップロードし直しますか？",
    "remoteEdit.once": "1 回だけアップロード",
    "remoteEdit.always": "常にアップロード（このセッションで記憶）",
    "remoteEdit.uploaded": "「{name}」をアップロードしました",
  },
  "pt-BR": {
    "remoteEdit.openAction": "Abrir no editor externo",
    "remoteEdit.opened": "\"{name}\" baixado — abra com seu editor; após salvar, será perguntado se deseja enviar de volta",
    "remoteEdit.pathCopied": "Caminho local copiado para a área de transferência",
    "remoteEdit.downloadFailed": "O download terminou sem um caminho local",
    "remoteEdit.promptTitle": "Arquivo alterado no editor externo",
    "remoteEdit.promptMessage": "\"{name}\" foi salvo no seu editor. Enviar de volta ao servidor?",
    "remoteEdit.once": "Enviar uma vez",
    "remoteEdit.always": "Sempre enviar (nesta sessão)",
    "remoteEdit.uploaded": "\"{name}\" enviado",
  },
};
