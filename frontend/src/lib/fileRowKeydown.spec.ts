// decideFileRowAction 单测（UI_SCAN R3-P2-5）：文件行键盘语义——Enter 打开
// 任意模式可用，F2/Delete 仅可写连接，其余按键不拦截。
import { describe, expect, it } from "vitest";
import { decideFileRowAction, decideSftpPaneAction } from "./fileRowKeydown";

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

// decideSftpPaneAction 单测（issue #337）：SFTP 面板级快捷键——行级 F2/Delete
// 只在行持有焦点时生效，面板级补齐空白/工具栏焦点场景。F2 仅单选生效；
// Delete 单选走单项确认、多选走批量确认；只读连接与空选不接管。
describe("decideSftpPaneAction", () => {
  it("renames exactly one selected entry with F2", () => {
    expect(decideSftpPaneAction("F2", true, 1)).toBe("rename");
    expect(decideSftpPaneAction("F2", true, 2)).toBeNull();
    expect(decideSftpPaneAction("F2", true, 0)).toBeNull();
  });

  it("routes Delete by selection size (single vs batch)", () => {
    expect(decideSftpPaneAction("Delete", true, 1)).toBe("delete-single");
    expect(decideSftpPaneAction("Delete", true, 3)).toBe("delete-multi");
  });

  it("ignores empty selections and read-only connections", () => {
    expect(decideSftpPaneAction("Delete", true, 0)).toBeNull();
    expect(decideSftpPaneAction("F2", false, 1)).toBeNull();
    expect(decideSftpPaneAction("Delete", false, 1)).toBeNull();
  });

  it("leaves every other key untouched", () => {
    expect(decideSftpPaneAction("Enter", true, 1)).toBeNull();
    expect(decideSftpPaneAction("Backspace", true, 1)).toBeNull();
    expect(decideSftpPaneAction("ArrowDown", true, 1)).toBeNull();
  });
});
