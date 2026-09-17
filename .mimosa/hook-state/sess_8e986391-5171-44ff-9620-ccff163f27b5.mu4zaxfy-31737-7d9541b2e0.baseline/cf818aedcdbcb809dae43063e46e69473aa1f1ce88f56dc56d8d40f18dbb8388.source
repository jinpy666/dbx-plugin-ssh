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

  export interface Session {
    readonly type: "send" | "receive";
    abort(): void;
    aborted(): boolean;
    close(): Promise<void>;
    has_ended(): boolean;
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
