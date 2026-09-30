import type { SftpEntryKind, SftpColumn } from "../lib/sftpEntries";
import { COLUMN_MIN_WIDTHS, COLUMN_WIDTH_MAX, NAME_COLUMN_MAX, NAME_COLUMN_MIN } from "../lib/sftpEntries";
import type { SftpTypeFilter } from "../lib/sftpFileFilters";

type SftpSortColumn = "name" | "size" | "modified";
import { computed, onBeforeUnmount, ref, watch, type Ref } from "vue";
import { filterSftpEntries } from "../lib/sftpFileFilters";
import { computeWindow } from "../lib/virtualWindow";
import { ArrowDown, ArrowUp, ArrowUpDown } from "@lucide/vue";

// 列表条目的最小结构（App.vue 的 SftpEntry 为局部接口，按消费字段收敛）。
type ListingEntry = { uri: string; name: string; kind: SftpEntryKind; size?: number; modifiedAt?: number; owner?: string; group?: string; permissions?: string; lossy?: boolean };

/** SFTP 列表布局：排序（目录优先 + 名称/大小/时间）、搜索防抖过滤、
 * 类型/隐藏过滤联动、grid 列宽（名称列弹性 + 拖拽 resize + 持久化经
 * persistState）、虚拟滚动窗口（30px 行高 + overscan）。 */
export function useSftpListLayout(options: {
  entries: Ref<ListingEntry[]>;
  sort: Ref<{ column: SftpSortColumn; direction: "asc" | "desc" }>;
  visibleColumns: Ref<SftpColumn[]>;
  sftpColumnWidths: Record<SftpColumn, number>;
  sftpNameWidth: Ref<number | null>;
  sftpSearch: Ref<string>;
  sftpTypeFilter: Ref<SftpTypeFilter>;
  sftpShowHidden: Ref<boolean>;
  session: Ref<{ sessionId?: string } | undefined>;
  sudoMode: Ref<boolean>;
  loadDirectory: (path?: string) => Promise<void>;
  persistState: () => void;
}) {
  let sftpResizing: { column: SftpColumn | "name"; startX: number; startWidth: number } | null = null;
  const { entries, sort, visibleColumns, sftpColumnWidths, sftpNameWidth, sftpSearch, sftpTypeFilter, sftpShowHidden, session, sudoMode, loadDirectory, persistState } = options;

const sortedEntries = computed(() => {
  const direction = sort.value.direction === "asc" ? 1 : -1;
  return [...entries.value].sort((left, right) => {
    if (left.kind === "directory" && right.kind !== "directory") return -1;
    if (left.kind !== "directory" && right.kind === "directory") return 1;
    let result = 0;
    if (sort.value.column === "size") result = (left.size ?? -1) - (right.size ?? -1);
    else if (sort.value.column === "modified") result = (left.modifiedAt ?? 0) - (right.modifiedAt ?? 0);
    else result = left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
    return result * direction;
  });
});
const sftpGridStyle = computed(() => {
  // 名称列：未拖过 = 弹性填充剩余空间；拖动后锁定为固定宽度。
  const nameTrack = sftpNameWidth.value != null ? `${sftpNameWidth.value}px` : `minmax(${NAME_COLUMN_MIN}px, 1fr)`;
  const cols: string[] = [nameTrack];
  const nameMin = sftpNameWidth.value ?? NAME_COLUMN_MIN;
  const list: SftpColumn[] = ["size", "modified", "owner", "group", "permissions"];
  for (const col of list) {
    if (visibleColumns.value.includes(col)) {
      cols.push(`${sftpColumnWidths[col]}px`);
    }
  }
  // 总宽超出容器时靠 .file-rows 的 overflow:auto 出横向滚动条。
  let minWidth = nameMin + 16; // + 左右 padding
  for (const col of list) if (visibleColumns.value.includes(col)) minWidth += sftpColumnWidths[col] + 6; // 6px column-gap
  return {
    gridTemplateColumns: cols.join(" "),
    minWidth: `${minWidth}px`,
  };
});
const sftpFiltersActive = computed(() => sftpSearch.value.trim() !== "" || sftpTypeFilter.value !== "all" || sftpShowHidden.value);
const visibleEntries = computed(() => filterSftpEntries(sortedEntries.value, sftpSearch.value, sftpTypeFilter.value, sftpShowHidden.value));

// —— 文件列表窗口化（虚拟滚动）——
// 渲染层只挂可见窗口的行（.file-row 30px + 上下 spacer 撑总高，滚动条比例
// 真实）；选中、范围选择等逻辑层始终作用于全量 visibleEntries，与窗口无关。
// 方案：docs/SFTP_LIST_VIRTUAL_SCROLL_PLAN.zh-CN.md。
const FILE_ROW_HEIGHT_PX = 30;
const FILE_ROW_OVERSCAN = 10;
const fileRowsEl = ref<HTMLElement | null>(null);
const fileRowsViewportHeight = ref(0);
const fileScrollTop = ref(0);
const virtualFileWindow = computed(() =>
  computeWindow({
    scrollTop: fileScrollTop.value,
    viewportHeight: fileRowsViewportHeight.value,
    rowHeight: FILE_ROW_HEIGHT_PX,
    total: visibleEntries.value.length,
    overscan: FILE_ROW_OVERSCAN,
  }),
);
const windowedEntries = computed(() => visibleEntries.value.slice(virtualFileWindow.value.start, virtualFileWindow.value.end));

function onFileRowsScroll(event: Event) {
  fileScrollTop.value = (event.target as HTMLElement).scrollTop;
}

watch(fileRowsEl, (el, previous) => {
  if (previous === el) return;
  if (fileRowsResizeObserver) {
    fileRowsResizeObserver.disconnect();
    fileRowsResizeObserver = undefined;
  }
  if (!el) return;
  fileRowsViewportHeight.value = el.clientHeight;
  fileRowsResizeObserver = new ResizeObserver(() => {
    if (fileRowsResizeTarget) fileRowsViewportHeight.value = fileRowsResizeTarget.clientHeight;
  });
  fileRowsResizeTarget = el;
  fileRowsResizeObserver.observe(el);
});
let fileRowsResizeObserver: ResizeObserver | undefined;
let fileRowsResizeTarget: HTMLElement | undefined;

// 搜索输入防抖：大目录下每个按键 O(n) 过滤 + 全量 diff 明显掉帧；150ms
// 静默期后一次性生效（footer 计数与过滤随之滞后一拍，可接受）。
const SFTP_SEARCH_DEBOUNCE_MS = 150;
const sftpSearchDraft = ref("");
let sftpSearchDebounce: number | undefined;
watch(sftpSearchDraft, (value) => {
  window.clearTimeout(sftpSearchDebounce);
  sftpSearchDebounce = window.setTimeout(() => {
    sftpSearch.value = value;
  }, SFTP_SEARCH_DEBOUNCE_MS);
});
onBeforeUnmount(() => window.clearTimeout(sftpSearchDebounce));

function clearSftpSearch() {
  window.clearTimeout(sftpSearchDebounce);
  sftpSearchDraft.value = "";
  sftpSearch.value = "";
}

function toggleColumn(column: SftpColumn) {
  const hadOwnerData = visibleColumns.value.includes("owner") || visibleColumns.value.includes("group");
  visibleColumns.value = visibleColumns.value.includes(column) ? visibleColumns.value.filter((value) => value !== column) : [...visibleColumns.value, column];
  persistState();
  // 属主/属组列从关到开：当前列表可能没有 owner/group 数据（此前请求没带
  // includeOwner），重拉一次目录；关列不需要重拉。
  if ((column === "owner" || column === "group") && !hadOwnerData && session.value && !sudoMode.value) {
    void loadDirectory();
  }
}

// —— SFTP 列宽拖拽 ——
// 名称列（弹性填充）从 DOM 实时宽度起算；固定列从记录宽度起算。
function onColResizeStart(column: SftpColumn | "name", event: PointerEvent) {
  event.preventDefault();
  event.stopPropagation();
  (event.target as Element).setPointerCapture?.(event.pointerId);
  let startWidth: number;
  if (column === "name") {
    const cell = (event.target as Element).closest(".col-wrap");
    startWidth = cell ? Math.round(cell.getBoundingClientRect().width) : (sftpNameWidth.value ?? NAME_COLUMN_MIN);
  } else {
    startWidth = sftpColumnWidths[column];
  }
  sftpResizing = { column, startX: event.clientX, startWidth };
  document.body.classList.add("resizing-col");
  document.addEventListener("pointermove", onColResizeMove);
  document.addEventListener("pointerup", onColResizeEnd);
  // 拖拽被系统中断（触摸手势、组件重渲染夺走指针）时 pointerup 永不来：
  // 不收尾则 resizing 卡死、body class 与 document 监听永久残留。
  document.addEventListener("pointercancel", onColResizeEnd);
}
function onColResizeMove(event: PointerEvent) {
  if (!sftpResizing) return;
  const delta = event.clientX - sftpResizing.startX;
  const next = Math.round(sftpResizing.startWidth + delta);
  if (sftpResizing.column === "name") {
    sftpNameWidth.value = Math.max(NAME_COLUMN_MIN, Math.min(NAME_COLUMN_MAX, next));
  } else {
    sftpColumnWidths[sftpResizing.column] = Math.max(COLUMN_MIN_WIDTHS[sftpResizing.column], Math.min(COLUMN_WIDTH_MAX, next));
  }
}
function onColResizeEnd() {
  if (!sftpResizing) return;
  sftpResizing = null;
  document.body.classList.remove("resizing-col");
  document.removeEventListener("pointermove", onColResizeMove);
  document.removeEventListener("pointerup", onColResizeEnd);
  document.removeEventListener("pointercancel", onColResizeEnd);
  persistState();
}

onBeforeUnmount(() => {
  // 拖拽中卸载：document 级监听不随组件作用域回收，必须显式摘除。
  onColResizeEnd();
  fileRowsResizeObserver?.disconnect();
  fileRowsResizeObserver = undefined;
});

function toggleSort(column: SftpSortColumn) {
  sort.value = sort.value.column === column ? { column, direction: sort.value.direction === "asc" ? "desc" : "asc" } : { column, direction: "asc" };
}

function sortIcon(column: SftpSortColumn) {
  if (sort.value.column !== column) return ArrowUpDown;
  return sort.value.direction === "asc" ? ArrowUp : ArrowDown;
}


  return {
    sortedEntries,
    visibleEntries,
    virtualFileWindow,
    windowedEntries,
    fileRowsEl,
    onFileRowsScroll,
    sftpSearchDraft,
    clearSftpSearch,
    sftpGridStyle,
    sftpFiltersActive,
    toggleColumn,
    onColResizeStart,
    onColResizeMove,
    onColResizeEnd,
    toggleSort,
    sortIcon,
  };
}
