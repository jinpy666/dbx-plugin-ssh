# 宿主 issue 草案：listConnections 暴露侧栏分组

> 用途：本文件是**可直接粘贴到宿主仓库 issue 的正文**（中英双语，两版内容一致，任选其一或整篇粘贴）。
> Issue 标题（title）：`Plugin API: expose connection sidebar group in host.listConnections (provider-scoped)`
> 背景文档：`docs/DESIGN_MONITOR_PANEL.zh-CN.md`（§0 决策记录「分组数据来源」、§6 宿主侧 feature request）。
> 文中行号为撰写时点（2026-11）参考值，随宿主主干漂移，仅供定位。

---

## 中文版

### 动机

SSH 插件正在落地「多服务器监控面板」：把多台 SSH 服务器的实时资源监控卡片**按宿主连接侧栏的分组排列并配色**，让监控视图与用户在侧栏里组织主机的结构一致。

分组数据模型已经存在于宿主：

- `apps/desktop/src/stores/connectionStore.ts` 的 `sidebarLayout` 布局树（分组/排序的单一事实来源）；
- `appendConnectionToLayout`（连接入组）、`renameConnectionGroup`（分组改名）维护该树。

但插件 API（`host.listConnections()`）目前不返回任何分组信息，插件侧只能拿到平铺的连接列表，无法还原侧栏分组结构。

### 提议

`host.listConnections()` 的 **provider-scoped 分支**返回值，为每个连接增加两个可选字段：

- `groupId: string | null` —— 连接在侧栏布局树中所属分组的稳定标识；未分组的连接返回 `null`（或省略该字段）。
- `groupName: string | null` —— 分组显示名，跟随 `renameConnectionGroup` 的改名语义。

可选增强（二选一或都做）：

- 保证返回数组的顺序即侧栏布局顺序；或
- 增加第三个可选字段 `groupOrder: number | null`（组间排序键）。

改动定位（行号为约值）：

- **scrub 位置**：`apps/desktop/src/components/plugins/PluginWorkbenchHost.vue` 约 593-663 行的 provider-scoped 分支。该分支本就只枚举本 provider 名下的连接，**无新权限需求**，改动只是在既有返回值上透传分组字段。
- **SDK shim**：`apps/desktop/src/lib/plugins/pluginHostBridge.ts` 约 1454 行，同步 shim 的返回类型。

参照先例：此前 `listConnections` 的扩展提交（宿主 #12603）已确立过同一分支的加字段模式，本次沿用同一模式即可。

插件侧消费方式（供评估兼容性）：插件对响应做**字段探测**——响应条目中出现 `groupId` 键才启用分组渲染，不依赖 host_api 版本号判断；API 未落地前监控面板降级为平铺排列，落地后零改动自动启用分组。

### 可选子项：`host.disconnectConnection(connectionId)`

监控面板为每台主机提供开关；开启 = 拉起连接并采集，关闭 = 停止。若宿主提供 `host.disconnectConnection(connectionId)`，则「关闭开关」可以进一步语义化为**断开连接**（当前宿主无此 API）。缺失时 V1 的行为是只停止采集、不断开 SSH 连接——不影响本期发布，此项为纯增强，可单独评估/单独合并。

### 宿主改动面清单

1. `PluginWorkbenchHost.vue` provider-scoped 分支 scrub：返回值带出 `groupId`/`groupName`（及可选 `groupOrder` 或顺序保证）；
2. SDK shim（`pluginHostBridge.ts`）返回类型同步；
3. 宿主侧插件类型声明（对外 d.ts / `PluginHostApi` 类型）新增可选字段；
4. 相关 spec 用例：分组/未分组连接、`renameConnectionGroup` 后的名称同步、顺序语义（或 `groupOrder`）、旧插件不读新键的回归。

### 风险与兼容

- **纯增量字段**：旧插件不读新键，行为完全不变；新字段全部可选，旧宿主对新插件同样无破坏（插件按字段探测降级）。
- **无凭据暴露**：只暴露分组标识/名称与排序，不涉及凭据、密钥或任何认证材料。
- **可见范围不扩大**：provider-scoped 分支的枚举边界不变，仍然只有本 provider 名下的连接。
- 主项与可选子项（`disconnectConnection`）相互独立，可分开评审、分开合并。

---

## English version

### Motivation

The SSH plugin is shipping a "multi-server monitor panel": live resource monitor cards for multiple SSH servers, **arranged and colour-coded by the connection sidebar groups** of the host, so that the monitoring view mirrors how the user organizes hosts in the sidebar.

The group data model already exists on the host side:

- the `sidebarLayout` layout tree in `apps/desktop/src/stores/connectionStore.ts` (single source of truth for grouping/order);
- maintained by `appendConnectionToLayout` (assign a connection to a group) and `renameConnectionGroup`.

However, the plugin API (`host.listConnections()`) currently returns no group information — plugins only get a flat list of connections and cannot reconstruct the sidebar grouping.

### Proposal

In the **provider-scoped branch** of `host.listConnections()`, add two optional fields per connection:

- `groupId: string | null` — stable identifier of the group this connection belongs to in the sidebar layout tree; `null` (or the field omitted) for ungrouped connections.
- `groupName: string | null` — display name of the group, following `renameConnectionGroup` semantics.

Optional enhancements (either or both):

- guarantee that the array order matches the sidebar layout order; or
- add a third optional field `groupOrder: number | null` (ordering key between groups).

Where the change lives (line numbers approximate):

- **Scrub site**: the provider-scoped branch in `apps/desktop/src/components/plugins/PluginWorkbenchHost.vue`, around lines 593-663. This branch already enumerates only the connections of the calling provider, so there is **no new permission requirement** — the change simply passes the group fields through the existing return value.
- **SDK shim**: `apps/desktop/src/lib/plugins/pluginHostBridge.ts`, around line 1454, to sync the shim's return type.

Prior art: the previous `listConnections` extension commit (host #12603) established the add-a-field pattern on this same branch; this change follows the same pattern.

How the plugin consumes it (for the compatibility review): the plugin does **field probing** — grouped rendering is enabled only when a `groupId` key is present on the response entries, without consulting a host_api version number. Until the API lands, the monitor panel degrades to a flat layout; once it lands, grouping enables with zero plugin-side changes.

### Optional add-on: `host.disconnectConnection(connectionId)`

The monitor panel has a per-host toggle: on = bring the connection up and collect; off = stop. If the host exposes `host.disconnectConnection(connectionId)`, "toggle off" can additionally mean **disconnect** (no such API exists today). Without it, V1 simply stops collecting and leaves the SSH connection open — this does not block this release; the add-on is a pure enhancement and can be evaluated and merged independently.

### Host-side change surface

1. Scrub the provider-scoped branch in `PluginWorkbenchHost.vue`: pass `groupId`/`groupName` (plus optional `groupOrder` or an order guarantee) through the return value;
2. Sync the SDK shim return type (`pluginHostBridge.ts`);
3. Add the optional fields to the host-side plugin type declarations (public d.ts / `PluginHostApi`);
4. Update the related specs: grouped/ungrouped connections, name sync after `renameConnectionGroup`, ordering semantics (or `groupOrder`), and a regression that old plugins which never read the new keys are unaffected.

### Risks and compatibility

- **Purely additive fields**: old plugins never read the new keys and behave exactly as before; all new fields are optional, so an old host paired with a new plugin is equally safe (the plugin degrades via field probing).
- **No credential exposure**: only group identifiers/names and ordering are exposed — no credentials, keys, or any authentication material.
- **Visibility scope unchanged**: the provider-scoped branch keeps its existing enumeration boundary — only connections under the calling provider.
- The main item and the optional add-on (`disconnectConnection`) are independent and can be reviewed and merged separately.
