import { computed, reactive, ref, type Ref } from "vue";
import { pluginStore } from "../lib/pluginStore";
import { pushPathHistory, sanitizePathHistories } from "../lib/sftpPathHistory";

/** SFTP 路径历史（每连接最多 10 条，pluginStore 持久化；对齐 tiny-rdm pathHistory）。
 * 路径弹层打开时的书签刷新兜底仍在 App.vue（与书签域共用 watch）。 */
export function useSftpPathHistory(options: { connectionId: Ref<string>; closeToolbarPopovers: () => void }) {
  const { connectionId, closeToolbarPopovers } = options;

const SFTP_PATH_HISTORY_KEY = "sftp-path-history";
const SFTP_PATH_HISTORY_LIMIT = 10;

const pathHistoryOpen = ref(false);
const pathHistories = reactive<Record<string, string[]>>(loadPathHistories());

const currentPathHistory = computed(() => pathHistories[connectionId.value] || []);

function loadPathHistories(): Record<string, string[]> {
  try {
    const raw = pluginStore.getItem(SFTP_PATH_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return sanitizePathHistories(parsed, SFTP_PATH_HISTORY_LIMIT);
  } catch {
    return {};
  }
}

function persistPathHistories() {
  try {
    pluginStore.setItem(SFTP_PATH_HISTORY_KEY, JSON.stringify(pathHistories));
  } catch {
    // localStorage 不可用时路径历史仅保留在内存中。
  }
}

function rememberPathHistory(path: string) {
  const key = connectionId.value;
  if (!key || !path) return;
  const next = pushPathHistory(pathHistories, key, path, SFTP_PATH_HISTORY_LIMIT);
  for (const connection of Object.keys(next)) pathHistories[connection] = next[connection];
  persistPathHistories();
}

function togglePathHistoryMenu() {
  const next = !pathHistoryOpen.value;
  closeToolbarPopovers();
  pathHistoryOpen.value = next;
}


  return {
    pathHistoryOpen,
    pathHistories,
    currentPathHistory,
    rememberPathHistory,
    togglePathHistoryMenu,
  };
}
