import { ref } from "vue";
import {
  createStartupEntry,
  mergeStartupStore,
  normalizeStartupConfig,
  STARTUP_COMMAND_MAX,
  STARTUP_COMMANDS_STORE_KEY,
  STARTUP_DELAY_MAX_MS,
  STARTUP_DELAY_DEFAULT_MS,
  type StartupCommandEntry,
  type StartupCommandsConfig,
} from "../lib/startupCommands";
import { connectionEntryEquals, loadConnectionEntry, saveConnectionEntry } from "../lib/connectionSettingMirror";

/** 连接级启动命令（P0-4，Tabby「Login scripts」对标，自 SettingsDialog 纯搬
 * 移）：组件内自治 RPC 读写 sidecar 偏好（`startup_commands` 键按
 * connectionId 分桶，读改写合并只动本连接的桶）；shell 起来后按序注入，改动
 * 对新开会话生效。存储迁移批 2（IMPL_PLAN_STORAGE_SYNC）：镜像播种/收敛——
 * 条目缺失从 sidecar 播种；条目存在但与 sidecar 漂移（云同步恢复后）则
 * store 赢，推回 sidecar（复用读改写持久化）。行内增量改完即持久化
 * （@change 语义，非逐键）。 */
export function useStartupCommands(options: {
  connectionId: () => string | undefined;
  onError: (cause: unknown) => void;
}) {
  const { connectionId, onError } = options;

  const startupEnabled = ref(false);
  const startupCommands = ref<StartupCommandEntry[]>([]);

  async function loadStartupCommands() {
    const id = connectionId();
    if (!id) return;
    const mirrored = loadConnectionEntry(STARTUP_COMMANDS_STORE_KEY, id, normalizeStartupConfig);
    const apply = (config: StartupCommandsConfig) => {
      startupEnabled.value = config.enabled;
      startupCommands.value = config.commands;
    };
    try {
      const prefs = await window.dbxPlugin?.invoke<{ startup_commands?: unknown }>("local/preferences/get", {});
      const store = prefs?.startup_commands as Record<string, unknown> | undefined;
      const sidecar = normalizeStartupConfig(store?.[id]);
      if (mirrored === null) {
        apply(sidecar);
        saveConnectionEntry(STARTUP_COMMANDS_STORE_KEY, id, sidecar);
        return;
      }
      if (!connectionEntryEquals(mirrored, sidecar)) {
        apply(mirrored);
        await persistStartupConfig(mirrored);
        return;
      }
      apply(sidecar);
    } catch {
      // sidecar 不可用：镜像兜底（未迁移则维持空表，下次打开重试播种）。
      if (mirrored !== null) apply(mirrored);
    }
  }

  function applyStartupConfig(config: StartupCommandsConfig) {
    startupEnabled.value = config.enabled;
    startupCommands.value = config.commands;
  }

  /// 读改写合并：`local/preferences/set` 对 startup_commands 是整键替换，
  /// 其他连接的桶从最新偏好读回后原样保留。
  async function persistStartupConfig(config: StartupCommandsConfig) {
    const id = connectionId();
    if (!id) return;
    try {
      const prefs = await window.dbxPlugin?.invoke<{ startup_commands?: unknown }>("local/preferences/get", {});
      await window.dbxPlugin?.invoke("local/preferences/set", {
        startup_commands: mergeStartupStore(
          prefs?.startup_commands,
          id,
          config,
        ),
      });
    } catch (cause) {
      onError(cause);
    }
  }

  async function persistStartupCommands() {
    const id = connectionId();
    if (!id) return;
    const config: StartupCommandsConfig = { enabled: startupEnabled.value, commands: startupCommands.value };
    await persistStartupConfig(config);
    // 保存双写：RPC（sidecar 即时权威）+ 镜像（云同步载荷）。
    saveConnectionEntry(STARTUP_COMMANDS_STORE_KEY, id, config);
  }

  async function setStartupEnabled(next: boolean) {
    startupEnabled.value = next;
    // 开启且无命令时给一行空行，省一次点击；清空命令立即持久化。
    if (next && startupCommands.value.length === 0) startupCommands.value.push(createStartupEntry());
    await persistStartupCommands();
  }

  function addStartupEntry() {
    if (startupCommands.value.length >= STARTUP_COMMAND_MAX) return;
    startupCommands.value.push(createStartupEntry());
    void persistStartupCommands();
  }

  function removeStartupEntry(index: number) {
    startupCommands.value.splice(index, 1);
    void persistStartupCommands();
  }

  function moveStartupEntry(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= startupCommands.value.length) return;
    const [row] = startupCommands.value.splice(index, 1);
    startupCommands.value.splice(target, 0, row);
    void persistStartupCommands();
  }

  /** 行内增量（命令文本 / 延迟 / 启用）：改完即持久化（@change 语义，非逐键）。 */
  function updateStartupEntry(index: number, patch: Partial<StartupCommandEntry>) {
    const row = startupCommands.value[index];
    if (!row) return;
    Object.assign(row, patch);
    void persistStartupCommands();
  }

  /** 延迟输入收敛：空/非法回缺省 300ms，越界截断到 30s。 */
  function clampStartupDelayInput(raw: string): number {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return STARTUP_DELAY_DEFAULT_MS;
    return Math.min(parsed, STARTUP_DELAY_MAX_MS);
  }

  return {
    startupEnabled,
    startupCommands,
    loadStartupCommands,
    applyStartupConfig,
    setStartupEnabled,
    addStartupEntry,
    removeStartupEntry,
    moveStartupEntry,
    updateStartupEntry,
    clampStartupDelayInput,
  };
}
