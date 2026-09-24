// cargo 结构化补全数据（Rust 工具链，服务器上构建/排障高频）。
//
// 数据来源：doc.rust-lang.org/cargo 命令参考常用项，格式借鉴 fig 完成规范
// 的 command/option/args 三层思路。裁剪原则：高频子命令与 flag；crate 名/
// 目标名动态。
import type { SpecCommand } from "../spec";

export const cargoSpec: SpecCommand = {
  name: "cargo",
  description: "Rust package manager and build tool",
  flags: [{ name: "version", short: "V", description: "Print cargo version" }, { name: "offline", description: "Run without touching the network" }, { name: "locked", description: "Require the lockfile to be up to date" }, { name: "quiet", short: "q", description: "No output" }, { name: "verbose", short: "v", description: "Verbose output" }],
  subcommands: [
    {
      name: "build",
      description: "Compile the current package",
      flags: [
        { name: "release", description: "Optimized release build" },
        { name: "target", description: "Target triple", arg: "triple" },
        { name: "features", description: "Features to enable", arg: "list" },
        { name: "all-features", description: "Enable all features" },
        { name: "no-default-features", description: "Disable default features" },
        { name: "package", short: "p", description: "Package to build", arg: "name" },
        { name: "bins", description: "Build all binaries" },
        { name: "lib", description: "Build the library" },
      ],
    },
    {
      name: "run",
      description: "Run a binary of the local package",
      flags: [
        { name: "release", description: "Optimized release build" },
        { name: "bin", description: "Binary to run", arg: "name" },
        { name: "example", description: "Example to run", arg: "name" },
        { name: "features", description: "Features to enable", arg: "list" },
      ],
    },
    {
      name: "test",
      description: "Run the package tests",
      flags: [
        { name: "release", description: "Optimized release build" },
        { name: "nocapture", description: "Show println! output of tests" },
        { name: "ignored", description: "Run only ignored tests" },
        { name: "test", description: "Run a named test target", arg: "name" },
        { name: "package", short: "p", description: "Package to test", arg: "name" },
      ],
      positional: { name: "testname", dynamic: true },
    },
    {
      name: "check",
      description: "Type-check without producing binaries",
      flags: [{ name: "release", description: "Check in release mode" }, { name: "all-targets", description: "Check all targets" }, { name: "package", short: "p", description: "Package to check", arg: "name" }],
    },
    { name: "bench", description: "Run the package benchmarks", flags: [{ name: "benches", description: "Run all benches" }] },
    { name: "clean", description: "Remove the target directory", flags: [{ name: "release", description: "Clean release artifacts" }, { name: "package", short: "p", description: "Clean a specific package", arg: "name" }] },
    { name: "doc", description: "Build the package documentation", flags: [{ name: "open", description: "Open the docs in a browser" }, { name: "no-deps", description: "Skip dependency docs" }] },
    { name: "new", description: "Create a new package", flags: [{ name: "bin", description: "Binary template (default)" }, { name: "lib", description: "Library template" }, { name: "vcs", description: "VCS to init (none skips)", arg: "vcs" }], positional: { name: "path", dynamic: true } },
    { name: "init", description: "Initialize a package in the current directory", flags: [{ name: "bin", description: "Binary template" }, { name: "lib", description: "Library template" }, { name: "name", description: "Package name", arg: "name" }] },
    {
      name: "add",
      description: "Add a dependency to Cargo.toml",
      flags: [
        { name: "dev", short: "D", description: "Add as dev-dependency" },
        { name: "build", short: "B", description: "Add as build-dependency" },
        { name: "optional", description: "Add as optional dependency" },
        { name: "features", description: "Enable dependency features", arg: "list" },
        { name: "git", description: "Git repository URL", arg: "url" },
        { name: "path", description: "Local path dependency", arg: "path" },
        { name: "version", description: "Version requirement", arg: "req" },
      ],
      positional: { name: "crate", dynamic: true },
    },
    { name: "remove", description: "Remove dependencies from Cargo.toml", flags: [{ name: "dev", short: "D", description: "From dev-dependencies" }, { name: "build", short: "B", description: "From build-dependencies" }], positional: { name: "crate", dynamic: true } },
    { name: "update", description: "Update dependencies in the lockfile", flags: [{ name: "package", short: "p", description: "Update one package", arg: "name" }, { name: "dry-run", description: "Show what would change" }, { name: "precise", description: "Pin a package version", arg: "version" }], positional: { name: "package", dynamic: true } },
    { name: "search", description: "Search crates.io", positional: { name: "query", dynamic: true } },
    { name: "install", description: "Install a binary crate", flags: [{ name: "version", description: "Version to install", arg: "req" }, { name: "git", description: "Install from a git repo", arg: "url" }, { name: "root", description: "Install root directory", arg: "path" }, { name: "force", description: "Overwrite existing binaries" }], positional: { name: "crate", dynamic: true } },
    { name: "uninstall", description: "Remove an installed binary crate", positional: { name: "crate", dynamic: true } },
    { name: "login", description: "Log in to a registry", flags: [{ name: "registry", description: "Registry name", arg: "name" }] },
    { name: "publish", description: "Publish a package to a registry", flags: [{ name: "dry-run", description: "Publish without uploading" }, { name: "allow-dirty", description: "Publish with a dirty workdir" }] },
    { name: "tree", description: "Display the dependency tree", flags: [{ name: "invert", short: "i", description: "Show reverse dependencies", arg: "crate" }, { name: "duplicates", short: "d", description: "Show packages built multiple times" }, { name: "edges", description: "Which dependency edges to show", arg: "kind" }] },
    { name: "metadata", description: "Machine-readable package metadata", flags: [{ name: "format-version", description: "Metadata format version", arg: "version" }, { name: "no-deps", description: "Skip dependencies" }] },
    { name: "package", description: "Build a .crate file", flags: [{ name: "list", short: "l", description: "List included files" }, { name: "no-verify", description: "Skip building/running" }] },
    { name: "fmt", description: "Format code (via cargo-fmt)", flags: [{ name: "check", description: "Only verify formatting" }, { name: "all", description: "Format all packages" }] },
    { name: "clippy", description: "Lint via clippy", flags: [{ name: "fix", description: "Auto-fix where possible" }, { name: "all-targets", description: "Lint all targets" }, { name: "package", short: "p", description: "Package to lint", arg: "name" }] },
    { name: "fix", description: "Automatically apply rustc suggestions", flags: [{ name: "allow-dirty", description: "Fix with a dirty workdir" }, { name: "broken-code", description: "Fix even if it does not compile" }] },
  ],
};
