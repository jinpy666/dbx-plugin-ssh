declare module "zmodem.js" {
  export interface Detection {
    confirm(): Session;
    deny(): void;
    get_session_role(): "send" | "receive";
    is_valid(): boolean;
  }

  export interface Transfer {
    get_offset(): number;
    send(data: Uint8Array): Promise<void> | void;
    end(data: Uint8Array): Promise<void>;
  }

  /** ZFILE header payload as parsed by zmodem.js (`get_details()`).
   * All numeric fields may be null when the sender omitted them. */
  export interface ZmodemFileDetails {
    name: string;
    size: number | null;
    mtime: Date | null;
    mode: number | null;
    serial: number | null;
    files_remaining: number | null;
    bytes_remaining: number | null;
  }

  /** Receiver-side handle for one offered file in a batch (Session.Receive). */
  export interface ZmodemOffer {
    get_details(): ZmodemFileDetails;
    get_offset(): number;
    /** `on_input` receives each packet payload as it arrives (plain octet
     * arrays); the promise resolves when the file is fully received. */
    accept(options?: { on_input?: (payload: number[]) => void }): Promise<void>;
    skip(): Promise<void>;
  }

  export interface Session {
    readonly type: "send" | "receive";
    abort(): void;
    aborted(): boolean;
    close(): Promise<void>;
    has_ended(): boolean;
    /** Receive sessions only: emits the opening ZRINIT and must be called
     * once after `confirm()` or no offer ever arrives. */
    start?(): Promise<unknown>;
    on(event: "offer", callback: (offer: ZmodemOffer) => void): this;
    on(event: "session_end", callback: () => void): this;
    on(event: "garbage", callback: (garbage: number[]) => void): this;
    on(event: string, callback: (...args: unknown[]) => void): this;
    send_offer(details: { name: string; size: number; mtime: Date; files_remaining: number; bytes_remaining: number }): Promise<Transfer | undefined>;
  }

  export interface SentryOptions {
    to_terminal(data: number[]): void;
    sender(data: number[]): void;
    on_detect(detection: Detection): void;
    on_retract(): void;
  }

  export class Sentry {
    constructor(options: SentryOptions);
    consume(data: number[] | ArrayBuffer): void;
    get_confirmed_session(): Session | null;
  }
}
