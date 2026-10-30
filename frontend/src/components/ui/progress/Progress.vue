<script setup lang="ts">
import { computed } from "vue";
import { ProgressIndicator, ProgressRoot } from "reka-ui";

const props = withDefaults(defineProps<{
  value: number;
  max?: number;
  tone?: "info" | "success" | "warning" | "danger";
  height?: number;
}>(), { max: 100, tone: "info", height: 8 });

const percent = computed(() => {
  if (!Number.isFinite(props.value) || !Number.isFinite(props.max) || props.max <= 0) return 0;
  return Math.max(0, Math.min(100, (props.value / props.max) * 100));
});
const color = computed(() => `var(--${props.tone === "danger" ? "destructive" : props.tone})`);
const clampedValue = computed(() => Number.isFinite(props.value) ? Math.max(0, Math.min(props.max, props.value)) : null);
</script>

<template>
  <ProgressRoot
    class="dbx-progress"
    :model-value="clampedValue"
    :max="max"
    :data-tone="tone"
    :style="{ height: `${height}px`, '--dbx-progress-color': color }"
  >
    <ProgressIndicator class="dbx-progress-indicator" :style="{ width: `${percent}%` }" />
  </ProgressRoot>
</template>

<style scoped>
.dbx-progress { position: relative; display: block; width: 100%; overflow: hidden; border-radius: 999px; background: color-mix(in srgb, var(--muted-foreground) 15%, transparent); }
.dbx-progress-indicator { display: block; height: 100%; border-radius: inherit; background: var(--dbx-progress-color); box-shadow: 0 0 8px color-mix(in srgb, var(--dbx-progress-color) 22%, transparent); transition: width 350ms ease; }
</style>
