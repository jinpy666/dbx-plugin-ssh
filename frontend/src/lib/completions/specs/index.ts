// 首批结构化补全 spec 聚合（12 个：git/docker/kubectl/npm/pnpm/yarn/ssh/
// systemctl/cargo/tmux/curl/grep）。按 DBX SSH 目标用户（远程运维）取舍；
// 纯数据模块，后续增补命令只往这里追加导出。
import type { CompletionSpecs, SpecCommand } from "../spec";
import { gitSpec } from "./git";
import { dockerSpec } from "./docker";
import { kubectlSpec } from "./kubectl";
import { npmSpec } from "./npm";
import { pnpmSpec } from "./pnpm";
import { yarnSpec } from "./yarn";
import { sshSpec } from "./ssh";
import { systemctlSpec } from "./systemctl";
import { cargoSpec } from "./cargo";
import { tmuxSpec } from "./tmux";
import { curlSpec } from "./curl";
import { grepSpec } from "./grep";

/** 首批结构化补全 spec（顺序即同分排序外的稳定展示序）。 */
export const COMPLETION_SPECS: CompletionSpecs = [gitSpec, dockerSpec, kubectlSpec, sshSpec, systemctlSpec, tmuxSpec, cargoSpec, npmSpec, pnpmSpec, yarnSpec, curlSpec, grepSpec];

export type { SpecCommand };
