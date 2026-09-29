import { computed, ref, watch, type Ref } from "vue";
import { pluginStore } from "../lib/pluginStore";
import type { SftpSideQuickPath } from "../components/SideNavPanel.vue";
import type { SftpEntryKind } from "../lib/sftpEntries";
import { applyTreeChildren, createTreeRoot, markTreeStale, type DirTreeNode } from "../lib/sftpDirTree";

/** SFTP 侧栏（tree/quick 双 tab）：形态偏好持久化、目录树懒加载与刷新、
 * 快捷路径清单（home 探测置顶）。侧栏行右键菜单的打开/动作仍在 App.vue。 */
export function useSftpSidebar(options: {
  t: (key: string, values?: Record<string, string | number>) => string;
  showError: (cause: unknown, target?: "terminal" | "sftp") => void;
  session: Ref<{ sessionId?: string } | undefined>;
  sudoMode: Ref<boolean>;
  sftpHomePath: Ref<string>;
  sftpShowHidden: Ref<boolean>;
  pathFromUri: (uri: string) => string;
}) {
  const { t, showError, session, sudoMode, sftpHomePath, sftpShowHidden, pathFromUri } = options;

// 目录列表行的最小结构（App.vue 的 SftpEntry 为局部接口，这里按消费字段收敛）。
type SideDirEntry = { uri: string; name: string; kind: SftpEntryKind };

const SFTP_QUICK_PATHS = ["/", "/home", "/tmp", "/etc", "/var", "/root"];
// 侧栏形态偏好：tree/quick tab（默认 tree）与收起状态，pluginStore 全局持久化。
const SFTP_SIDE_TAB_KEY = "ssh-sftp-side-tab";
const SFTP_SIDE_COLLAPSED_KEY = "ssh-sftp-side-collapsed";

// 侧栏导航形态偏好：tree（目录树，默认）/ quick（快捷路径）+ 收起状态。
const sftpSideTab = ref<"tree" | "quick">(loadSftpSideTab());
const sftpSideCollapsed = ref(loadSftpSideCollapsed());
// 侧栏目录树：根 = 连接根 "/"，展开时经 sftp/list 懒加载子目录（仅目录）。
const sftpTree = ref<DirTreeNode>(createTreeRoot("/", "/"));

/** showHidden 切换后侧栏树缓存失效——下次展开节点时重新拉取、按新可见性过滤。 */
watch(sftpShowHidden, () => {
  markTreeStale(sftpTree.value);
});

// ---- SFTP 侧栏（tree/quick 双 tab）--------------------------------------------

/** quick tab 条目：home 探测结果置顶 + SFTP_QUICK_PATHS 静态列表（去重）。 */
const sideQuickPaths = computed<SftpSideQuickPath[]>(() => {
  const list: SftpSideQuickPath[] = [];
  if (sftpHomePath.value) list.push({ path: sftpHomePath.value, label: t("home"), home: true });
  for (const path of SFTP_QUICK_PATHS) {
    if (!list.some((item) => item.path === path)) list.push({ path, label: path });
  }
  return list;
});

/** 侧栏树懒加载：collapse 只翻标记保留缓存；未加载时拉 sftp/list 挂子节点。 */
async function expandSideTreeNode(node: DirTreeNode) {
  if (node.expanded) {
    node.expanded = false;
    return;
  }
  if (!node.loaded) {
    if (!session.value) return;
    node.loading = true;
    try {
      const result = await window.dbxPlugin.invoke<{ entries: SideDirEntry[] }>(sudoMode.value ? "sudo/listDir" : "sftp/list", {
        sessionId: session.value.sessionId,
        path: node.path,
      });
      applyTreeChildren(sftpTree.value, node.path, result.entries.map((entry) => ({ path: pathFromUri(entry.uri), name: entry.name, kind: entry.kind })), sftpShowHidden.value);
    } catch (cause) {
      showError(cause); // 树展开失败要有反馈，不能静默（对标 files 插件 P-FILES 反馈）
    } finally {
      node.loading = false;
    }
    return;
  }
  node.expanded = true;
}

/** tree tab 可见时确保根已展开（未连接时跳过，接通后由 afterSessionConnected 触发）。 */
function ensureSideTreeRoot() {
  if (sftpSideTab.value !== "tree" || !session.value) return;
  const root = sftpTree.value;
  if (!root.loaded && !root.loading) void expandSideTreeNode(root);
}

/** 侧栏刷新按钮：整树标记重拉后重展开根。 */
function refreshSideTree() {
  const root = sftpTree.value;
  markTreeStale(root);
  root.expanded = false;
  void expandSideTreeNode(root);
}


// 侧栏形态偏好：pluginStore 全局持久化（不可用时仅当前会话生效，默认 tree/展开）。
function loadSftpSideTab(): "tree" | "quick" {
  try {
    return pluginStore.getItem(SFTP_SIDE_TAB_KEY) === "quick" ? "quick" : "tree";
  } catch {
    return "tree";
  }
}

function loadSftpSideCollapsed(): boolean {
  try {
    return pluginStore.getItem(SFTP_SIDE_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

function persistSftpSideShape() {
  try {
    pluginStore.setItem(SFTP_SIDE_TAB_KEY, sftpSideTab.value);
    pluginStore.setItem(SFTP_SIDE_COLLAPSED_KEY, sftpSideCollapsed.value ? "true" : "false");
  } catch {
    // localStorage 不可用时偏好仅对当前会话生效。
  }
}

function setSftpSideTab(tab: "tree" | "quick") {
  sftpSideTab.value = tab;
  persistSftpSideShape();
  if (tab === "tree") ensureSideTreeRoot();
}

function setSftpSideCollapsed(collapsed: boolean) {
  sftpSideCollapsed.value = collapsed;
  persistSftpSideShape();
}


  return {
    SFTP_QUICK_PATHS,
    sftpSideTab,
    sftpSideCollapsed,
    sftpTree,
    sideQuickPaths,
    expandSideTreeNode,
    ensureSideTreeRoot,
    refreshSideTree,
    setSftpSideTab,
    setSftpSideCollapsed,
  };
}
