# SFTP 目录列表虚拟滚动专项方案（review 第三轮产出，待单独成轮实施）

> 来源：2026-09 性能评审 HIGH 项。现状一次渲染全部条目 DOM：打开 2-5 万条目的
> 目录（`/usr/lib`、`node_modules`）首帧卡顿数百 ms；配合多选（第二轮已把
> 选中查询降为 O(n)，但 DOM 行数不变）长列表滚动/过滤仍掉帧。本方案单独成
> 轮实施，不与其它改动混批。

## 现状（证据）

- `frontend/src/App.vue` 文件列表 `<tr v-for="entry in visibleEntries">`：
  `visibleEntries`（App.vue:2026 附近）= 全量条目排序 + 过滤，无窗口化。
- 后端 `ssh.rs` `sftp_list_path` 不设条目上限，一次 read_dir 全量返回。
- `filterSftpEntries`（`lib/sftpFileFilters.ts`）纯 filter，无 slice。
- 已排除项：行选中/批量选择查询热点已在 review-fix-2 改 `Set`；进度事件已
  节流。剩余瓶颈就是行 DOM 数量。

## 方案：自实现窗口化表格（不新增运行时依赖）

仓库约束「除 ui wrapper 外不新增运行时依赖」，`vue-virtual-scroller` 这类
库不上；文件列表是 `<table>` 语义（列对齐/键盘导航已有实现），窗口化必须
保持真实 `<tr>` 可聚焦结构，采用**上方 spacer + 可见窗口 slice + 下方
spacer** 方案（对表格布局侵入最小）：

1. 行高栅格化：文件行高固定（现有 `--row-h`，取实测值，DPR 无关按 CSS px）。
   多行换行的单元格（超长名 ellipsis）已保证单行高度。
2. 滚动容器监听：复用现有列容器 scroll 处理，计算
   `scrollTop → [start, end)` 窗口（上下各加 overscan 10 行）。
3. 渲染 `visibleEntries.slice(start, end)`；spacer 行用
   `height: start*rowH` / `(total-end)*rowH` 撑起总高，保持滚动条比例真实。
4. 键盘导航/选中锚点（`lastClickedUri`）与范围选择 `expandSelection` 仍作用
   于**全量** uri 序列（逻辑层不变），仅渲染层窗口化；focus 移出窗口时
   `scrollIntoView` 触发窗口平移（现有行为）。
5. `sftpSearch` 输入加 150ms 防抖（与窗口化正交的小项，同轮带上）。

## 实施步骤（一轮内的切片）

1. 抽 `lib/virtualWindow.ts` 纯函数（`computeWindow(scrollTop, viewportH,
   rowH, total, overscan) → {start, end, padTop, padBottom}`）+ 单测
   （边界：0 条、不足一屏、滚到底、overscan 截断）。
2. 文件表接入窗口化（仅 SFTP 面板主列表；传输面板/搜索结果不动）。
3. `sftpSearch` 防抖。
4. 大目录实测：本地容器造 3 万条目目录，记录首帧时间与滚动帧率对比。

## 风险与对策

- **列宽联动**：窗口化后 `<tr>` 减少，列宽 auto 计算会漂移 → 列宽已有固定
  `colgroup`/百分比方案则无影响；实施时先核实。
- **全选/反选语义**：全选仍作用于全量（不变），仅渲染窗口变化。
- **拖拽/右键菜单**：按行事件绑定不变，窗口滚动后 reka ContextMenu 定位以
  触发行为准，无影响。
- **回归面**：`fileRowKeydown.spec`、`DirTree.spec` 不受影响；新增
  virtualWindow 单测；UI 冒烟走查目录列表断言需确认窗口化后首批断言行在
  窗口内（冒烟目录条目数远小于一屏，不触发）。

## 验收门禁

全套门禁（cargo fmt/clippy/test、前端 typecheck/test/build、仓库脚本、双
UI 冒烟）+ 3 万条目目录首帧与滚动帧率的实测对比数据写入本文件附录。
