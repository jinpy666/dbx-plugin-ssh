<script lang="ts">
/** 容器行（docker ps -a 字段集）；面板与列表组件共用同一形状。 */
export interface DockerContainerRow {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  createdAt: string;
}
</script>

<script setup lang="ts">
// 容器列表（从 DockerPanel 抽出）：表格 + 行操作下拉 + 搜索/状态筛选。
// 纯粹呈现与本地过滤：轮询、动作确认、工作台都是父组件的职责，这里只上抛
// 事件；筛选/搜索是纯函数（lib/dockerContainerFilter），语义对齐参考实现
// RemoteX：空白分词 AND 搜索（标识字段支持子序列）、状态 all/running/stopped。
import { computed, onScopeDispose, ref } from "vue";
import {
  ChevronDown,
  FolderOpen,
  Play,
  RotateCw,
  ScrollText,
  Search,
  Square,
  Terminal,
  Trash2,
  X,
} from "@lucide/vue";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { visibleDockerContainers, type DockerStateFilter } from "../lib/dockerContainerFilter";
import type { DockerActionName } from "../lib/dockerActions";
import { createRowMenuController } from "../lib/dockerRowMenu";

const props = defineProps<{
  t: (key: string, values?: Record<string, string | number>) => string;
  containers: DockerContainerRow[];
  /** 正在执行生命周期动作的容器 id（行内操作禁用，防连点）。 */
  busyIds: readonly string[];
}>();

const emit = defineEmits<{
  action: [container: DockerContainerRow, action: DockerActionName];
  logs: [container: DockerContainerRow];
  files: [container: DockerContainerRow];
  terminal: [container: DockerContainerRow];
}>();

const query = ref("");
const stateFilter = ref<DockerStateFilter>("all");
const searchActive = computed(() => query.value.trim().length > 0);
const visible = computed(() =>
  visibleDockerContainers(props.containers, stateFilter.value, query.value),
);

const rowMenu = createRowMenuController();
onScopeDispose(() => rowMenu.close());

/** reka 打开弹层默认把焦点迁入首控件；hover 开启的菜单不迁移——用户可能正在
 *  终端输入，焦点被抢走后按键（Space/Enter）会落到菜单项上误触容器操作。
 *  click/键盘/触屏开启的菜单保留默认迁移，方向键与 Esc 才能在菜单内工作。 */
function onRowMenuOpenAutoFocus(event: Event): void {
  if (rowMenu.openedByHover()) event.preventDefault();
}

function running(container: DockerContainerRow): boolean {
  return container.state === "running";
}

function rowBusy(container: DockerContainerRow): boolean {
  return props.busyIds.includes(container.id);
}

/** 状态徽标 class：已知状态着色，未知状态走中性灰。 */
function dockerStateClass(state: string): string {
  const known = ["running", "exited", "paused", "created", "restarting", "dead", "removing"];
  return known.includes(state) ? `docker-state-${state}` : "docker-state-unknown";
}

/** 菜单选项统一入口：先收菜单再上抛（kill/rm 仍由父组件走确认弹层）。 */
function dispatchAction(container: DockerContainerRow, action: DockerActionName): void {
  rowMenu.close();
  emit("action", container, action);
}

function dispatchOpen(container: DockerContainerRow, kind: "logs" | "files" | "terminal"): void {
  rowMenu.close();
  // 逐一 call emit：联合事件名拿不到 defineEmits 的重载。
  if (kind === "logs") emit("logs", container);
  else if (kind === "files") emit("files", container);
  else emit("terminal", container);
}
</script>

<template>
  <div class="docker-table-wrap">
    <div class="docker-list-toolbar">
      <label class="docker-search-wrap">
        <Search class="docker-search-icon" aria-hidden="true" />
        <input
          v-model="query"
          class="docker-search"
          type="search"
          :placeholder="props.t('docker.searchPlaceholder')"
          :aria-label="props.t('docker.searchPlaceholder')"
          data-test="docker-search"
        />
        <button
          v-if="searchActive"
          type="button"
          class="docker-search-clear"
          :title="props.t('docker.searchClear')"
          :aria-label="props.t('docker.searchClear')"
          @click="query = ''"
        ><X /></button>
      </label>
      <select
        v-model="stateFilter"
        class="docker-filter"
        :aria-label="props.t('docker.filterLabel')"
        data-test="docker-filter"
      >
        <option value="all">{{ props.t("docker.filterAll") }}</option>
        <option value="running">{{ props.t("docker.filterRunning") }}</option>
        <option value="stopped">{{ props.t("docker.filterStopped") }}</option>
      </select>
      <span v-if="searchActive" class="docker-match-count" data-test="docker-match-count">
        {{ visible.length }}/{{ props.containers.length }}
      </span>
    </div>

    <Table v-if="visible.length" class="docker-table">
      <TableHeader>
        <TableRow>
          <TableHead>{{ props.t("docker.colName") }}</TableHead>
          <TableHead>{{ props.t("docker.colImage") }}</TableHead>
          <TableHead>{{ props.t("docker.colState") }}</TableHead>
          <TableHead>{{ props.t("docker.colPorts") }}</TableHead>
          <TableHead class="docker-col-actions">{{ props.t("docker.colActions") }}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="container in visible" :key="container.id">
          <TableCell class="docker-cell-name" :title="container.id">
            <strong class="mono">{{ container.name || container.id.slice(0, 12) }}</strong>
          </TableCell>
          <TableCell class="docker-cell-image mono" :title="container.image">{{ container.image }}</TableCell>
          <TableCell class="docker-cell-state">
            <span class="docker-badge" :class="dockerStateClass(container.state)">{{ container.state }}</span>
            <small class="docker-status" :title="container.status">{{ container.status }}</small>
          </TableCell>
          <TableCell class="docker-cell-ports mono" :title="container.ports">{{ container.ports || "–" }}</TableCell>
          <TableCell class="docker-col-actions">
            <Popover :open="rowMenu.isOpen(container.id)" @update:open="(open: boolean) => { if (!open) rowMenu.close(); }">
              <PopoverAnchor as-child>
                <button
                  type="button"
                  class="icon-button docker-row-trigger"
                  :class="{ 'is-active': rowMenu.isOpen(container.id) }"
                  :title="props.t('docker.colActions')"
                  :aria-label="props.t('docker.colActions')"
                  aria-haspopup="menu"
                  :aria-expanded="rowMenu.isOpen(container.id)"
                  @pointerenter="rowMenu.hoverTrigger(container.id)"
                  @pointerleave="rowMenu.leaveToClose()"
                  @click="rowMenu.toggle(container.id)"
                >
                  <ChevronDown />
                </button>
              </PopoverAnchor>
              <PopoverContent
                class="docker-row-menu w-auto gap-1 p-1"
                align="end"
                :side-offset="4"
                @open-auto-focus="onRowMenuOpenAutoFocus"
                @pointerenter="rowMenu.hoverContent()"
                @pointerleave="rowMenu.leaveToClose()"
              >
                <button type="button" class="docker-row-menu-item" :disabled="running(container) || rowBusy(container)" @click="dispatchAction(container, 'start')">
                  <Play />{{ props.t("docker.actionStart") }}
                </button>
                <button type="button" class="docker-row-menu-item" :disabled="!running(container) || rowBusy(container)" @click="dispatchAction(container, 'stop')">
                  <Square />{{ props.t("docker.actionStop") }}
                </button>
                <button type="button" class="docker-row-menu-item" :disabled="!running(container) || rowBusy(container)" @click="dispatchAction(container, 'restart')">
                  <RotateCw />{{ props.t("docker.actionRestart") }}
                </button>
                <button type="button" class="docker-row-menu-item docker-row-menu-item--danger" :disabled="rowBusy(container)" @click="dispatchAction(container, 'kill')">
                  <X />{{ props.t("docker.actionKill") }}
                </button>
                <button type="button" class="docker-row-menu-item docker-row-menu-item--danger" :disabled="rowBusy(container)" @click="dispatchAction(container, 'rm')">
                  <Trash2 />{{ props.t("docker.actionRemove") }}
                </button>
                <div class="docker-row-menu-sep" role="separator" />
                <button type="button" class="docker-row-menu-item" @click="dispatchOpen(container, 'logs')">
                  <ScrollText />{{ props.t("docker.actionLogs") }}
                </button>
                <button type="button" class="docker-row-menu-item" @click="dispatchOpen(container, 'files')">
                  <FolderOpen />{{ props.t("docker.actionFiles") }}
                </button>
                <button type="button" class="docker-row-menu-item" :disabled="!running(container) || rowBusy(container)" @click="dispatchOpen(container, 'terminal')">
                  <Terminal />{{ props.t("docker.actionTerminal") }}
                </button>
              </PopoverContent>
            </Popover>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>

    <p v-else class="docker-empty docker-no-match" data-test="docker-no-match">{{ props.t("docker.noMatch") }}</p>
    <p class="docker-hint">{{ props.t("docker.terminalHint") }}</p>
  </div>
</template>

<style scoped>
.docker-list-toolbar {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.5rem;
  border-bottom: 1px solid var(--border, rgba(128, 128, 128, 0.25));
}

.docker-search-wrap {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1 1 12rem;
  min-width: 0;
}

.docker-search-icon {
  position: absolute;
  left: 0.45rem;
  width: 0.8rem;
  height: 0.8rem;
  opacity: 0.55;
  pointer-events: none;
}

.docker-search {
  width: 100%;
  min-width: 0;
  padding: 0.25rem 1.6rem 0.25rem 1.6rem;
  border: 1px solid var(--border, rgba(128, 128, 128, 0.35));
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font-size: 11px;
}

.docker-search::-webkit-search-cancel-button {
  display: none;
}

.docker-search-clear {
  position: absolute;
  right: 0.3rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1rem;
  height: 1rem;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  opacity: 0.6;
  cursor: pointer;
}

.docker-search-clear:hover {
  opacity: 1;
}

.docker-search-clear svg {
  width: 0.75rem;
  height: 0.75rem;
}

.docker-filter {
  flex: none;
  padding: 0.25rem 0.3rem;
  border: 1px solid var(--border, rgba(128, 128, 128, 0.35));
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font-size: 11px;
}

.docker-match-count {
  flex: none;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  opacity: 0.65;
}

.docker-table {
  width: 100%;
  /* 粘性列需要 separate：collapse 下 Firefox 的粘性单元格边框不随滚动绘制。
     行分隔线本就只画在各 cell 的 border-bottom 上，spacing 0 视觉等价。 */
  border-collapse: separate;
  border-spacing: 0;
  font-size: 11px;
}

.docker-table th {
  height: 32px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border, rgba(128, 128, 128, 0.25));
  font-size: 10px;
  font-weight: 600;
  text-align: left;
  vertical-align: middle;
  opacity: 0.6;
  white-space: nowrap;
}

.docker-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border, rgba(128, 128, 128, 0.15));
  vertical-align: middle;
}

.docker-table tbody tr:last-child td {
  border-bottom: 0;
}

/* 列设最小宽度：窄面板下表格总宽超过容器 → wrap 横向滚动展示完整内容，
   而不是各列被省略号挤没；宽面板下仍按 max-width 截长内容。 */
.docker-cell-name {
  min-width: 110px;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 粘性首列（容器名）：横向滚动时固定靠左，滚动出的内容从其右缘滑过。
   实底取浮层同款 --popover（下层内容透出会误读成两列重叠）；右缘 1px
   分隔让滚动时的层叠关系可见。表头同规则，滚动中表头保持一致。 */
.docker-table th:first-child,
.docker-table td.docker-cell-name {
  position: sticky;
  left: 0;
  z-index: 2;
  background: var(--popover);
  box-shadow: 1px 0 0 var(--border, rgba(128, 128, 128, 0.25));
}

.docker-cell-image {
  min-width: 130px;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.8;
}

.docker-cell-state {
  min-width: 96px;
  white-space: nowrap;
}

.docker-status {
  display: block;
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.6;
}

/* 端口映射串很长且逗号分隔：允许换行展示全部映射（省略号会吞信息），
   列宽在 min/max 间自适应，默认面板宽度下五列 + 操作列即可全部见。 */
.docker-cell-ports {
  min-width: 130px;
  max-width: 220px;
}

.docker-col-actions {
  min-width: 44px;
  white-space: nowrap;
  text-align: right;
}

/* 粘性末列（操作按钮）：横向滚动时固定靠右，下拉触发器永不被内容推出
   视口（issue：列内容过大时下拉按钮被遮挡）。实底同浮层底色，左缘 1px
   分隔；z-index 与首列同级。 */
.docker-table th.docker-col-actions,
.docker-table td.docker-col-actions {
  position: sticky;
  right: 0;
  z-index: 2;
  background: var(--popover);
  box-shadow: -1px 0 0 var(--border, rgba(128, 128, 128, 0.25));
}

.docker-table tbody tr:hover td {
  background: color-mix(in srgb, var(--accent) 45%, var(--popover));
}

/* 行操作悬浮下拉：触发器（⌄）+ hover 菜单。 */
.docker-row-trigger svg {
  width: 14px;
  height: 14px;
}

.docker-row-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 8px;
  border: 0;
  border-radius: 4px;
  background: none;
  color: inherit;
  font: inherit;
  font-size: 12px;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}

.docker-row-menu-item svg {
  width: 14px;
  height: 14px;
  flex-basis: 14px;
  opacity: 0.75;
}

.docker-row-menu-item:hover:not(:disabled),
.docker-row-menu-item:focus-visible {
  background: color-mix(in srgb, var(--foreground) 8%, transparent);
  outline: none;
}

.docker-row-menu-item:disabled {
  opacity: 0.45;
  cursor: default;
}

.docker-row-menu-item--danger:hover:not(:disabled),
.docker-row-menu-item--danger:focus-visible {
  background: color-mix(in srgb, var(--danger, #d64545) 16%, transparent);
  color: var(--danger, #d64545);
}

.docker-row-menu-sep {
  height: 1px;
  margin: 3px 6px;
  background: var(--border, rgba(128, 128, 128, 0.25));
}

.docker-badge {
  display: inline-block;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 11px;
  line-height: 16px;
  background: rgba(128, 128, 128, 0.18);
}

.docker-state-running {
  background: rgba(34, 160, 94, 0.22);
}

.docker-state-exited,
.docker-state-created,
.docker-state-removing,
.docker-state-unknown {
  background: rgba(128, 128, 128, 0.18);
}

.docker-state-paused,
.docker-state-restarting {
  background: rgba(217, 154, 35, 0.25);
}

.docker-state-dead {
  background: rgba(214, 69, 69, 0.25);
}

.docker-empty {
  opacity: 0.65;
  font-size: 12px;
  padding: 8px 4px;
}

.docker-no-match {
  padding: 12px 10px;
}

.docker-hint {
  padding: 0 10px 6px;
  font-size: 11px;
  opacity: 0.7;
}
</style>
