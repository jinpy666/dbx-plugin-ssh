<script setup lang="ts">
// 串口连接弹窗（P3）：端口发现 + 波特率/数据位/校验/停止位/退格键。
// 端口列表来自 serial/ports/list（只读发现，打开时拉一次）；列表为空或宿主
// 无串口支持时渲染手输提示，输入框保持可编辑（datalist 不限制自由输入）。
// 纯 UI：不做连接编排，App.vue 持有会话状态。
import { reactive, ref, watch } from "vue";
import { X } from "@lucide/vue";
import { workbenchMessage } from "../lib/i18n";
import { loadLastConnectParams, persistLastConnectParams } from "../lib/connectLastParams";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

export interface SerialConnectOptions {
  portName: string;
  baudRate: number;
  dataBits: "7" | "8";
  parity: "none" | "even" | "odd";
  stopBits: "1" | "2";
  backspaceMode: "del" | "ctrl_h";
}

const BAUD_PRESETS = [9600, 19200, 38400, 57600, 115200, 230400];

interface Props {
  locale: string;
  open: boolean;
}
const props = defineProps<Props>();
const emit = defineEmits<{ "update:open": [boolean]; connect: [SerialConnectOptions] }>();

const t = (key: string, values: Record<string, string | number> = {}) =>
  workbenchMessage(props.locale, key, values);

const form = reactive({
  port: "",
  baudRate: "115200",
  dataBits: "8" as SerialConnectOptions["dataBits"],
  parity: "none" as SerialConnectOptions["parity"],
  stopBits: "1" as SerialConnectOptions["stopBits"],
  backspaceMode: "del" as SerialConnectOptions["backspaceMode"],
});

// 上次连接参数记忆（pluginStore，跨会话保留；串口参数无凭据可全量记忆）。
const SERIAL_LAST_KEY = "serial-connect-last";
for (const [key, value] of Object.entries(loadLastConnectParams<SerialConnectOptions>(SERIAL_LAST_KEY))) {
  if (typeof value === "string" && key in form) (form as unknown as Record<string, unknown>)[key] = value;
}
function persistLastSerialForm() {
  persistLastConnectParams(SERIAL_LAST_KEY, {
    port: form.port,
    baudRate: form.baudRate,
    dataBits: form.dataBits,
    parity: form.parity,
    stopBits: form.stopBits,
    backspaceMode: form.backspaceMode,
  });
}
const ports = ref<string[]>([]);
const portsLoading = ref(false);
const portError = ref(false);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    portError.value = false;
    portsLoading.value = true;
    window.dbxPlugin
      .invoke<{ ports: string[] }>("serial/ports/list", {})
      .then((info) => {
        ports.value = Array.isArray(info?.ports) ? info.ports.map((entry) => String(entry)) : [];
      })
      .catch(() => {
        ports.value = [];
      })
      .finally(() => {
        portsLoading.value = false;
      });
  },
);

function submit() {
  const port = form.port.trim();
  if (!port) {
    portError.value = true;
    return;
  }
  const baud = Number.parseInt(form.baudRate, 10);
  persistLastSerialForm();
  emit("update:open", false);
  emit("connect", {
    portName: port,
    // 非法输入回退默认 115200；越界值由 sidecar clamp（50..4000000）兜底。
    baudRate: Number.isInteger(baud) && baud > 0 ? baud : 115200,
    dataBits: form.dataBits,
    parity: form.parity,
    stopBits: form.stopBits,
    backspaceMode: form.backspaceMode,
  });
}
</script>

<template>
  <Dialog :open="open" @update:open="(open) => emit('update:open', open)">
    <DialogContent class="modal small-modal" @escape-key-down.prevent>
      <header>
        <DialogTitle>{{ t("serial.dialogTitle") }}</DialogTitle>
        <button :title="t('close')" class="icon-button" @click="emit('update:open', false)"><X /></button>
      </header>
      <div class="serial-form-grid">
        <label class="settings-field serial-port-field">
          <span>{{ t("serial.port") }}</span>
          <input v-model="form.port" class="mono" list="serial-port-options" :placeholder="t('serial.portPlaceholder')" spellcheck="false" :aria-invalid="portError" @keydown.enter="submit" @input="portError = false" />
          <datalist id="serial-port-options">
            <option v-for="entry in ports" :key="entry" :value="entry" />
          </datalist>
          <small v-if="!portsLoading && !ports.length" class="muted serial-ports-empty">{{ t("serial.portsEmpty") }}</small>
        </label>
        <label class="settings-field">
          <span>{{ t("serial.baudRate") }}</span>
          <input v-model="form.baudRate" class="mono" inputmode="numeric" list="serial-baud-options" spellcheck="false" @keydown.enter="submit" />
          <datalist id="serial-baud-options">
            <option v-for="rate in BAUD_PRESETS" :key="rate" :value="String(rate)" />
          </datalist>
        </label>
        <label class="settings-field">
          <span>{{ t("serial.dataBits") }}</span>
          <select v-model="form.dataBits">
            <option value="8">8</option>
            <option value="7">7</option>
          </select>
        </label>
        <label class="settings-field">
          <span>{{ t("serial.parity") }}</span>
          <select v-model="form.parity">
            <option value="none">{{ t("serial.parity.none") }}</option>
            <option value="even">{{ t("serial.parity.even") }}</option>
            <option value="odd">{{ t("serial.parity.odd") }}</option>
          </select>
        </label>
        <label class="settings-field">
          <span>{{ t("serial.stopBits") }}</span>
          <select v-model="form.stopBits">
            <option value="1">1</option>
            <option value="2">2</option>
          </select>
        </label>
        <label class="settings-field">
          <span>{{ t("serial.backspaceMode") }}</span>
          <select v-model="form.backspaceMode">
            <option value="del">{{ t("serial.backspaceMode.del") }}</option>
            <option value="ctrl_h">{{ t("serial.backspaceMode.ctrlH") }}</option>
          </select>
        </label>
      </div>
      <footer>
        <button @click="emit('update:open', false)">{{ t("cancel") }}</button>
        <button class="primary-button" @click="submit">{{ t("serial.connect") }}</button>
      </footer>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.serial-form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 10px;
  margin-bottom: 8px;
}
.serial-form-grid select {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 6px 8px;
  background: var(--background);
  color: var(--foreground);
  font-size: 12px;
}
.serial-port-field {
  grid-column: 1 / -1;
}
.serial-ports-empty {
  display: block;
  font-size: 11px;
  line-height: 1.5;
}
</style>
