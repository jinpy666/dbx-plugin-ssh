// 终端行为文案聚合：七语按 locale 分片（各文件 ~118 行），本文件只做组装。
// 键集/占位符一致性由 workbench.spec 与 i18nKeyReferences.spec 双向校验。

import { terminalBehavioren } from "./terminal-behavior/en";
import { terminalBehaviorzhCN } from "./terminal-behavior/zh-cn";
import { terminalBehaviorzhTW } from "./terminal-behavior/zh-tw";
import { terminalBehaviores } from "./terminal-behavior/es";
import { terminalBehaviorit } from "./terminal-behavior/it";
import { terminalBehaviorja } from "./terminal-behavior/ja";
import { terminalBehaviorptBR } from "./terminal-behavior/pt-br";

export const terminalBehaviorMessages: Record<string, Record<string, string>> = {
  en: terminalBehavioren,
  "zh-CN": terminalBehaviorzhCN,
  "zh-TW": terminalBehaviorzhTW,
  es: terminalBehaviores,
  it: terminalBehaviorit,
  ja: terminalBehaviorja,
  "pt-BR": terminalBehaviorptBR,
};
