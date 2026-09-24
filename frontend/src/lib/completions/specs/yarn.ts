// yarn 结构化补全数据（以 classic v1 为主、补少量 berry 通用项；
// 见 npm.ts 头注释的来源与裁剪原则）。
import type { SpecCommand } from "../spec";

export const yarnSpec: SpecCommand = {
  name: "yarn",
  description: "Package manager (classic v1 with berry additions)",
  flags: [{ name: "version", description: "Print yarn version" }, { name: "verbose", description: "Verbose output" }, { name: "cwd", description: "Run as if started in this path", arg: "path" }],
  subcommands: [
    { name: "install", description: "Install dependencies", flags: [{ name: "frozen-lockfile", description: "Fail when the lockfile needs updating" }, { name: "production", description: "Skip devDependencies" }, { name: "ignore-scripts", description: "Skip lifecycle scripts" }, { name: "check-files", description: "Verify node_modules integrity" }, { name: "offline", description: "Mirror-only install" }] },
    {
      name: "add",
      description: "Install a package and save it",
      flags: [
        { name: "dev", short: "D", description: "Save to devDependencies" },
        { name: "peer", short: "P", description: "Save to peerDependencies" },
        { name: "optional", short: "O", description: "Save to optionalDependencies" },
        { name: "exact", short: "E", description: "Pin the exact version" },
        { name: "tilde", short: "T", description: "Use the ~ range" },
        { name: "ignore-workspace-root-check", short: "W", description: "Allow adding at the workspace root" },
      ],
      positional: { name: "package", dynamic: true },
    },
    { name: "remove", description: "Remove packages", flags: [{ name: "ignore-workspace-root-check", short: "W", description: "Allow removing at the workspace root" }], positional: { name: "package", dynamic: true } },
    { name: "upgrade", description: "Upgrade packages to latest satisfying versions", flags: [{ name: "latest", description: "Ignore the version range" }, { name: "scope", description: "Upgrade a scope", arg: "scope" }], positional: { name: "package", dynamic: true } },
    { name: "run", description: "Run a package.json script", flags: [{ name: "inspect", description: "Start with the debugger", arg: "port" }], positional: { name: "script", dynamic: true } },
    { name: "test", description: "Run the package test script" },
    { name: "init", description: "Create a package.json", flags: [{ name: "yes", short: "y", description: "Accept defaults" }] },
    { name: "publish", description: "Publish a package", flags: [{ name: "access", description: "Visibility for scoped packages", arg: "level", values: ["public", "restricted"] }, { name: "tag", description: "Registry dist-tag", arg: "tag" }, { name: "new-version", description: "Bump to a version", arg: "version" }] },
    { name: "info", description: "Show registry metadata", positional: { name: "package", dynamic: true } },
    { name: "list", description: "List installed packages", flags: [{ name: "depth", description: "Tree depth", arg: "level" }, { name: "pattern", description: "Filter by pattern", arg: "pattern" }] },
    { name: "why", description: "Show why a package is installed", positional: { name: "package", dynamic: true } },
    { name: "audit", description: "Security audit of dependencies" },
    { name: "cache", description: "Manage the yarn cache", subcommands: [{ name: "clean", description: "Clear the global cache" }, { name: "dir", description: "Print the cache folder" }, { name: "list", description: "List cached packages" }] },
    { name: "config", description: "Manage yarn configuration", subcommands: [{ name: "get", description: "Read a config value", positional: { name: "key", dynamic: true } }, { name: "set", description: "Write a config value", positional: { name: "key value", dynamic: true } }, { name: "list", description: "Print effective config" }] },
    { name: "exec", description: "Execute a command in the project scope", positional: { name: "command", dynamic: true } },
    { name: "dlx", description: "Run a package in a one-off environment (berry)", positional: { name: "package", dynamic: true } },
    { name: "workspaces", description: "Manage workspaces", subcommands: [{ name: "info", description: "Show workspace info" }, { name: "run", description: "Run a script in all workspaces", positional: { name: "script", dynamic: true } }, { name: "foreach", description: "Run a command in each workspace" }] },
    { name: "set", description: "Configure yarn (berry)", subcommands: [{ name: "version", description: "Switch yarn versions", flags: [{ name: "stable", description: "Use the latest stable yarn" }] }, { name: "resolution", description: "Pin a transitive dependency" }] },
    { name: "npm", description: "Registry-related commands (berry)", subcommands: [{ name: "login", description: "Log in to the registry" }, { name: "whoami", description: "Show the logged-in user" }, { name: "tag", description: "Manage dist-tags" }] },
    { name: "autoclean", description: "Clean unnecessary files from dependencies", flags: [{ name: "force", short: "F", description: "Run without asking" }] },
    { name: "outdated", description: "List outdated packages", positional: { name: "package", dynamic: true } },
  ],
};
