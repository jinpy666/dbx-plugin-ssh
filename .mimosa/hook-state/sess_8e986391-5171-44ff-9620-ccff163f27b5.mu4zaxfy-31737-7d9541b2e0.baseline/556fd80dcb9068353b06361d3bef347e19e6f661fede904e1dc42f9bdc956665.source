interface DbxPluginBinaryEvent {
  channel: string;
  /** 当前宿主桥投递零拷贝字节；旧桥（Host API 1.0）投递 base64 字符串。 */
  data?: Uint8Array;
  dataBase64?: string;
}

interface DbxPluginEvent {
  method: string;
  params: Record<string, unknown>;
}

interface DbxPluginFileTransferApi {
  pick(options?: { accept?: string; multiple?: boolean }): Promise<{ files: Array<{ handleId: string; name: string; size: number; contentType: string }> }>;
  read(handleId: string, offset: number, length?: number): Promise<{ dataBase64: string; length: number; eof: boolean }>;
  beginSave(options: { name: string; contentType?: string; size?: number }): Promise<{ handleId: string; chunkBytes: number }>;
  write(handleId: string, offset: number, data: Uint8Array | ArrayBuffer | string): Promise<{ written: number; nextOffset: number }>;
  finish(handleId: string): Promise<void>;
  cancel(handleId: string): Promise<void>;
  onDragState(listener: (active: boolean) => void): () => void;
  onDrop(listener: (files: Array<{ handleId: string; name: string; size: number; contentType: string }>) => void): () => void;
}

interface DbxPluginTheme {
  appearance: "light" | "dark";
  /** 宿主根节点解析后的设计令牌（--color-* / --radius-* / --font-*），Host API 1.0 无此字段。 */
  tokens: Record<string, string>;
}

interface DbxPluginAppearance {
  colorScheme: "light" | "dark";
  colors: {
    background: string;
    foreground: string;
    muted: string;
    mutedForeground: string;
    accent: string;
    accentForeground: string;
    border: string;
    destructive: string;
  };
  terminal: { fontFamily: string; fontSize: number };
  ui?: { fontFamily: string };
}

interface DbxPluginApi {
  ready: Promise<Record<string, unknown>>;
  readonly context?: Record<string, unknown>;
  readonly appearance?: DbxPluginAppearance;
  readonly theme?: DbxPluginTheme;
  readonly locale: string;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  invoke<T = unknown>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T>;
  notify(method: string, params?: unknown): Promise<void>;
  sendBinary(channel: string, data: Uint8Array | ArrayBuffer | string): Promise<void>;
  onEvent(listener: (event: DbxPluginEvent) => void): () => void;
  onBinary(listener: (event: DbxPluginBinaryEvent) => void): () => void;
  onAppearanceChange?(listener: (appearance: DbxPluginAppearance) => void): () => void;
  onLocaleChange?(listener: (locale: string) => void): () => void;
  onContextChange?(listener: (context: Record<string, unknown>) => void): () => void;
  decodeBase64(value: string): Uint8Array;
  encodeBase64(value: Uint8Array | ArrayBuffer): string;
  readonly fileTransfer?: DbxPluginFileTransferApi;
  readonly workbenchState?: { set(state: Record<string, unknown>): Promise<void> };
  readonly clipboard?: { readText(): Promise<string>; writeText(text: string): Promise<void> };
}

interface DbxGifSaveFileHandle {
  createWritable(): Promise<{
    write(data: Uint8Array): Promise<void>;
    close(): Promise<void>;
  }>;
}

interface Window {
  dbxPlugin: DbxPluginApi;
  /** File System Access API: lets desktop webviews choose both folder and filename. */
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: Array<{ description?: string; accept: Record<string, string[]> }>;
  }) => Promise<DbxGifSaveFileHandle>;
}
