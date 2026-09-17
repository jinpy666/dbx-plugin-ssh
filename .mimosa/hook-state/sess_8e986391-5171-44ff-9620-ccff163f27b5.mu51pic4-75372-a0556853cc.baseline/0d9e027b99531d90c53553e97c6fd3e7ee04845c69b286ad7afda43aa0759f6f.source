// 发行版识别徽标（IMPL_PLAN_NETCATTY_PARITY §3-B2 / §1.5）：osId → monogram
// 徽标数据。纯 CSS 圆角方块 + 首字母 + 主题色，**不引入任何图片/SVG 资产**
// （GPL 隔离红线，§0/§6.7）。旧 sidecar 无 osId 字段时整体缺徽标（optional
// 降级，§6.6）。

export interface DistroBadge {
  /** monogram 单字母（通用徽标为 "?"）。 */
  label: string;
  /** 徽标底色（十六进制，自选主题色，非任何外部资产）。 */
  color: string;
  /** 完整显示名（tooltip / aria-label）：已知发行版用标准名，未知回退 osPretty 原文。 */
  name: string;
}

/** 通用兜底：Tux 灰（§1.1 未知/缺失回退）。 */
const DISTRO_GENERIC_COLOR = "#6b7280";

/** 已知 osId → [标准名, 底色]。centos 与 rhel 刻意不同色（§3-B2-T1）。 */
const DISTRO_BADGES: Record<string, [string, string]> = {
  ubuntu: ["Ubuntu", "#e95420"],
  debian: ["Debian", "#a81d33"],
  centos: ["CentOS", "#9ccd2a"],
  rhel: ["RHEL", "#ee0000"],
  fedora: ["Fedora", "#51a2da"],
  alpine: ["Alpine Linux", "#0d597f"],
  arch: ["Arch Linux", "#1793d1"],
  rocky: ["Rocky Linux", "#10b981"],
  almalinux: ["AlmaLinux", "#8b5cf6"],
  opensuse: ["openSUSE", "#73ba25"],
  oracle: ["Oracle Linux", "#f80000"],
  amazon: ["Amazon Linux", "#ff9900"],
  kali: ["Kali Linux", "#557cff"],
  suse: ["SUSE", "#30ba78"],
  // 阿里云/龙蜥家族（国内云主机高频）：alibaba-cloud-linux/alinux 是 Alibaba
  // Cloud Linux 各代实际使用过的 ID；anolis/openanolis 是龙蜥。
  "alibaba-cloud-linux": ["Alibaba Cloud Linux", "#ff6a00"],
  alinux: ["Alibaba Cloud Linux", "#ff6a00"],
  anolis: ["OpenAnolis", "#ff6a00"],
  openanolis: ["OpenAnolis", "#ff6a00"],
  tencentos: ["TencentOS", "#006eff"],
};

/**
 * osId（`/etc/os-release` 的 ID）→ 徽标数据：
 * - 已知 osId：monogram 首字母 + 发行版主题色，大小写不敏感、容忍首尾空白；
 * - tooltip/aria 用的显示名优先 osPretty 原文（§1.6：tooltip 用 osPretty），
 *   缺省回退映射表标准名；
 * - 未知/缺失 osId 但有 osPretty 原文：通用灰徽标，monogram 取 osPretty 首字母
 *   （"?" 在头部看着像坏掉的帮助按钮），name 用 osPretty 原文；
 * - 两者都缺：null（调用方不渲染徽标）。
 */
export function distroBadge(osId: string | null | undefined, osPretty?: string | null): DistroBadge | null {
  const normalizedId = typeof osId === "string" ? osId.trim().toLowerCase() : "";
  const pretty = typeof osPretty === "string" && osPretty.trim() ? osPretty.trim() : "";
  if (normalizedId && DISTRO_BADGES[normalizedId]) {
    const [defaultName, color] = DISTRO_BADGES[normalizedId];
    return { label: defaultName.charAt(0).toUpperCase(), color, name: pretty || defaultName };
  }
  const fallbackName = pretty || normalizedId;
  if (!fallbackName) return null;
  const label = fallbackName.charAt(0).toUpperCase() || "?";
  return { label, color: DISTRO_GENERIC_COLOR, name: fallbackName };
}
