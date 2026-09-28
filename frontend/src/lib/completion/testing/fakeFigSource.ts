// FigCompletionSource 的测试/开发桩（FIG wave-1 Lane A'，细则 §2.1/§2.3）：
// 真实实现由 Lane C'（vendored amazon-q parser + 全量语料）在集成分支接入；
// 本文件只服务两处——
//   1. CompletionController / CompletionMenu 的单测（确定性、无 IO）；
//   2. dev 构建（import.meta.env.DEV）下的手动验证清单：git ch<Tab> 静态
//      候选、git co<Tab> 别名命中、无命中 Tab 透传。生产构建恒为
//      pass-through source（返回 null，零浮层），PTY 链路零影响。
//
// 覆盖面刻意极小（两层层级 + 别名 + flag 前缀），不做嵌套/generator——
// generator 动态位置必须返回 null（调用方 pass-through，Tab 交还 shell），
// 这正是冻结接缝 source.ts 的约定；此处同时是对该约定的行为示范。

import type { CompletionItem, CompletionItemKind, CompletionResponse } from "../core/types";
import { splitCommandLine } from "../core/tokenize";
import { trailingTokenEdit } from "../core/edit";
import type { FigCompletionSource, FigSourceRequest } from "../fig/source";

/** dev 手动清单用的极小语料：命令 → 子命令（含别名）→ flag。 */
interface FakeCommandSpec {
  subcommands: Array<{ name: string; description: string; aliases?: string[] }>;
  options: Array<{ name: string; description: string }>;
}

const FAKE_MANIFEST: Record<string, FakeCommandSpec> = {
  git: {
    subcommands: [
      { name: "checkout", description: "Switch branches or restore working tree files", aliases: ["co"] },
      { name: "cherry", description: "Find commits yet to be applied upstream" },
      { name: "cherry-pick", description: "Apply the changes introduced by existing commits" },
      { name: "commit", description: "Record changes to the repository", aliases: ["ci"] },
      { name: "config", description: "Get and set repository or global options" },
      { name: "status", description: "Show the working tree status" },
      { name: "stash", description: "Stash the changes in a dirty working directory away" },
    ],
    options: [
      { name: "--branch", description: "Create a new branch (-b)" },
      { name: "--force", description: "Force the operation" },
      { name: "--verbose", description: "Show more details" },
    ],
  },
  docker: {
    subcommands: [
      { name: "container", description: "Manage containers" },
      { name: "image", description: "Manage images" },
      { name: "ps", description: "List containers" },
      { name: "run", description: "Run a command in a new container" },
    ],
    options: [{ name: "--rm", description: "Automatically remove the container when it exits" }],
  },
  kubectl: {
    subcommands: [
      { name: "get", description: "Display one or many resources" },
      { name: "apply", description: "Apply a configuration to a resource by file name or stdin" },
      { name: "logs", description: "Print the logs for a container in a pod" },
    ],
    options: [{ name: "--namespace", description: "Limit output to a namespace (-n)" }],
  },
};

/** 当前正在补的词：行尾非空白段的 [start, end)；行尾空白 → 行尾空 token。 */
function trailingWordRange(line: string): { word: string; start: number; end: number } {
  const trailing = /\S+$/.exec(line);
  if (!trailing) return { word: "", start: line.length, end: line.length };
  return { word: trailing[0], start: trailing.index, end: line.length };
}

function item(id: string, label: string, description: string, kind: CompletionItemKind, score: number, line: string): CompletionItem {
  return { id, label, description, kind, score, source: "fake-fig", edit: trailingTokenEdit(line, label, true) };
}

/**
 * 伪 fig 引擎（确定性）：
 * - 空 / 未命中命令 / 第 1 个参数之后的更深位置 → null（pass-through）；
 * - 顶层词前缀 → command 候选；命令后首词 → 子命令候选（含别名展开）；
 * - "-" / "--" 前缀 → flag 候选；任何异常 → null（接口契约）。
 */
export class FakeFigCompletionSource implements FigCompletionSource {
  readonly id = "fake-fig";

  resolve(request: FigSourceRequest): CompletionResponse | null {
    try {
      const { tokens, trailingSpace } = splitCommandLine(request.line);
      if (tokens.length === 0) return null;
      const items: CompletionItem[] = [];
      if (tokens.length === 1 && !trailingSpace) {
        // 顶层命令词前缀（gi → git）。
        const { word } = trailingWordRange(request.line);
        for (const name of Object.keys(FAKE_MANIFEST)) {
          if (name.startsWith(word)) items.push(item(`fake:cmd:${name}`, name, "dev fake command", "command", 100, request.line));
        }
      } else {
        const commandToken = tokens[0].text;
        const spec = FAKE_MANIFEST[commandToken];
        if (!spec) return null;
        // 仅命令后的第 1 个参数槽（slot 0）；更深的参数位置属 generator
        // 领域 → null（pass-through，Tab 交还 shell）。
        const slot = trailingSpace ? tokens.length - 1 : tokens.length - 2;
        if (slot !== 0) return null;
        const { word } = trailingWordRange(request.line);
        if (word.startsWith("-")) {
          for (const option of spec.options) {
            if (option.name.startsWith(word)) {
              items.push(item(`fake:opt:${option.name}`, option.name, option.description, "option", 60, request.line));
            }
          }
        } else {
          for (const sub of spec.subcommands) {
            const aliasHit = sub.aliases?.some((alias) => alias.startsWith(word)) ?? false;
            if (sub.name.startsWith(word) || aliasHit) {
              // 别名命中展开为子命令本体（git co<Tab> → checkout，手动清单用例）。
              items.push(item(`fake:sub:${sub.name}`, sub.name, sub.description, "subcommand", aliasHit ? 90 : 100, request.line));
            }
          }
        }
      }
      if (!items.length) return null;
      const { start, end } = trailingWordRange(request.line);
      const response: CompletionResponse = {
        requestId: request.requestId,
        revision: request.revision,
        state: "ready",
        context: { command: tokens[0].text, commandPath: [tokens[0].text], tokenStart: start, tokenEnd: end },
        items,
      };
      return response;
    } catch {
      return null;
    }
  }
}

/** 生产批次 1 的占位 source：恒 pass-through（Lane C' 集成后由真实实现替换）。 */
export function createPassThroughFigSource(): FigCompletionSource {
  return { id: "pass-through", resolve: () => null };
}
