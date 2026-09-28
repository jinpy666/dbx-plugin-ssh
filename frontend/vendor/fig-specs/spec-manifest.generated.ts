// 由 scripts/sync_fig_specs.mjs 生成（withfig/autocomplete @ aef52acff84c45edde61ae610cc2c964802b9a38）——勿手改。
// 静态 import map（全量进 bundle，决策 D2）；懒加载留待 wave 2 按体积报告裁决。
import type { FigSpecRoot } from "../../src/lib/completion/fig/types";
import { spec as git } from "./build/git";
import { spec as docker } from "./build/docker";
import { spec as kubectl } from "./build/kubectl";
import { spec as helm } from "./build/helm";
import { spec as npm } from "./build/npm";
import { spec as pnpm } from "./build/pnpm";
import { spec as yarn } from "./build/yarn";
import { spec as ssh } from "./build/ssh";
import { spec as aws } from "./build/aws";
import { spec as cargo } from "./build/cargo";
import { spec as systemctl } from "./build/systemctl";

export const FIG_SPECS: Record<string, FigSpecRoot> = {
  git,
  docker,
  kubectl,
  helm,
  npm,
  pnpm,
  yarn,
  ssh,
  aws,
  cargo,
  systemctl,
};
