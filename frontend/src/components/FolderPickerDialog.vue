<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ArrowUp, Folder, HardDrive, Loader2, X } from "@lucide/vue";
import { workbenchMessage } from "../lib/i18n";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

interface BrowseEntry {
  name: string;
  path: string;
  is_dir: boolean;
}
interface BrowseResult {
  path: string;
  parent?: string | null;
  entries: BrowseEntry[];
}

interface Props {
  locale: string;
  /** 打开时直达的目录；缺省走「此电脑」（Windows 盘符页）或默认下载目录。 */
  initialPath?: string;
}
const props = defineProps<Props>();
const emit = defineEmits<{
  select: [path: string];
  close: [];
}>();

const t = (key: string, values: Record<string, string | number> = {}) => workbenchMessage(props.locale, key, values);

const current = ref<BrowseResult | null>(null);
const drives = ref<string[] | null>(null);
const drivesAvailable = ref(false);
const pathText = ref("");
const error = ref("");
const loading = ref(false);

async function browse(path?: string) {
  loading.value = true;
  error.value = "";
  drives.value = null;
  try {
    const data = await window.dbxPlugin.invoke<BrowseResult>("local/fs/browse", path ? { path } : {});
    current.value = data;
    pathText.value = data.path;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}

async function showDrives() {
  loading.value = true;
  error.value = "";
  try {
    const result = await window.dbxPlugin.invoke<{ drives: string[] }>("local/fs/drives", {});
    if (Array.isArray(result.drives) && result.drives.length) {
      drivesAvailable.value = true;
      drives.value = result.drives;
      current.value = null;
      pathText.value = "";
      loading.value = false;
    } else {
      // 无盘符平台（macOS/Linux）：直接进入目录浏览（默认下载目录）。
      drivesAvailable.value = false;
      await browse();
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
    loading.value = false;
  }
}

onMounted(() => {
  if (props.initialPath) void browse(props.initialPath);
  else void showDrives();
});

const dirs = computed(() => (current.value?.entries ?? []).filter((entry) => entry.is_dir));
const atDriveRoot = computed(() => !!current.value && !current.value.parent);
</script>

<template>
  <!-- 应用内目录选择器：沙箱 iframe 没有目录选择 API，由 sidecar 列本机目录。
       父级 v-if 挂载即打开；Esc 由 App.vue 弹窗关闭链处理（此处 prevent 拦截 reka）。 -->
  <Dialog :open="true" @update:open="(open) => { if (!open) emit('close'); }">
    <DialogContent class="modal folder-picker-modal" @escape-key-down.prevent>
      <header>
        <DialogTitle>{{ t("folderPicker.title") }}</DialogTitle>
        <button :title="t('close')" :aria-label="t('close')" class="icon-button" @click="emit('close')"><X /></button>
      </header>
      <div class="folder-picker-path">
        <input
          v-model="pathText"
          class="mono"
          spellcheck="false"
          :placeholder="drives ? t('folderPicker.placeholderDrives') : t('folderPicker.placeholderPath')"
          @keydown.enter="pathText.trim() && browse(pathText.trim())"
        />
      </div>
      <div class="folder-picker-list">
        <button v-if="!drives && current?.parent" type="button" class="folder-picker-row" @click="browse(current.parent!)">
          <ArrowUp /> {{ t("folderPicker.parentDir") }}
        </button>
        <button v-if="!drives && atDriveRoot && drivesAvailable" type="button" class="folder-picker-row" @click="showDrives">
          <ArrowUp /> {{ t("folderPicker.thisPC") }}
        </button>
        <p v-if="loading" class="folder-picker-hint"><Loader2 class="spinning" />{{ t("loading") }}</p>
        <p v-else-if="error" class="task-error">{{ error }}</p>
        <template v-else-if="!drives">
          <button v-for="entry in dirs" :key="entry.path" type="button" class="folder-picker-row" @click="browse(entry.path)">
            <Folder /><span class="folder-picker-name">{{ entry.name }}</span>
          </button>
          <p v-if="!dirs.length" class="folder-picker-hint">{{ t("folderPicker.empty") }}</p>
        </template>
        <template v-else>
          <button v-for="drive in drives" :key="drive" type="button" class="folder-picker-row" @click="browse(drive)">
            <HardDrive /><span>{{ drive }}</span>
          </button>
        </template>
      </div>
      <footer>
        <span class="folder-picker-current mono" :title="current?.path">{{ drives ? t("folderPicker.thisPC") : current?.path }}</span>
        <button class="primary-button" :disabled="!current" @click="current && emit('select', current.path)">{{ t("folderPicker.confirm") }}</button>
      </footer>
    </DialogContent>
  </Dialog>
</template>
