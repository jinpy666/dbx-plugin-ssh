// fig spec 归一化运行时类型（Lane C，docs/FIG_WAVE1_LANE_C_FIG_SPECS.zh-CN.md §3）。
//
// 这是「归一化形态」而非上游原始形态：上游 Option.name 的 string | string[]
// 归一为 names: string[]（`--`/`-` 前缀原样保留）；函数型 generator 只保留
// {kind:"script"} 声明（wave 1 只存不执行，执行走 wave 2 的 completion/execute
// RPC）；postProcess 等 JS 函数一律丢弃——snapshot 不存代码，保证 vendor 模块
// 纯数据（sync 写盘前有断言）。
//
// 与冻结类型 core/types.ts 的关系：本文件是 fig 数据形态；CompletionItem /
// CompletionContext 等 UI 契约一律从 core/types.ts 只读 import（adapter.ts）。

/**
 * 脚本型 generator 声明。wave 1 只存声明不执行（执行在 wave 2 经
 * completion/execute 打到目标机）；splitOn 保留供 wave 2 切分输出。
 */
export interface FigGeneratorDecl {
  kind: "script";
  script: string[];
  splitOn?: string;
}

/** 位置参数（上游 Arg 的静态子集）。 */
export interface FigArg {
  name?: string;
  description?: string;
  isVariadic?: boolean;
  isOptional?: boolean;
  /** 静态枚举候选（上游 suggestions 的 name 投影；函数型 suggestions 丢弃）。 */
  suggestions?: string[];
  /** 脚本型 generator 声明（不执行，wave 2 接线）。 */
  generators?: FigGeneratorDecl[];
}

/** flag / 选项（上游 Option）。names 含长/短名原样（`--verbose`、`-v`）。 */
export interface FigOption {
  names: string[];
  description?: string;
  args?: FigArg | null;
  isRepeatable?: boolean;
  /** 沿子命令树下传（父级 persistent option 对深层子命令可见）。 */
  isPersistent?: boolean;
  isRequired?: boolean;
}

export interface FigSubcommand {
  name: string;
  aliases?: string[];
  description?: string;
  subcommands?: FigSubcommand[];
  options?: FigOption[];
  args?: FigArg[];
  /**
   * 上游 loadSpec/generateSpec 指令标记：归一化保留原节点并记 generators: []
   * （空数组即「子命令树动态生成、wave 1 未展开」标记，wave 3 处理）。
   */
  generators?: FigGeneratorDecl[];
}

/** 根命令节点（与 FigSubcommand 同构，多一层语义：可按 aliases 命中根命令）。 */
export interface FigSpecRoot {
  name: string;
  aliases?: string[];
  description?: string;
  subcommands?: FigSubcommand[];
  options?: FigOption[];
  args?: FigArg[];
}
