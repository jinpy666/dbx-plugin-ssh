<script setup lang="ts">
// 引擎连接设置弹层（自 DockerPanel 外抽）：Podman / 自定义 socket / tcp host
// 的紧凑表单，草稿与校验在本组件，保存经 apply 交给父层落盘并重采列表
// （非法草稿——红线不满足——不落盘，弹层保持打开）。按连接持久化的权威态
// 在父层（connectionId 为键，local 模式 "local"）。
import { computed, ref } from "vue";
import { Settings } from "@lucide/vue";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover";
import { validateDockerEngineSettings, type DockerEngineSettings } from "../lib/dockerEngine";

const props = defineProps<{
  t: (key: string, values?: Record<string, string | number>) => string;
  settings: DockerEngineSettings;
}>();

const emit = defineEmits<{
  (event: "apply", settings: DockerEngineSettings): void;
}>();

const open = ref(false);
const draft = ref<DockerEngineSettings>({ cli: "", socket: "", host: "" });
const errors = computed(() => validateDockerEngineSettings(draft.value).errors);

function toggle(): void {
  open.value = !open.value;
  if (open.value) draft.value = { ...props.settings };
}

/** 头部 cli 徽标（父层）与齿轮共开同一弹层：经模板 ref 调用。 */
defineExpose({ toggle });

/** 保存即生效并重采列表；非法草稿（红线不满足）不落盘。 */
function apply(): void {
  const { settings, errors: next } = validateDockerEngineSettings(draft.value);
  if (next.cli || next.endpoints) return;
  emit("apply", settings);
}
</script>

<template>
  <Popover :open="open" @update:open="(value: boolean) => { if (!value) open = false; }">
    <PopoverAnchor as-child>
      <button type="button" class="icon-button" :class="{ 'is-active': open }" :title="props.t('docker.engineSettings')" :aria-label="props.t('docker.engineSettings')" @click="toggle">
        <Settings />
      </button>
    </PopoverAnchor>
    <PopoverContent class="popover docker-engine-popover" align="end" :side-offset="5">
      <h3>{{ props.t("docker.engineSettings") }}</h3>
      <label class="docker-engine-field">
        <span>{{ props.t("docker.engineCli") }}</span>
        <input
          v-model="draft.cli"
          class="mono"
          :placeholder="props.t('docker.engineCliPlaceholder')"
          spellcheck="false"
          @change="apply"
        />
      </label>
      <label class="docker-engine-field">
        <span>{{ props.t("docker.engineSocket") }}</span>
        <input
          v-model="draft.socket"
          class="mono"
          :placeholder="props.t('docker.engineSocketPlaceholder')"
          spellcheck="false"
          @change="apply"
        />
      </label>
      <label class="docker-engine-field">
        <span>{{ props.t("docker.engineHost") }}</span>
        <input
          v-model="draft.host"
          class="mono"
          :placeholder="props.t('docker.engineHostPlaceholder')"
          spellcheck="false"
          @change="apply"
        />
      </label>
      <p v-if="errors.cli" class="docker-hint docker-hint-error">{{ props.t("docker.engineInvalidCli") }}</p>
      <p v-else-if="errors.endpoints === 'conflict'" class="docker-hint docker-hint-error">{{ props.t("docker.engineConflict") }}</p>
      <p v-else-if="errors.endpoints" class="docker-hint docker-hint-error">{{ props.t("docker.engineInvalidEndpoint") }}</p>
      <p class="docker-hint">{{ props.t("docker.engineHint") }}</p>
    </PopoverContent>
  </Popover>
</template>

<style scoped>
.docker-engine-popover {
  min-width: 300px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.docker-engine-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 12px;
}

.docker-engine-field input {
  border: 1px solid var(--border, rgba(128, 128, 128, 0.35));
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 12px;
  background: var(--background, transparent);
  color: inherit;
}

.docker-engine-field input::placeholder {
  opacity: 0.45;
}

.docker-hint {
  font-size: 11px;
  opacity: 0.7;
}

.docker-hint-error {
  color: var(--danger, #d64545);
  opacity: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
