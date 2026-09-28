<script setup lang="ts">
// 密码输入框（明文切换）：宿主沙箱 iframe 下粘贴长密码无法核对，错贴只能
// 盲删重来。Eye 按钮切换 type=password|text。除 v-model 与 type 外，其余
// attrs（placeholder/disabled/aria-invalid/keydown.enter 等）原样透传给
// input；组件上绑定的 @input 与内部 emit 并存互不影响。
import { ref } from "vue";
import { Eye, EyeOff } from "@lucide/vue";

defineOptions({ inheritAttrs: false });

const props = defineProps<{
  modelValue: string;
  t: (key: string, values?: Record<string, string | number>) => string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
}>();

const visible = ref(false);

function onInput(event: Event) {
  emit("update:modelValue", (event.target as HTMLInputElement).value);
}
</script>

<template>
  <span class="pw-field">
    <input
      :type="visible ? 'text' : 'password'"
      :value="props.modelValue"
      autocomplete="off"
      spellcheck="false"
      v-bind="$attrs"
      @input="onInput"
    />
    <button
      type="button"
      class="pw-toggle"
      :title="visible ? props.t('hidePassword') : props.t('showPassword')"
      :aria-label="visible ? props.t('hidePassword') : props.t('showPassword')"
      :aria-pressed="visible"
      @click="visible = !visible"
    >
      <EyeOff v-if="visible" />
      <Eye v-else />
    </button>
  </span>
</template>

<style scoped>
.pw-field { position: relative; display: flex; align-items: center; }
.pw-field input { flex: 1; min-width: 0; padding-right: 24px; }
.pw-toggle {
  position: absolute;
  right: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: var(--radius);
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
  padding: 0;
}
.pw-toggle:hover { color: var(--foreground); background: var(--accent); }
.pw-toggle svg { width: 13px; height: 13px; }
</style>
