<script setup lang="ts">
// 终端快捷键编辑器（对标 Tabby「Hotkeys」页）：按动作分组列出全部可改写键位，
// 点击键位进入「录制」态，下一组按键即成为新绑定。
//
// 设计约束：
// - 纯展示 + 本地录制态；绑定表的权威态在 App，本组件只读 props、上抛整表。
//   这样重开设置弹窗不会出现「组件内副本与全局态不同步」的回显漂移。
// - 组合串一律经 lib 的 sanitizeKeyCombo 规范化后再入表：裸键（无修饰键）会被
//   拒绝——否则一个字母键就能吞掉正常输入。
// - 冲突不拦截、只标注（lib 的 findHotkeyConflicts 同口径）：两个动作抢同一组合
//   时按动作表顺序前者生效，用户看得到提示即可自行处理，比直接拒绝好排查。
import { computed, ref, watch } from "vue";
import { X } from "@lucide/vue";
import {
  actionById,
  defaultTerminalHotkeys,
  formatHotkeyDisplay,
  keyComboFromEvent,
  sanitizeKeyCombo,
  TERMINAL_HOTKEY_ACTIONS,
  TERMINAL_HOTKEY_GROUPS,
  type TerminalHotkeyAction,
  type TerminalHotkeyActionId,
  type TerminalHotkeyBindings,
  type TerminalHotkeyGroup,
} from "../lib/terminalHotkeys";

const props = defineProps<{
  bindings: TerminalHotkeyBindings;
  applePlatform: boolean;
  t: (key: string, values?: Record<string, string | number>) => string;
}>();

const emit = defineEmits<{ (e: "update", bindings: TerminalHotkeyBindings): void }>();

/** 单个动作允许的绑定数上限：够用（主键位 + 兼容习惯），又不至于把行撑爆。 */
const MAX_BINDINGS_PER_ACTION = 3;

const GROUP_LABELS: Record<TerminalHotkeyGroup, string> = {
  clipboard: "terminalHotkeys.groupClipboard",
  view: "terminalHotkeys.groupView",
  navigation: "terminalHotkeys.groupNavigation",
};

const query = ref("");
/** 正在录制的槽位：index 为 null 表示「新增一条」而不是改写已有条目。 */
const recording = ref<{ actionId: TerminalHotkeyActionId; index: number | null } | null>(null);
/** 上一次录制被拒（只按了修饰键或裸键），提示后继续等待。 */
const invalid = ref(false);

function combosOf(actionId: TerminalHotkeyActionId): string[] {
  return props.bindings[actionId] ?? [];
}

/** 组合串 → 占用它的其它动作 id（用于冲突标注，允许同一个动作内的重复不提示）。 */
const owners = computed(() => {
  const map = new Map<string, TerminalHotkeyActionId[]>();
  for (const action of TERMINAL_HOTKEY_ACTIONS) {
    for (const combo of combosOf(action.id)) {
      const list = map.get(combo) ?? [];
      list.push(action.id);
      map.set(combo, list);
    }
  }
  return map;
});

const groups = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return TERMINAL_HOTKEY_GROUPS.map((group) => ({
    id: group,
    labelKey: GROUP_LABELS[group],
    actions: TERMINAL_HOTKEY_ACTIONS.filter((action) => action.group === group && (!needle || props.t(action.labelKey).toLowerCase().includes(needle))),
  })).filter((group) => group.actions.length > 0);
});

function conflictTitle(combo: string, actionId: TerminalHotkeyActionId): string {
  const names = (owners.value.get(combo) ?? [])
    .filter((id) => id !== actionId)
    .map((id) => actionById(id))
    .filter((action): action is TerminalHotkeyAction => Boolean(action))
    .map((action) => props.t(action.labelKey));
  if (!names.length) return "";
  return props.t("terminalHotkeys.conflict", { name: names.join(", ") });
}

function isRecording(actionId: TerminalHotkeyActionId, index: number | null): boolean {
  const current = recording.value;
  if (!current || current.actionId !== actionId) return false;
  return index == null ? current.index == null : current.index === index;
}

function canAdd(actionId: TerminalHotkeyActionId): boolean {
  return combosOf(actionId).length < MAX_BINDINGS_PER_ACTION;
}

function commit(next: TerminalHotkeyBindings) {
  emit("update", next);
}

function withCombos(actionId: TerminalHotkeyActionId, combos: string[]): TerminalHotkeyBindings {
  return { ...props.bindings, [actionId]: combos };
}

function cancelRecording() {
  recording.value = null;
  invalid.value = false;
}

function startRecording(actionId: TerminalHotkeyActionId, index: number | null) {
  invalid.value = false;
  // 再点同一个槽位视为取消，避免用户找不到退出录制的方式。
  if (isRecording(actionId, index)) {
    cancelRecording();
    return;
  }
  recording.value = { actionId, index };
}

function removeCombo(actionId: TerminalHotkeyActionId, combo: string) {
  cancelRecording();
  commit(withCombos(actionId, combosOf(actionId).filter((entry) => entry !== combo)));
}

/** 复位单个动作到本平台默认键位（空数组即「默认不绑定」，同样如实还原）。 */
function resetAction(actionId: TerminalHotkeyActionId) {
  cancelRecording();
  commit(withCombos(actionId, [...defaultTerminalHotkeys(props.applePlatform)[actionId]]));
}

function resetAll() {
  cancelRecording();
  commit(defaultTerminalHotkeys(props.applePlatform));
}

/**
 * 录制期间挂在 window 捕获阶段的按键监听：设置弹窗是模态的，终端拿不到焦点，
 * 因此这里吞掉事件不会影响会话；preventDefault 同时挡掉 Tab 焦点跳转等默认动作。
 */
function onKeydown(event: KeyboardEvent) {
  const target = recording.value;
  if (!target) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === "Escape") {
    cancelRecording();
    return;
  }
  // 只按了修饰键本身不算一击：返回 null 时保持录制，等主键。
  const combo = keyComboFromEvent(event);
  if (!combo) return;
  const canonical = sanitizeKeyCombo(combo);
  if (!canonical) {
    // 裸键（无任何修饰键）会被拒绝：绑定它等于让普通输入失效。
    invalid.value = true;
    return;
  }
  invalid.value = false;
  const next = [...combosOf(target.actionId)];
  if (target.index == null) next.push(canonical);
  else next[target.index] = canonical;
  // 同一动作内去重，避免改写后出现两条一模一样的绑定。
  commit(withCombos(target.actionId, next.filter((entry, index) => next.indexOf(entry) === index)));
  cancelRecording();
}

watch(recording, (value, _previous, onCleanup) => {
  if (!value) return;
  window.addEventListener("keydown", onKeydown, true);
  onCleanup(() => window.removeEventListener("keydown", onKeydown, true));
});
</script>

<template>
  <div class="hotkey-editor">
    <div class="hotkey-toolbar">
      <input v-model="query" class="hotkey-search" spellcheck="false" :placeholder="t('terminalHotkeys.searchPlaceholder')" />
      <button type="button" class="link-button" @click="resetAll">{{ t("terminalHotkeys.resetAll") }}</button>
    </div>
    <p v-if="invalid" class="task-error" role="alert">{{ t("terminalHotkeys.invalidCombo") }}</p>
    <p v-if="!groups.length" class="empty compact">{{ t("terminalHotkeys.empty") }}</p>

    <section v-for="group in groups" :key="group.id" class="hotkey-group">
      <h4 class="settings-section-title">{{ t(group.labelKey) }}</h4>
      <div v-for="action in group.actions" :key="action.id" class="hotkey-row">
        <span class="hotkey-label">{{ t(action.labelKey) }}</span>
        <div class="hotkey-combos">
          <template v-for="(combo, index) in combosOf(action.id)" :key="`${action.id}-${index}`">
            <button
              type="button"
              class="hotkey-chip"
              :class="{ recording: isRecording(action.id, index), conflict: conflictTitle(combo, action.id) !== '' }"
              :title="isRecording(action.id, index) ? t('terminalHotkeys.hint') : conflictTitle(combo, action.id)" :aria-label="isRecording(action.id, index) ? t('terminalHotkeys.hint') : conflictTitle(combo, action.id)"
              @click="startRecording(action.id, index)"
            >
              {{ isRecording(action.id, index) ? t("terminalHotkeys.record") : formatHotkeyDisplay(combo, applePlatform) }}
            </button>
            <button
              v-if="!isRecording(action.id, index)"
              type="button"
              class="icon-button hotkey-remove"
              :title="t('terminalHotkeys.unbind')"
              :aria-label="t('terminalHotkeys.unbind')"
              @click="removeCombo(action.id, combo)"
            ><X /></button>
          </template>
          <span v-if="!combosOf(action.id).length && !isRecording(action.id, null)" class="muted hotkey-unbound">{{ t("terminalHotkeys.unbound") }}</span>
          <button
            v-if="canAdd(action.id) || isRecording(action.id, null)"
            type="button"
            class="link-button hotkey-add"
            :class="{ recording: isRecording(action.id, null) }"
            @click="startRecording(action.id, null)"
          >{{ isRecording(action.id, null) ? t("terminalHotkeys.record") : t("terminalHotkeys.addBinding") }}</button>
          <button type="button" class="link-button hotkey-reset" @click="resetAction(action.id)">{{ t("terminalHotkeys.resetOne") }}</button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.hotkey-editor { display: flex; flex-direction: column; gap: 10px; }
.hotkey-toolbar { display: flex; align-items: center; gap: 8px; }
.hotkey-search { flex: 1 1 auto; min-width: 0; border: 1px solid var(--border); border-radius: var(--radius); padding: 6px 8px; background: var(--background); color: var(--foreground); font-size: 12px; }
.hotkey-group { display: flex; flex-direction: column; gap: 6px; }
.hotkey-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
.hotkey-group .hotkey-row:last-child { border-bottom: 0; padding-bottom: 0; }
.hotkey-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.hotkey-combos { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 5px; }
.hotkey-chip { border: 1px solid var(--border); border-radius: 4px; padding: 3px 8px; background: var(--muted); color: var(--foreground); font-family: var(--terminal-font-family); font-size: 11px; cursor: pointer; }
.hotkey-chip:hover { background: color-mix(in srgb, var(--primary) 12%, var(--muted)); }
.hotkey-chip.recording { border-color: var(--primary); background: color-mix(in srgb, var(--primary) 18%, transparent); color: var(--primary); }
.hotkey-chip.conflict { border-color: var(--destructive); color: var(--destructive); }
.hotkey-unbound { font-size: 11px; }
.hotkey-remove { width: 20px; height: 20px; }
.hotkey-add.recording { color: var(--primary); }
</style>
