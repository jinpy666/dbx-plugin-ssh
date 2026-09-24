// OSC 633 shell-integration command markers, ported from tiny-rdm's
// modules/ssh/osc633-parser.js. Pure frontend parsing: when the remote shell
// runs a VS Code-compatible shell integration script the stream carries
// `\u001b]633;…` frames that mark prompt/command/exit boundaries. We consume
// them to surface "which command is running, what it returned, how long it
// took" without touching the backend. Streams without the markers parse to
// plain output, so the feature degrades to a no-op.

export const OSC_633_COMMAND_PHASES = ["prompt", "input", "executing", "completed", "idle"] as const;

export type Osc633CommandPhase = (typeof OSC_633_COMMAND_PHASES)[number];

const OSC_633_PREFIX = "\u001b]633;";
const OSC_633_BEL = "\u0007";
const OSC_633_ST = "\u001b\\";

export interface Osc633ParserState {
  carry: string;
  cwd: string;
  shell: string;
  command: string;
  commandPhase: Osc633CommandPhase;
  lastExitCode: number | null;
  shellIntegrationInstalled: boolean;
  commandActive: boolean;
  lastCommand: string;
  currentCommand: string;
  currentCommandStartAt: number | null;
  lastCommandStartAt: number | null;
  lastCommandEndAt: number | null;
  lastCommandDuration: number | null;
  currentCommandHasExitCode: boolean;
}

export interface Osc633StreamUpdates {
  cwd?: string;
  shell?: string;
  command?: string;
  commandPhase?: Osc633CommandPhase;
  lastExitCode?: number | null;
  currentCommand?: string;
  lastCommandStartAt?: number | null;
  lastCommandEndAt?: number | null;
  lastCommandDuration?: number | null;
  commandActive?: boolean;
  shellIntegrationInstalled?: boolean;
}

export interface Osc633StreamChunk {
  clean: string;
  updates: Osc633StreamUpdates;
  state: Osc633ParserState;
}

export function getOsc633ParserState(): Osc633ParserState {
  return {
    carry: "",
    cwd: "",
    shell: "",
    command: "",
    commandPhase: "idle",
    lastExitCode: null,
    shellIntegrationInstalled: false,
    commandActive: false,
    lastCommand: "",
    currentCommand: "",
    currentCommandStartAt: null,
    lastCommandStartAt: null,
    lastCommandEndAt: null,
    lastCommandDuration: null,
    currentCommandHasExitCode: false,
  };
}

function stateNow(): number {
  return Date.now();
}

function decodeShellIntegrationValue(value: string): string {
  return String(value || "")
    .replace(/\\x([0-9a-fA-F]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\\\/g, "\\");
}

function completeCommandByExit(state: Osc633ParserState, hasExitCode: boolean) {
  const startAt = Number(state.currentCommandStartAt);
  const hasValidStart = Number.isFinite(startAt);
  const endedAt = stateNow();

  state.currentCommandHasExitCode = Boolean(hasExitCode);
  state.lastCommandStartAt = hasValidStart ? startAt : null;
  state.lastCommandEndAt = endedAt;
  state.lastCommandDuration = hasValidStart ? Math.max(0, endedAt - startAt) : null;
  if (state.command) {
    state.currentCommand = state.command;
  }

  return {
    lastCommandStartAt: state.lastCommandStartAt,
    lastCommandEndAt: state.lastCommandEndAt,
    lastCommandDuration: state.lastCommandDuration,
    currentCommand: state.currentCommand || state.lastCommand || "",
  };
}

function nextOsc633Terminator(text: string, startIndex: number): { index: number; length: number } {
  const bellIndex = text.indexOf(OSC_633_BEL, startIndex);
  const stIndex = text.indexOf(OSC_633_ST, startIndex);

  if (bellIndex === -1 && stIndex === -1) {
    return { index: -1, length: 0 };
  }

  if (bellIndex === -1) {
    return { index: stIndex, length: OSC_633_ST.length };
  }
  if (stIndex === -1) {
    return { index: bellIndex, length: OSC_633_BEL.length };
  }

  return bellIndex <= stIndex ? { index: bellIndex, length: OSC_633_BEL.length } : { index: stIndex, length: OSC_633_ST.length };
}

function updateStateFromOscFrame(state: Osc633ParserState, payload: string): Osc633StreamUpdates | null {
  const type = payload.charAt(0);
  const args = payload.length > 1 && payload.charAt(1) === ";" ? payload.slice(2) : "";
  const updates: Osc633StreamUpdates = {};

  if (type === "P") {
    const eqIndex = args.indexOf("=");
    if (eqIndex === -1) {
      return updates;
    }

    const key = args.slice(0, eqIndex);
    const value = decodeShellIntegrationValue(args.slice(eqIndex + 1));

    if (key === "Cwd") {
      state.cwd = value;
      updates.cwd = value;
      return updates;
    }
    if (key === "Shell") {
      state.shell = value.trim();
      updates.shell = state.shell;
      return updates;
    }
    return null;
  }

  if (type === "E") {
    const command = decodeShellIntegrationValue(args);
    state.lastCommand = command;
    state.command = command;
    state.shellIntegrationInstalled = true;
    state.commandPhase = "executing";
    state.currentCommand = command;
    state.currentCommandStartAt = stateNow();
    state.currentCommandHasExitCode = false;
    state.commandActive = true;
    updates.currentCommand = state.currentCommand;
    updates.shellIntegrationInstalled = true;
    updates.command = command;
    updates.commandPhase = "executing";
    updates.commandActive = true;
    return updates;
  }

  if (type === "D") {
    const exitCode = Number.parseInt(args || "", 10);
    state.lastExitCode = Number.isFinite(exitCode) ? exitCode : null;
    const completion = completeCommandByExit(state, true);
    updates.lastCommandStartAt = completion.lastCommandStartAt;
    updates.lastCommandEndAt = completion.lastCommandEndAt;
    updates.lastCommandDuration = completion.lastCommandDuration;
    updates.currentCommand = completion.currentCommand;
    state.shellIntegrationInstalled = true;
    state.commandPhase = "completed";
    state.commandActive = false;
    updates.shellIntegrationInstalled = true;
    updates.lastExitCode = state.lastExitCode;
    updates.commandPhase = "completed";
    updates.commandActive = false;
    return updates;
  }

  if (type === "A" || type === "B" || type === "C") {
    state.commandPhase = type === "A" ? "prompt" : type === "B" ? "input" : "executing";
    state.shellIntegrationInstalled = true;

    if (type === "A" && state.commandActive && !state.currentCommandHasExitCode) {
      const completion = completeCommandByExit(state, false);
      updates.lastCommandStartAt = completion.lastCommandStartAt;
      updates.lastCommandEndAt = completion.lastCommandEndAt;
      updates.lastCommandDuration = completion.lastCommandDuration;
      updates.currentCommand = completion.currentCommand;
    }

    state.commandActive = type !== "A";
    if (type === "A") {
      state.lastExitCode = null;
      // updates 是按标记合并进 chunk 级结果的（last-write-wins）：真实 shell 的
      // precmd 先发 D（上一命令退出码）再发 A（新提示符），同一段数据里 A 若
      // 携带 lastExitCode=null 会把 D 已写入的退出码覆写掉，退出码标记就永远
      // 显示不出来。applyCommandMarker 对 null 本就不复位（旧值语义），所以 A
      // 干脆不携带该字段。
      updates.commandPhase = "prompt";
    } else {
      updates.commandPhase = state.commandPhase;
    }
    updates.shellIntegrationInstalled = true;
    updates.commandActive = state.commandActive;
    return updates;
  }

  return null;
}

export function parseOsc633StreamChunk(output: string | Uint8Array, state: Osc633ParserState = getOsc633ParserState()): Osc633StreamChunk {
  const decoded = typeof output === "string" ? output : new TextDecoder().decode(output, { stream: true });
  const text = String(state.carry || "") + String(decoded || "");
  let clean = "";
  const updates: Osc633StreamUpdates = {};
  let cursor = 0;

  while (cursor < text.length) {
    const start = text.indexOf("\u001b", cursor);
    if (start === -1) {
      clean += text.slice(cursor);
      state.carry = "";
      return { clean, updates, state };
    }

    clean += text.slice(cursor, start);
    const nextChar = text.charAt(start + 1);
    if (!nextChar) {
      state.carry = text.slice(start);
      return { clean, updates, state };
    }

    if (nextChar !== "]") {
      clean += text[start];
      cursor = start + 1;
      continue;
    }

    if (start + OSC_633_PREFIX.length > text.length) {
      state.carry = text.slice(start);
      return { clean, updates, state };
    }

    if (!text.startsWith(OSC_633_PREFIX, start)) {
      clean += text[start];
      cursor = start + 1;
      continue;
    }

    const payloadStart = start + OSC_633_PREFIX.length;
    const { index: end, length: terminatorLength } = nextOsc633Terminator(text, payloadStart);

    if (end === -1) {
      state.carry = text.slice(start);
      return { clean, updates, state };
    }

    const payload = text.slice(payloadStart, end);
    const parsed = updateStateFromOscFrame(state, payload);

    if (!parsed || Object.keys(parsed).length === 0) {
      // Unknown OSC 633 payloads stay in the visible output, matching tiny-rdm.
      clean += text.slice(start, end + terminatorLength);
    } else {
      if ("cwd" in parsed) updates.cwd = parsed.cwd;
      if ("shell" in parsed) updates.shell = parsed.shell;
      if ("command" in parsed) updates.command = parsed.command;
      if ("commandPhase" in parsed) updates.commandPhase = parsed.commandPhase;
      if ("lastExitCode" in parsed) updates.lastExitCode = parsed.lastExitCode;
      if ("currentCommand" in parsed) updates.currentCommand = parsed.currentCommand;
      if ("lastCommandStartAt" in parsed) updates.lastCommandStartAt = parsed.lastCommandStartAt;
      if ("lastCommandEndAt" in parsed) updates.lastCommandEndAt = parsed.lastCommandEndAt;
      if ("lastCommandDuration" in parsed) updates.lastCommandDuration = parsed.lastCommandDuration;
      if ("commandActive" in parsed) updates.commandActive = parsed.commandActive;
      if ("shellIntegrationInstalled" in parsed) updates.shellIntegrationInstalled = parsed.shellIntegrationInstalled;
    }

    cursor = end + terminatorLength;
  }

  state.carry = "";
  return { clean, updates, state };
}

const decoder = new TextDecoder();

/** Stateful wrapper mirroring `Osc7DirectoryParser`: feed raw terminal bytes, get updates. */
export class Osc633CommandParser {
  private state = getOsc633ParserState();

  push(chunk: Uint8Array | string): Osc633StreamUpdates {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    return parseOsc633StreamChunk(text, this.state).updates;
  }

  get snapshot(): Osc633ParserState {
    return { ...this.state };
  }

  reset() {
    this.state = getOsc633ParserState();
  }
}

/** Human-friendly duration for the command marker strip: `850ms`, `1.2s`, `2m05s`. */
export function formatCommandDuration(durationMs: number | null | undefined): string {
  const value = Number(durationMs);
  if (!Number.isFinite(value) || value < 0) return "0ms";
  if (value < 1000) return `${Math.round(value)}ms`;
  const totalSeconds = value / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds - minutes * 60);
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/**
 * Elapsed milliseconds for the running-command marker: null while idle or
 * before the start timestamp. Pure so App.vue's 1s tick stays a thin re-render.
 */
export function runningCommandElapsedMs(startedAt: number | null | undefined, now: number): number | null {
  const start = Number(startedAt);
  if (!Number.isFinite(start) || start <= 0 || now < start) return null;
  return now - start;
}

export interface CommandMarkerTooltipLabels {
  command: string;
  exitCode: string;
  duration: string;
  directory: string;
}

export interface CommandMarkerTooltipInput {
  command?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  /** Elapsed while still running; used when durationMs is not final yet. */
  elapsedMs?: number | null;
  cwd?: string | null;
}

/**
 * Multi-line hover tooltip for the command marker strip: the full command,
 * the exit code once known, the duration (final or the live tick) and the
 * working directory. Pure; missing parts are omitted instead of rendering
 * placeholder noise.
 */
export function commandMarkerTooltip(marker: CommandMarkerTooltipInput, labels: CommandMarkerTooltipLabels): string {
  const lines: string[] = [];
  const command = String(marker.command || "").trim();
  if (command) lines.push(`${labels.command}: ${command}`);
  const exitCode = Number(marker.exitCode);
  if (Number.isFinite(exitCode) && marker.exitCode !== null && marker.exitCode !== undefined) {
    lines.push(`${labels.exitCode}: ${exitCode}`);
  }
  const durationMs = Number.isFinite(Number(marker.durationMs)) && marker.durationMs !== null && marker.durationMs !== undefined
    ? Number(marker.durationMs)
    : Number(marker.elapsedMs);
  if (Number.isFinite(durationMs) && durationMs >= 0) {
    lines.push(`${labels.duration}: ${formatCommandDuration(durationMs)}`);
  }
  const cwd = String(marker.cwd || "").trim();
  if (cwd) lines.push(`${labels.directory}: ${cwd}`);
  return lines.join("\n");
}
