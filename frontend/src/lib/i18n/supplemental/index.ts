// 增量文案表聚合（自 lib/i18n.ts 搬移）：表清单即合并顺序，顺序决定同名
// key 的覆盖优先级（后表覆盖前表）——新增表必须追加到末尾，不得插队。

import { transferUiMessages } from "./transfer-ui";
import { uploadBridgeMessages } from "./upload-bridge";
import { folderUploadMessages } from "./folder-upload";
import { dropGateMessages } from "./drop-gate";
import { terminalAppearanceMessages } from "./terminal-appearance";
import { terminalFontMovedMessages } from "./terminal-font-moved";
import { quickCommandsManageMessages } from "./quick-commands-manage";
import { terminalBehaviorMessages } from "./terminal-behavior";
import { restoredMessages } from "./restored";
import { acceleratorMonitorMessages } from "./accelerator-monitor";
import { suggestionTransferMessages } from "./suggestion-transfer";
import { transferSettingsGroupMessages } from "./transfer-settings-group";
import { sftpRelayMessages } from "./sftp-relay";
import { sftpPipelineMessages } from "./sftp-pipeline";
import { connNameEncodingMessages } from "./conn-name-encoding";
import { telnetMessages } from "./telnet";
import { x11Messages } from "./x11";
import { startupCommandsMessages } from "./startup-commands";
import { otpPanelMessages } from "./otp-panel";
import { importWizardMessages } from "./import-wizard";
import { symlinkMessages } from "./symlink";
import { remoteEditMessages } from "./remote-edit";
import { serialMessages } from "./serial";
import { vncMessages } from "./vnc";
import { rdpMessages } from "./rdp";
import { completionMenuMessages } from "./completion-menu";
import { terminalGhostMessages } from "./terminal-ghost";
import { historyPanelSettingsMessages } from "./history-panel-settings";
import { serialUploadMessages } from "./serial-upload";
import { serialEnhanceMessages } from "./serial-enhance";
import { sudoDownloadMessages } from "./sudo-download";
import { sftpLzpackMessages } from "./sftp-lzpack";
import { jsonPreviewMessages } from "./json-preview";
import { terminalOscMessages } from "./terminal-osc";
import { terminalHistoryPanelMessages } from "./terminal-history-panel";
import { transferCompressMessages } from "./transfer-compress";
import { batchUploadMessages } from "./batch-upload";
import { monitorSearchMessages } from "./monitor-search";
import { settingsNavSearchMessages } from "./settings-nav-search";

/** 增量文案表（按合并顺序排列；i18n.ts 的 supplemental 声明在其后填充基础键）。 */
export const SUPPLEMENTAL_TABLES: ReadonlyArray<Record<string, Record<string, string>>> = [
  transferUiMessages,
  uploadBridgeMessages,
  folderUploadMessages,
  dropGateMessages,
  terminalAppearanceMessages,
  terminalFontMovedMessages,
  quickCommandsManageMessages,
  terminalBehaviorMessages,
  restoredMessages,
  acceleratorMonitorMessages,
  suggestionTransferMessages,
  transferSettingsGroupMessages,
  sftpRelayMessages,
  sftpPipelineMessages,
  connNameEncodingMessages,
  telnetMessages,
  x11Messages,
  startupCommandsMessages,
  otpPanelMessages,
  importWizardMessages,
  symlinkMessages,
  remoteEditMessages,
  serialMessages,
  vncMessages,
  rdpMessages,
  completionMenuMessages,
  terminalGhostMessages,
  historyPanelSettingsMessages,
  serialUploadMessages,
  serialEnhanceMessages,
  sudoDownloadMessages,
  sftpLzpackMessages,
  jsonPreviewMessages,
  terminalOscMessages,
  terminalHistoryPanelMessages,
  transferCompressMessages,
  batchUploadMessages,
  monitorSearchMessages,
  settingsNavSearchMessages,
];

/** 按表清单顺序把各 locale 的增量键合并进目标表（原地修改并返回）。 */
export function mergeSupplementalTables(target: Record<string, Record<string, string>>): void {
  for (const table of SUPPLEMENTAL_TABLES) {
    for (const locale of Object.keys(table)) {
      target[locale] = { ...(target[locale] ?? {}), ...table[locale] };
    }
  }
}
