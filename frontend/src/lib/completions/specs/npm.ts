// npm / pnpm / yarn 结构化补全数据（三个文件一组的包管理器运维精选）。
//
// 数据来源：docs.npmjs.com CLI、pnpm.io/cli、classic yarn v1 文档的常用项，
// 格式借鉴 fig 完成规范的 command/option/args 三层思路。
// 裁剪原则：只保留运维高频子命令与 flag；包名/脚本名等动态值一律 dynamic。
import type { SpecCommand } from "../spec";

export const npmSpec: SpecCommand = {
  name: "npm",
  description: "Node.js package manager",
  flags: [{ name: "version", short: "v", description: "Print npm version" }, { name: "silent", description: "Reduce log output" }],
  subcommands: [
    {
      name: "install",
      description: "Install dependencies (alias: i)",
      flags: [
        { name: "global", short: "g", description: "Install globally" },
        { name: "save-dev", short: "D", description: "Save to devDependencies" },
        { name: "save-prod", short: "P", description: "Save to dependencies" },
        { name: "save-optional", short: "O", description: "Save to optionalDependencies" },
        { name: "save-exact", short: "E", description: "Pin the exact version" },
        { name: "legacy-peer-deps", description: "Ignore peer dependency conflicts" },
        { name: "production", description: "Skip devDependencies" },
        { name: "dry-run", description: "Report without writing" },
      ],
      positional: { name: "package", dynamic: true },
    },
    { name: "ci", description: "Clean install from the lockfile" },
    {
      name: "run",
      description: "Run a package.json script",
      flags: [{ name: "silent", short: "s", description: "Suppress npm's own output" }, { name: "if-present", description: "No error when the script is missing" }],
      positional: { name: "script", dynamic: true },
    },
    { name: "test", description: "Run the package test script", flags: [{ name: "watch", description: "Watch mode when supported" }] },
    { name: "start", description: "Run the package start script" },
    { name: "init", description: "Create a package.json", flags: [{ name: "yes", short: "y", description: "Accept defaults" }, { name: "scope", description: "Initialize a scoped package", arg: "scope" }] },
    {
      name: "uninstall",
      description: "Remove packages (alias: rm)",
      flags: [{ name: "global", short: "g", description: "Uninstall globally" }, { name: "save-dev", short: "D", description: "Remove from devDependencies" }, { name: "save-prod", short: "P", description: "Remove from dependencies" }],
      positional: { name: "package", dynamic: true },
    },
    { name: "update", description: "Update packages to latest satisfying versions", flags: [{ name: "global", short: "g", description: "Update global packages" }, { name: "save", short: "S", description: "Save new versions to package.json" }], positional: { name: "package", dynamic: true } },
    { name: "outdated", description: "List packages behind the wanted version", flags: [{ name: "global", short: "g", description: "Check global packages" }, { name: "long", description: "Show extended information" }] },
    { name: "ls", description: "List installed packages", flags: [{ name: "global", short: "g", description: "List global packages" }, { name: "depth", description: "Dependency tree depth", arg: "level" }, { name: "all", description: "Show all contents" }] },
    { name: "audit", description: "Security audit of dependencies", flags: [{ name: "fix", description: "Apply compatible fixes" }, { name: "production", description: "Audit production deps only" }, { name: "json", description: "JSON output" }] },
    { name: "publish", description: "Publish a package", flags: [{ name: "access", description: "Visibility for scoped packages", arg: "level", values: ["public", "restricted"] }, { name: "tag", description: "Registry dist-tag", arg: "tag" }, { name: "dry-run", description: "Report without publishing" }, { name: "otp", description: "One-time password", arg: "code" }] },
    { name: "pack", description: "Create a tarball from a package", flags: [{ name: "dry-run", description: "Report without writing" }] },
    { name: "exec", description: "Run a command from a local or remote package", positional: { name: "command", dynamic: true } },
    { name: "cache", description: "Inspect the npm cache", subcommands: [{ name: "verify", description: "Verify cache integrity" }, { name: "clean", description: "Remove all cache data" }] },
    { name: "config", description: "Manage npm configuration", subcommands: [{ name: "get", description: "Read a config value", positional: { name: "key", dynamic: true } }, { name: "set", description: "Write a config value", positional: { name: "key=value", dynamic: true } }, { name: "list", description: "Print effective config" }, { name: "delete", description: "Remove a config key", positional: { name: "key", dynamic: true } }] },
    { name: "link", description: "Symlink a package folder", flags: [{ name: "global", short: "g", description: "Link into the global folder" }] },
    { name: "whoami", description: "Show the logged-in registry user" },
    { name: "login", description: "Log in to the registry", flags: [{ name: "scope", description: "Scope for the login", arg: "scope" }] },
    { name: "logout", description: "Log out of the registry" },
    { name: "view", description: "Show registry metadata", positional: { name: "package", dynamic: true } },
    { name: "prefix", description: "Print the local or global prefix", flags: [{ name: "global", short: "g", description: "Global prefix" }] },
    { name: "dedupe", description: "Reduce duplicate packages in the tree" },
    { name: "prune", description: "Remove extraneous packages", flags: [{ name: "production", description: "Remove devDependencies too" }] },
  ],
};
