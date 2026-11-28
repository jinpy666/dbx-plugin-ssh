<script setup lang="ts">
// 分组管理浮层（自 MonitorPanel 外抽）：新建分组、逐组改名/配色/删除、成员
// 区按宿主 dock 树分节（组头全选整组进/出 + indeterminate 三态）。分组配置
// 的权威态在 useMonitorPanel，本组件只经 props 注入的动作修改并上抛选中 tab。
import { computed } from "vue";
import { X } from "@lucide/vue";
import { GROUP_COLOR_PALETTE } from "./MonitorCard.vue";
import { useMonitorGroupManager } from "../composables/useMonitorGroupManager";
import type { MonitorConnectionRow, MonitorGroupConfig } from "../lib/monitorProtocol";
import type { MonitorGroupView } from "../composables/useMonitorGrouping";

const props = defineProps<{
  t: (key: string) => string;
  open: boolean;
  groups: MonitorGroupConfig[];
  connections: MonitorConnectionRow[];
  hasTree: boolean;
  treeGroups: MonitorGroupView[];
  activeTab: string;
  /** 隐私模式（成员 chip 只显示序号）。 */
  privacy?: boolean;
  createGroup: (name: string) => string | null | undefined;
  renameGroup: (groupId: string, name: string) => void;
  deleteGroup: (groupId: string) => void;
  setGroupColor: (groupId: string, color: string) => void;
  toggleGroupMember: (groupId: string, connectionId: string) => void;
}>();

const emit = defineEmits<{
  (event: "close"): void;
  (event: "update:activeTab", value: string): void;
}>();

// 父子 ref 桥：配置/树为只读视图，activeTab 双向代理（tab 条与成员分节共用
// 同一选中态，权威态仍在父层）。
const groupsRef = computed(() => props.groups);
const treeGroupsRef = computed(() => props.treeGroups);
const activeTabRef = computed({
  get: () => props.activeTab,
  set: (value: string) => emit("update:activeTab", value),
});

const { draftName, submitNewGroup, setSectionRef, treeMemberSections, toggleSection } = useMonitorGroupManager({
  t: props.t,
  pluginGroups: groupsRef,
  treeGroups: treeGroupsRef,
  activeTab: activeTabRef,
  createGroup: (name) => props.createGroup(name),
  toggleGroupMember: (groupId, connectionId) => props.toggleGroupMember(groupId, connectionId),
});
</script>

<template>
    <div v-if="open" class="monitor-manager-overlay" @click.self="emit('close')">
      <section class="monitor-group-manager" data-testid="monitor-group-manager" role="dialog" :aria-label="t('monitor.groupManage')">
        <header class="monitor-manager-head">
          <strong>{{ t("monitor.groupManage") }}</strong>
          <button type="button" class="monitor-icon-btn" :aria-label="t('monitor.close')" data-testid="monitor-group-close" @click="emit('close')">
            <X :size="15" aria-hidden="true" />
          </button>
        </header>
        <form class="monitor-group-new" @submit.prevent="submitNewGroup">
          <input v-model="draftName" class="monitor-group-input" :placeholder="t('monitor.groupName')" :aria-label="t('monitor.groupName')" />
          <button type="submit" class="monitor-toolbar-btn" :disabled="!draftName.trim()">{{ t("monitor.groupNew") }}</button>
        </form>
        <div v-for="group in groups" :key="group.id" class="monitor-group-row" :data-group-id="group.id">
          <div class="monitor-group-row-head">
            <input class="monitor-group-input" :value="group.name" :aria-label="t('monitor.groupName')" @change="(event) => renameGroup(group.id, (event.target as HTMLInputElement).value)" />
            <div class="monitor-group-colors" role="group" :aria-label="t('monitor.groupColor')">
              <button
                v-for="palette in GROUP_COLOR_PALETTE"
                :key="palette"
                type="button"
                class="monitor-color-dot"
                :class="{ 'is-active': group.color === palette }"
                :style="{ backgroundColor: palette }"
                :aria-label="`${t('monitor.groupColor')} ${palette}`"
                @click="setGroupColor(group.id, group.color === palette ? '' : palette)"
              ></button>
            </div>
          <button type="button" class="monitor-group-delete" @click="deleteGroup(group.id); if (activeTab === `group:${group.id}`) activeTab = 'all'">
            {{ t("monitor.groupDelete") }}
          </button>
        </div>
        <!-- 成员区：tree 分组在位时按 dock 树两级展示（组头全选整组 / 单机勾选）；
             旧宿主无 tree 数据回退平铺 chips。 -->
        <template v-if="hasTree">
          <div v-for="section in treeMemberSections" :key="section.id" class="monitor-member-section">
            <label class="monitor-member-section-head">
              <input
                type="checkbox"
                :checked="section.allSelected"
                :ref="(el) => setSectionRef(section.id, el)"
                @change="() => toggleSection(section)"
              />
              <span class="monitor-member-section-name">{{ section.name }}</span>
            </label>
            <div class="monitor-group-members">
              <label v-for="row in section.rows" :key="row.id" class="monitor-member-chip" :class="{ 'is-member': group.connectionIds.includes(row.id) }">
                <input type="checkbox" :checked="group.connectionIds.includes(row.id)" @change="() => toggleGroupMember(group.id, row.id)" />
                {{ privacy ? `#${connections.indexOf(row) + 1}` : row.name }}
              </label>
            </div>
          </div>
        </template>
        <div v-else class="monitor-group-members">
          <label v-for="row in connections" :key="row.id" class="monitor-member-chip" :class="{ 'is-member': group.connectionIds.includes(row.id) }">
            <input type="checkbox" :checked="group.connectionIds.includes(row.id)" @change="() => toggleGroupMember(group.id, row.id)" />
            {{ privacy ? `#${connections.indexOf(row) + 1}` : row.name }}
          </label>
        </div>
      </div>
      </section>
    </div>
</template>

<style scoped>
/* —— 分组管理浮层（backdrop + 居中卡） —— */
.monitor-manager-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 4rem 1rem 1rem;
  background: rgb(0 0 0 / 0.5);
  backdrop-filter: blur(2px);
}
.monitor-group-manager {
  width: min(560px, 100%);
  max-height: min(70vh, 560px);
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.625rem;
  padding: 0.875rem;
  background: var(--card, var(--background));
  box-shadow: 0 12px 40px rgb(0 0 0 / 0.35);
}
.monitor-manager-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.monitor-manager-head strong {
  font-size: 0.8125rem;
}
/* —— 分组管理弹层 —— */
.monitor-group-manager {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  padding: 0.75rem;
  margin: 0 0 0.75rem;
}
.monitor-group-new {
  display: flex;
  gap: 0.5rem;
}
.monitor-group-input {
  flex: 1;
  min-width: 0;
  font-size: 0.75rem;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  background: transparent;
  color: var(--foreground);
}
.monitor-group-row {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  border-top: 1px solid var(--border);
  padding-top: 0.5rem;
}
.monitor-group-row-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.monitor-group-colors {
  display: inline-flex;
  gap: 0.25rem;
}
.monitor-color-dot {
  width: 0.875rem;
  height: 0.875rem;
  border-radius: 999px;
  border: 1px solid var(--border);
  cursor: pointer;
  padding: 0;
}
.monitor-color-dot.is-active {
  outline: 2px solid var(--primary);
  outline-offset: 1px;
}
.monitor-group-delete {
  font-size: 0.75rem;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  background: transparent;
  color: var(--destructive, #ef4444);
  cursor: pointer;
}
.monitor-group-members {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
}
/* —— 成员区 dock 树分节（tree 模式） —— */
.monitor-member-section {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  border-left: 2px solid var(--border);
  padding-left: 0.5rem;
  margin-bottom: 0.5rem;
}
.monitor-member-section-head {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.75rem;
  color: var(--foreground);
  cursor: pointer;
  user-select: none;
}
.monitor-member-section-name {
  font-weight: 600;
}
.monitor-member-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.6875rem;
  padding: 0.125rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--muted-foreground);
  cursor: pointer;
}
.monitor-member-chip.is-member {
  border-color: var(--primary);
  color: var(--foreground);
}
</style>
