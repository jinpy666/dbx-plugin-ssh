import { afterEach, describe, expect, it } from "vitest";
import { readWorkbenchUiMirror, writeWorkbenchUiMirror, WORKBENCH_UI_MIRROR_KEY, type WorkbenchUiMirror } from "./workbenchUiMirror";
import { pluginStore } from "./pluginStore";

describe("workbenchUiMirror (#178)", () => {
  afterEach(() => {
    pluginStore.removeItem(WORKBENCH_UI_MIRROR_KEY);
  });

  it("round-trips the layout subset through the single mirror key", () => {
    const state = {
      followDirectory: true,
      sudoMode: false,
      splitRatio: 62,
      paneOrder: "sftp-left" as const,
      sftpPaneOpen: true,
      visibleColumns: ["size", "modified"],
      columnsV2: true,
      sftpColumnWidths: { size: 140 },
      sftpNameWidth: 320,
      sftpShowHidden: true,
      sftpSort: { column: "modified" as string, direction: "desc" as const },
    };
    writeWorkbenchUiMirror(state);
    expect(readWorkbenchUiMirror()).toEqual(state);
    // 单键形态：镜像整体是一份 JSON，不产生额外键。
    expect(pluginStore.getItem(WORKBENCH_UI_MIRROR_KEY)).toContain('"splitRatio":62');
  });

  it("never persists an SFTP path (cross-workbench leakage)", () => {
    writeWorkbenchUiMirror({ followDirectory: true } as WorkbenchUiMirror);
    const raw = pluginStore.getItem(WORKBENCH_UI_MIRROR_KEY) ?? "";
    expect(raw).not.toContain("sftpPath");
  });

  it("returns an empty object on absent or corrupt records", () => {
    expect(readWorkbenchUiMirror()).toEqual({});
    pluginStore.setItem(WORKBENCH_UI_MIRROR_KEY, "not-json{{{");
    expect(readWorkbenchUiMirror()).toEqual({});
  });
});
