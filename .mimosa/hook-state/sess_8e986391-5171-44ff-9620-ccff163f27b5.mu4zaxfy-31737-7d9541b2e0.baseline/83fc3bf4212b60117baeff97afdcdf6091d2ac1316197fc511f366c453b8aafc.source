export class Osc7DirectoryParser {
  private pending = "";

  push(chunk: Uint8Array | string): string[] {
    this.pending += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk, { stream: true });
    const directories: string[] = [];

    while (true) {
      const start = this.pending.indexOf("\u001b]7;");
      if (start < 0) {
        this.pending = this.pending.slice(-32);
        break;
      }
      const payloadStart = start + 4;
      const bel = this.pending.indexOf("\u0007", payloadStart);
      const st = this.pending.indexOf("\u001b\\", payloadStart);
      const end = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st);
      if (end < 0) {
        this.pending = this.pending.slice(start);
        break;
      }

      const value = this.pending.slice(payloadStart, end);
      const path = parseOsc7Path(value);
      if (path) directories.push(path);
      this.pending = this.pending.slice(end + (end === st ? 2 : 1));
    }

    return directories;
  }

  reset() {
    this.pending = "";
  }
}

export function parseOsc7Path(value: string): string | null {
  if (!value.startsWith("file://")) return null;
  const slash = value.indexOf("/", "file://".length);
  if (slash < 0) return "/";
  try {
    return decodeURIComponent(value.slice(slash)) || "/";
  } catch {
    return value.slice(slash) || "/";
  }
}
