/**
 * 危险命令检测：粘贴进终端前触发红色危险二次确认。
 * 规则对齐 tiny-rdm `frontend/src/modules/ssh/dangerous-commands.js`：尽量精确，
 * 避免误杀正常命令（如 `rm foo.tmp`），仅命中带破坏性参数或目标的形态。
 * `label` 是语言无关的命令片段，直接展示在确认弹窗中。
 */

export interface DangerousCommandPattern {
  id: string;
  label: string;
  re: RegExp;
}

export type DangerousCommandLevel = "none" | "danger";

export interface DangerousCommandHit {
  id: string;
  label: string;
}

export interface DangerousCommandInspection {
  level: DangerousCommandLevel;
  hits: DangerousCommandHit[];
}

export const DANGEROUS_COMMAND_PATTERNS: DangerousCommandPattern[] = [
  { id: "rm-rf", label: "rm -rf", re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-rf|-fr|--recursive\s+--force|--force\s+--recursive)\b/i },
  { id: "rm-slash", label: "rm … /", re: /\brm\s[^\n]*\s\/(\s|$)/i },
  { id: "dd-of-device", label: "dd of=/dev/…", re: /\bdd\s+[^\n]*\bof=\/dev\/(sd|nvme|hd|xvd|disk|mmcblk|vd)\w*/i },
  { id: "mkfs", label: "mkfs", re: /\bmkfs(\.[a-z0-9]+)?\b/i },
  { id: "shutdown", label: "shutdown / reboot", re: /\b(shutdown|halt|poweroff|reboot|init\s+0|init\s+6|systemctl\s+(poweroff|reboot|halt))\b/i },
  { id: "fork-bomb", label: ":(){ :|:& };:", re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&?\s*\}\s*;\s*:/ },
  { id: "chmod-777-recur", label: "chmod -R 777", re: /\bchmod\s+-R\s+(?:0?[67]77|a[+=]rwx|\+rwx)/i },
  { id: "chown-root-recur", label: "chown -R … /", re: /\bchown\s+-R\s+\S+\s+\/(\s|$)/i },
  { id: "curl-pipe-shell", label: "curl|wget … | sh", re: /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh|ksh)\b/i },
  { id: "iptables-flush", label: "iptables -F", re: /\biptables\s+(-F|--flush)\b/i },
  { id: "history-clear", label: "history -c", re: /\bhistory\s+-c\b/i },
  { id: "crontab-remove", label: "crontab -r", re: /\bcrontab\s+-r\b/i },
  { id: "destructive-sql", label: "DROP DATABASE/TABLE", re: /\b(drop\s+(database|schema|table)|truncate\s+table)\b/i },
  { id: "kill-init", label: "kill 1 / kill -9 -1", re: /\bkill\s+(-9\s+)?-?1\b/ },
];

/** 检查文本是否命中危险命令，返回风险级别与命中项；未命中时 level 为 "none"。 */
export function inspect(text: string): DangerousCommandInspection {
  const trimmed = typeof text === "string" ? text.trim() : "";
  const hits: DangerousCommandHit[] = [];
  if (trimmed) {
    for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
      if (pattern.re.test(trimmed)) hits.push({ id: pattern.id, label: pattern.label });
    }
  }
  return { level: hits.length ? "danger" : "none", hits };
}

const PASTE_NEWLINE_RE = /\r\n|\r|\n/;
const PASTE_CONFIRM_CHAR_THRESHOLD = 200;
const PASTE_PREVIEW_LIMIT = 400;

export interface PasteConfirmation {
  text: string;
  lines: number;
  chars: number;
  preview: string;
  danger: boolean;
  hits: DangerousCommandHit[];
  required: boolean;
}

/**
 * 评估一段待粘贴文本：多行、超过字符阈值或命中危险命令时需要确认。
 * `required` 为 false 时调用方可直接粘贴，无需弹窗。
 */
export function buildPasteConfirmation(text: string): PasteConfirmation {
  const inspection = inspect(text);
  const danger = inspection.level === "danger";
  const multiLine = PASTE_NEWLINE_RE.test(text);
  const large = text.length >= PASTE_CONFIRM_CHAR_THRESHOLD;
  return {
    text,
    lines: text.split(PASTE_NEWLINE_RE).length,
    chars: text.length,
    preview: text.length <= PASTE_PREVIEW_LIMIT ? text : `${text.slice(0, PASTE_PREVIEW_LIMIT)}…`,
    danger,
    hits: inspection.hits,
    required: danger || multiLine || large,
  };
}
