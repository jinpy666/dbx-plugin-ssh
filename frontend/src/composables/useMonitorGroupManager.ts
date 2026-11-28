import { computed, ref, watch, type Ref } from "vue";
import type { MonitorConnectionRow } from "../lib/monitorProtocol";
import type { MonitorGroupView } from "./useMonitorGrouping";

/** 监控分组管理浮层（自 MonitorPanel 纯搬移）：新建分组、打开浮层自动选中
 * 编辑目标、成员区的 dock 树分节（组头全选整组进/出）与 indeterminate 三态。
 * 分组配置的权威态在 useMonitorPanel（createGroup/toggleGroupMember）。 */
export function useMonitorGroupManager(options: {
  t: (key: string) => string;
  pluginGroups: Readonly<Ref<Array<{ id: string; name: string; color?: string; connectionIds: string[] }>>>;
  treeGroups: Readonly<Ref<MonitorGroupView[]>>;
  activeTab: Ref<string>;
  createGroup: (name: string) => string | null | undefined;
  toggleGroupMember: (groupId: string, connectionId: string) => void;
}) {
  const { t, pluginGroups, treeGroups, activeTab, createGroup, toggleGroupMember } = options;

  const groupManagerOpen = ref(false);
  const draftName = ref("");

  // 打开浮层时自动选中一个自建分组作为编辑目标（成员区依赖它）；无组则提示先建。
  watch(groupManagerOpen, (open) => {
    if (!open) return;
    if (!activeTab.value.startsWith("group:")) {
      const first = pluginGroups.value[0];
      if (first) activeTab.value = `group:${first.id}`;
    }
  });

  function submitNewGroup() {
    const id = createGroup(draftName.value);
    if (id) {
      draftName.value = "";
      activeTab.value = `group:${id}`;
    }
  }

  // —— 成员区的 dock 树分节（tree 模式）：组头全选整组进/出当前编辑的 monitor 组 ——
  const sectionCheckRefs = new Map<string, HTMLInputElement>();

  function setSectionRef(sectionId: string, el: unknown) {
    const input = el as HTMLInputElement | null;
    if (input) sectionCheckRefs.set(sectionId, input);
    else sectionCheckRefs.delete(sectionId);
  }

  const treeMemberSections = computed(() => {
    const activeGroupId = activeTab.value.startsWith("group:") ? activeTab.value.slice(6) : "";
    const activeGroup = pluginGroups.value.find((group) => group.id === activeGroupId);
    if (!activeGroup) return [];
    return treeGroups.value
      .filter((section) => section.rows.length > 0)
      .map((section) => {
        const memberIds = section.rows.map((row) => row.id);
        const selected = memberIds.filter((id) => activeGroup.connectionIds.includes(id)).length;
        return { id: section.id, name: section.name || t("monitor.groupAll"), rows: section.rows, allSelected: selected === memberIds.length && memberIds.length > 0, selected };
      });
  });

  function toggleSection(section: { id: string; rows: MonitorConnectionRow[]; allSelected: boolean }) {
    const activeGroupId = activeTab.value.startsWith("group:") ? activeTab.value.slice(6) : "";
    if (!activeGroupId) return;
    const memberSet = new Set(pluginGroups.value.find((group) => group.id === activeGroupId)?.connectionIds ?? []);
    for (const row of section.rows) {
      const isMember = memberSet.has(row.id);
      if (!section.allSelected && !isMember) toggleGroupMember(activeGroupId, row.id);
      else if (section.allSelected && isMember) toggleGroupMember(activeGroupId, row.id);
    }
  }

  // 部分选中 → indeterminate 视觉态（checkbox 三态）。
  watch(treeMemberSections, (sections) => {
    for (const section of sections) {
      const el = sectionCheckRefs.get(section.id);
      if (el) el.indeterminate = section.selected > 0 && !section.allSelected;
    }
  }, { deep: true });

  return { groupManagerOpen, draftName, submitNewGroup, setSectionRef, treeMemberSections, toggleSection };
}
