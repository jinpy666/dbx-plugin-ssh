import { describe, expect, it } from "vitest";
import corpus from "../../../shared/prompt-corpus.json";
import {
  isAuthChallengeLine,
  isSelectionPromptLine,
} from "./interactivePromptGuard";
import { isPasswordPromptLine } from "./terminalPromptHints";

// shared/prompt-corpus.json 是前后端提示词词表的统一语料（backend/src/exec.rs
// 的 cargo test 加载同一份）：改任一侧词表必须同步语料文件，否则两侧之一在此
// 失败——防止单侧词表静默漂移（架构评审 WATCH）。

interface CorpusCase {
  text: string;
  backend: string;
  frontend: string[];
}

const matchers: Record<string, (text: string) => boolean> = {
  auth: isAuthChallengeLine,
  password: isPasswordPromptLine,
  selection: isSelectionPromptLine,
};

describe("shared prompt corpus (frontend side)", () => {
  const cases = (corpus as { cases: CorpusCase[] }).cases;

  it("has cases with known matcher names only", () => {
    for (const item of cases) {
      for (const name of item.frontend) {
        expect(matchers[name], `unknown matcher ${name} in ${item.text}`).toBeTypeOf("function");
      }
    }
  });

  it("frontend suppression matchers agree with the corpus", () => {
    for (const item of cases) {
      const actual = Object.entries(matchers)
        .filter(([, test]) => test(item.text))
        .map(([name]) => name)
        .sort();
      expect(actual, `case ${JSON.stringify(item.text)} diverges`).toEqual([...item.frontend].sort());
    }
  });
});
