// dbx-plugin-ssh facade（非上游代码）：`@aws/…-api-bindings` 替代。
// vendored 面内只用到 `Settings` 类型（loadSpec.ts，已被 stub 别名替代，
// 不会进入产物）；提供空实现仅为让打包期模块解析成立。

export type SettingsValue = string | number | boolean | null;

export type Settings = {
  get(key: string): SettingsValue;
  set(key: string, value: SettingsValue): void;
  delete(key: string): void;
};

export const Settings_unsupported: Settings = {
  get: () => null,
  set: () => {},
  delete: () => {},
};
