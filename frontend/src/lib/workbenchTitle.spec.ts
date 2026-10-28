import { describe, expect, it, vi } from "vitest";
import { createWorkbenchTitleSync, readListedConnectionName } from "./workbenchTitle";

describe("workbenchTitle", () => {
  it("reads the current connection name from host and mock list payloads", () => {
    const connections = [
      { id: "other", name: "Other" },
      { id: "conn-1", name: "Renamed server" },
    ];
    expect(readListedConnectionName(connections, "conn-1")).toBe("Renamed server");
    expect(readListedConnectionName({ connections }, "conn-1")).toBe("Renamed server");
    expect(readListedConnectionName(connections, "missing")).toBe("");
    expect(readListedConnectionName(null, "conn-1")).toBe("");
  });

  it("updates the host tab title and preserves its session number across renames", async () => {
    const getTitle = vi.fn(async () => "Old name (2)");
    const setTitle = vi.fn(async () => undefined);
    const sync = createWorkbenchTitleSync({ capabilities: { workbenchTitle: true }, getTitle, setTitle });

    await sync("New name");
    await sync("New name again");

    expect(getTitle).toHaveBeenCalledTimes(1);
    expect(setTitle.mock.calls).toEqual([["New name (2)"], ["New name again (2)"]]);
  });

  it("only applies the latest name when the initial title read is pending", async () => {
    let resolveTitle = (title: string) => { void title; };
    const getTitle = vi.fn(() => new Promise<string>((resolve) => { resolveTitle = resolve; }));
    const setTitle = vi.fn(async () => undefined);
    const sync = createWorkbenchTitleSync({ capabilities: { workbenchTitle: true }, getTitle, setTitle });

    const first = sync("First");
    const second = sync("Latest");
    resolveTitle("Original (1)");
    await Promise.all([first, second]);

    expect(setTitle).toHaveBeenCalledTimes(1);
    expect(setTitle).toHaveBeenCalledWith("Latest (1)");
  });

  it("keeps document-title fallback behavior on hosts without the title API", async () => {
    const setTitle = vi.fn(async () => undefined);
    const sync = createWorkbenchTitleSync({ setTitle });
    await sync("New name");
    expect(setTitle).not.toHaveBeenCalled();
  });

  it("still sets the base name when reading the current title fails", async () => {
    const setTitle = vi.fn(async () => undefined);
    const sync = createWorkbenchTitleSync({
      capabilities: { workbenchTitle: true },
      getTitle: async () => { throw new Error("unavailable"); },
      setTitle,
    });
    await sync("New name");
    expect(setTitle).toHaveBeenCalledWith("New name");
  });
});
