// SFTP 侧栏目录树状态（对标 files 插件 lib/dirTree.ts）：懒加载子目录的
// 纯函数模型，无 Vue 依赖便于单测；Vue 侧持 reactive 根节点，加载后原地
// 变更 children/expanded 触发更新。
export interface DirTreeNode {
  path: string;
  name: string;
  /** 子目录是否展开；collapse 只翻标记，children 缓存保留。 */
  expanded: boolean;
  /** 子目录列表是否已拉取（侧栏刷新用 markTreeStale 重置）。 */
  loaded: boolean;
  loading: boolean;
  children: DirTreeNode[];
}

/** 根节点（连接根目录 "/"）；name 传 "/"，展示层用本地化文案替换。 */
export function createTreeRoot(path: string, name = "/"): DirTreeNode {
  return { path, name, expanded: false, loaded: false, loading: false, children: [] };
}

/** 按路径精确查找节点（侧栏目录数有限，DFS 足够）。 */
export function findTreeNode(root: DirTreeNode, path: string): DirTreeNode | null {
  if (root.path === path) return root;
  for (const child of root.children) {
    const hit = findTreeNode(child, path);
    if (hit) return hit;
  }
  return null;
}

/** sftp/list 结果 → 子节点：仅目录（树内不显示文件）、按名称排序。 */
export function childTreeNodes(entries: Array<{ path: string; name: string; kind: string }>): DirTreeNode[] {
  return entries
    .filter((entry) => entry.kind === "directory")
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => createTreeRoot(entry.path, entry.name));
}

/**
 * 挂子节点并展开父节点；父节点已不在树中（加载返回时树被刷新重建的竞态）
 * 返回 null 由调用方丢弃。
 */
export function applyTreeChildren(
  root: DirTreeNode,
  parentPath: string,
  entries: Array<{ path: string; name: string; kind: string }>,
): DirTreeNode | null {
  const parent = findTreeNode(root, parentPath);
  if (!parent) return null;
  parent.children = childTreeNodes(entries);
  parent.loaded = true;
  parent.loading = false;
  parent.expanded = true;
  return parent;
}

/** 递归标记整棵树未加载（侧栏刷新按钮）：子节点待下次展开时重拉。 */
export function markTreeStale(root: DirTreeNode): void {
  root.loaded = false;
  for (const child of root.children) markTreeStale(child);
}
