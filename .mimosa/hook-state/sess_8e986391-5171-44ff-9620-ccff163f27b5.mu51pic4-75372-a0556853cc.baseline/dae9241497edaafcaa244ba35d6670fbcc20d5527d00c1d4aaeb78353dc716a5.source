// decideFileRowAction 单测（UI_SCAN R3-P2-5）：文件行键盘语义——Enter 打开
// 任意模式可用，F2/Delete 仅可写连接，其余按键不拦截。
import { describe, expect, it } from "vitest";
import { decideFileRowAction } from "./fileRowKeydown";

describe("decideFileRowAction", () => {
  it("opens on Enter in any mode", () => {
    expect(decideFileRowAction("Enter", true)).toBe("open");
    expect(decideFileRowAction("Enter", false)).toBe("open");
  });

  it("renames with F2 only on writable connections", () => {
    expect(decideFileRowAction("F2", true)).toBe("rename");
    expect(decideFileRowAction("F2", false)).toBeNull();
  });

  it("deletes with Delete only on writable connections", () => {
    expect(decideFileRowAction("Delete", true)).toBe("delete");
    expect(decideFileRowAction("Delete", false)).toBeNull();
  });

  it("leaves every other key untouched", () => {
    expect(decideFileRowAction(" ", true)).toBeNull();
    expect(decideFileRowAction("ArrowDown", true)).toBeNull();
    expect(decideFileRowAction("a", true)).toBeNull();
    expect(decideFileRowAction("Backspace", true)).toBeNull();
  });
});
