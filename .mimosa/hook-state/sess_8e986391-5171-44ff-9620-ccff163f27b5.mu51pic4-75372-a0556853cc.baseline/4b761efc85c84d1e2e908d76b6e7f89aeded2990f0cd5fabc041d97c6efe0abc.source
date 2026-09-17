import { describe, expect, it } from "vitest";
import { applyTreeChildren, childTreeNodes, createTreeRoot, findTreeNode, markTreeStale } from "./sftpDirTree";

const entries = [
  { path: "/b", name: "b", kind: "directory" },
  { path: "/a.txt", name: "a.txt", kind: "file" },
  { path: "/a", name: "a", kind: "directory" },
];

describe("sftp dir tree", () => {
  it("maps directory entries to sorted lazy child nodes", () => {
    const nodes = childTreeNodes(entries);
    expect(nodes.map((node) => node.name)).toEqual(["a", "b"]);
    expect(nodes[0]).toEqual({ path: "/a", name: "a", expanded: false, loaded: false, loading: false, children: [] });
  });

  it("applies children to the parent and expands it", () => {
    const root = createTreeRoot("/");
    const parent = applyTreeChildren(root, "/", entries);
    expect(parent?.expanded).toBe(true);
    expect(parent?.loaded).toBe(true);
    expect(findTreeNode(root, "/a")?.name).toBe("a");
    expect(findTreeNode(root, "/missing")).toBeNull();
  });

  it("drops apply results whose parent left the tree", () => {
    const root = createTreeRoot("/");
    applyTreeChildren(root, "/", entries);
    expect(applyTreeChildren(root, "/gone", entries)).toBeNull();
  });

  it("marks the whole tree stale while keeping structure", () => {
    const root = createTreeRoot("/");
    applyTreeChildren(root, "/", entries);
    applyTreeChildren(root, "/a", entries);
    markTreeStale(root);
    expect(root.loaded).toBe(false);
    expect(root.expanded).toBe(true);
    const child = findTreeNode(root, "/a");
    expect(child?.loaded).toBe(false);
    expect(child?.children).toHaveLength(2);
  });
});
