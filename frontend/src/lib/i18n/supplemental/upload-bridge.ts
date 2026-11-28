// 增量文案表（自 lib/i18n.ts 纯搬移）：七语键集与占位符一致性由
// workbench.spec.ts 与 i18nKeyReferences.spec.ts 双向校验；合并顺序见 i18n.ts。

// 上传走宿主 fileTransfer 桥时的读盘失败兜底（issue #83/#79：宿主句柄失效会以
// "unknown plugin file handle" 之类的原始英文错误直达用户）。桥接失败转成七语
// 可读提示，按钮路径回退原生文件选择；顺带补上缺失的 errors.localFileShortRead。

export const uploadBridgeMessages: Record<string, Record<string, string>> = {
  "zh-CN": {
    uploadBridgeReadFailed: "{name} 上传失败：无法通过宿主读取本地文件",
    uploadBridgeFallback: "宿主文件桥接不可用，请重新选择要上传的文件",
    "errors.localFileShortRead": "本地文件比预期短，可能已被修改或删除",
  },
  "zh-TW": {
    uploadBridgeReadFailed: "{name} 上傳失敗：無法透過宿主讀取本機檔案",
    uploadBridgeFallback: "宿主檔案橋接不可用，請重新選擇要上傳的檔案",
    "errors.localFileShortRead": "本機檔案比預期短，可能已被修改或刪除",
  },
  en: {
    uploadBridgeReadFailed: "Upload of {name} failed: the local file could not be read through the host",
    uploadBridgeFallback: "Host file bridge is unavailable — pick the files again to upload",
    "errors.localFileShortRead": "Local file is shorter than expected; it may have changed or been deleted",
  },
  es: {
    uploadBridgeReadFailed: "Error al subir {name}: no se pudo leer el archivo local a través del host",
    uploadBridgeFallback: "El puente de archivos del host no está disponible; vuelve a elegir los archivos",
    "errors.localFileShortRead": "El archivo local es más corto de lo esperado; puede haberse modificado o eliminado",
  },
  it: {
    uploadBridgeReadFailed: "Caricamento di {name} non riuscito: impossibile leggere il file locale tramite l'host",
    uploadBridgeFallback: "Il bridge file dell'host non è disponibile; seleziona di nuovo i file",
    "errors.localFileShortRead": "Il file locale è più corto del previsto; potrebbe essere stato modificato o eliminato",
  },
  ja: {
    uploadBridgeReadFailed: "{name} のアップロードに失敗しました：ホスト経由でローカルファイルを読み取れません",
    uploadBridgeFallback: "ホストのファイルブリッジを利用できません。ファイルをもう一度選択してください",
    "errors.localFileShortRead": "ローカルファイルが想定より短いです。変更または削除された可能性があります",
  },
  "pt-BR": {
    uploadBridgeReadFailed: "Falha ao enviar {name}: não foi possível ler o arquivo local através do host",
    uploadBridgeFallback: "A ponte de arquivos do host está indisponível — selecione os arquivos novamente",
    "errors.localFileShortRead": "O arquivo local está mais curto que o esperado; pode ter sido alterado ou excluído",
  },
};
