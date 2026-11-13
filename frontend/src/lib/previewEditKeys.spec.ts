import { describe, expect, it } from "vitest";
import { previewEditKeyAction } from "./previewEditKeys";

describe("previewEditKeyAction", () => {
  it("maps Ctrl+S and Cmd+S to save", () => {
    expect(previewEditKeyAction({ key: "s", ctrlKey: true })).toBe("save");
    expect(previewEditKeyAction({ key: "s", metaKey: true })).toBe("save");
    expect(previewEditKeyAction({ key: "S", ctrlKey: true })).toBe("save");
  });

  it("maps bare Esc to exit", () => {
    expect(previewEditKeyAction({ key: "Escape" })).toBe("exit");
  });

  it("ignores modified shortcuts that belong to the OS/browser", () => {
    expect(previewEditKeyAction({ key: "s", ctrlKey: true, shiftKey: true })).toBeNull();
    expect(previewEditKeyAction({ key: "s", ctrlKey: true, altKey: true })).toBeNull();
    expect(previewEditKeyAction({ key: "Escape", ctrlKey: true })).toBeNull();
    expect(previewEditKeyAction({ key: "Escape", metaKey: true })).toBeNull();
  });

  it("lets ordinary typing and other shortcuts through", () => {
    expect(previewEditKeyAction({ key: "s" })).toBeNull();
    expect(previewEditKeyAction({ key: "x", ctrlKey: true })).toBeNull();
    expect(previewEditKeyAction({ key: "Tab" })).toBeNull();
  });
});
