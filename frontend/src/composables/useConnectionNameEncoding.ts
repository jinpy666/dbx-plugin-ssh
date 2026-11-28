import { ref } from "vue";
import {
  choiceFromOverride,
  mergeNameEncodingStore,
  NAME_ENCODING_OVERRIDES_STORE_KEY,
  normalizeNameEncodingOverride,
  overrideFromChoice,
  type ConnectionNameEncodingChoice,
  type NameEncodingOverride,
} from "../lib/connectionNameEncoding";
import { loadConnectionEntry, saveConnectionEntry } from "../lib/connectionSettingMirror";

/** 连接级 SFTP 文件名编码（M16，自 SettingsDialog 纯搬移）：覆盖全局
 * `sftp_name_encoding`——缺省「跟随全局」且不落盘（删除本连接桶）；连接未
 * 覆盖时全局 `sftp_name_encoding` 生效，判定优先级在 sidecar（覆盖 > 全局 >
 * auto）。镜像条目值与 sidecar 同形（"auto"/"latin-1"/null=跟随全局），播种/
 * 收敛语义同启动命令；读改写合并（`local/preferences/set` 对该键是整表替换，
 * 其他连接的桶从最新偏好读回后原样保留）。 */
export function useConnectionNameEncoding(options: {
  connectionId: () => string | undefined;
  onError: (cause: unknown) => void;
}) {
  const { connectionId, onError } = options;

  const connNameEncodingChoice = ref<ConnectionNameEncodingChoice>("follow");

  async function loadConnNameEncoding() {
    const id = connectionId();
    if (!id) return;
    const mirrored = loadConnectionEntry(NAME_ENCODING_OVERRIDES_STORE_KEY, id, normalizeNameEncodingOverride);
    try {
      const prefs = await window.dbxPlugin?.invoke<{ sftp_name_encoding_overrides?: unknown }>("local/preferences/get", {});
      const store = prefs?.sftp_name_encoding_overrides as Record<string, unknown> | undefined;
      const sidecar = normalizeNameEncodingOverride(store?.[id]);
      if (mirrored === null) {
        connNameEncodingChoice.value = choiceFromOverride(sidecar);
        saveConnectionEntry(NAME_ENCODING_OVERRIDES_STORE_KEY, id, sidecar);
        return;
      }
      if (mirrored !== sidecar) {
        connNameEncodingChoice.value = choiceFromOverride(mirrored);
        await persistConnNameEncodingOverride(mirrored);
        return;
      }
      connNameEncodingChoice.value = choiceFromOverride(sidecar);
    } catch {
      // sidecar 不可用：镜像兜底。
      if (mirrored !== null) connNameEncodingChoice.value = choiceFromOverride(mirrored);
    }
  }

  /// 读改写合并：`local/preferences/set` 对该键是整表替换；value=null 删除本
  /// 连接桶（「跟随全局」）。
  async function persistConnNameEncodingOverride(override: NameEncodingOverride | null) {
    const id = connectionId();
    if (!id) return;
    try {
      const prefs = await window.dbxPlugin?.invoke<{ sftp_name_encoding_overrides?: unknown }>("local/preferences/get", {});
      await window.dbxPlugin?.invoke("local/preferences/set", {
        sftp_name_encoding_overrides: mergeNameEncodingStore(
          prefs?.sftp_name_encoding_overrides,
          id,
          override,
        ),
      });
    } catch (cause) {
      onError(cause);
    }
  }

  async function persistConnNameEncoding() {
    const id = connectionId();
    if (!id) return;
    const override = overrideFromChoice(connNameEncodingChoice.value);
    await persistConnNameEncodingOverride(override);
    // 保存双写：RPC + 镜像（null 同样落条目 = 「跟随全局」已迁移）。
    saveConnectionEntry(NAME_ENCODING_OVERRIDES_STORE_KEY, id, override);
  }

  function setConnNameEncoding(choice: ConnectionNameEncodingChoice) {
    connNameEncodingChoice.value = choice;
    void persistConnNameEncoding();
  }

  return {
    connNameEncodingChoice,
    loadConnNameEncoding,
    setConnNameEncoding,
  };
}
