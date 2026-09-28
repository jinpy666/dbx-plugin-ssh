// 命令行 token 切分（冻结）：自退役的 legacy spec.ts 上移，作为 legacy
// spec 目录退役后的公共依赖（fig source 与 controller 共用）。语义与原实现
// 逐字一致：空白分隔；单引号内全字面；双引号与引号外支持反斜杠转义；
// 裸 "--" 是 flag 终结符；空 token 只有显式 '' 会产生。

export interface CommandToken {
  /** 语义内容（引号已剥、转义已解）。 */
  text: string;
  /** 是否 flag token（以 - 开头、非裸 "--"、且未被 -- 终结符关闭）。 */
  isFlag: boolean;
  /** token 是否整体（或部分）处于引号内——引号内空格不切分。 */
  quoted: boolean;
  /** 裸 "--" 终结符：本身不参与候选，仅对后续 token 关闭 flag 解析。 */
  terminator: boolean;
}

export interface SplitCommandLineResult {
  tokens: CommandToken[];
  /** 行尾是裸空白（引号外）：当前正在敲一个空 token。 */
  trailingSpace: boolean;
  /** 已出现裸 "--" 终结符：其后 token 一律不算 flag。 */
  terminated: boolean;
}

export function splitCommandLine(line: string): SplitCommandLineResult {
  const tokens: CommandToken[] = [];
  let current: { text: string; quoted: boolean } | null = null;
  let trailingSpace = false;
  let terminated = false;

  const pushCurrent = () => {
    if (!current) return;
    if (current.text === "--" && !current.quoted && !terminated) {
      tokens.push({ text: current.text, isFlag: false, quoted: false, terminator: true });
      terminated = true;
    } else {
      tokens.push({ text: current.text, isFlag: !terminated && current.text.startsWith("-") && current.text !== "-", quoted: current.quoted, terminator: false });
    }
    current = null;
  };

  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (const char of line) {
    if (inSingle) {
      if (char === "'") {
        inSingle = false;
      } else {
        current ??= { text: "", quoted: false };
        current.text += char;
        current.quoted = true;
      }
      continue;
    }
    if (escaped) {
      current ??= { text: "", quoted: false };
      current.text += char;
      current.quoted = true;
      escaped = false;
      continue;
    }
    if (inDouble) {
      if (char === "\\") {
        escaped = true;
        current ??= { text: "", quoted: true };
        current.quoted = true;
      } else if (char === '"') {
        inDouble = false;
        if (current) current.quoted = true;
      } else if (char === " " || char === "\t") {
        current ??= { text: "", quoted: true };
        current.text += char;
        current.quoted = true;
      } else {
        current ??= { text: "", quoted: true };
        current.text += char;
      }
      continue;
    }
    if (char === "'") {
      current ??= { text: "", quoted: false };
      current.quoted = true;
      inSingle = true;
      continue;
    }
    if (char === '"') {
      current ??= { text: "", quoted: false };
      current.quoted = true;
      inDouble = true;
      continue;
    }
    if (char === "\\") {
      current ??= { text: "", quoted: false };
      current.quoted = true;
      escaped = true;
      continue;
    }
    if (char === " " || char === "\t") {
      pushCurrent();
      trailingSpace = true;
      continue;
    }
    current ??= { text: "", quoted: false };
    current.text += char;
    trailingSpace = false;
  }
  if (escaped) {
    current ??= { text: "", quoted: false };
    current.text += "\\";
  }
  pushCurrent();
  return { tokens, trailingSpace, terminated };
}
