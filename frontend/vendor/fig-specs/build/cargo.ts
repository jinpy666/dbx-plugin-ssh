// 由 scripts/sync_fig_specs.mjs 生成（withfig/autocomplete @ aef52acff84c45edde61ae610cc2c964802b9a38）——纯数据，勿手改。
// 归一化形态见 src/lib/completion/fig/types.ts；重生成：pnpm fig:sync
import type { FigSpecRoot } from "../../../src/lib/completion/fig/types";

export const spec: FigSpecRoot = {
  "name": "cargo",
  "description": "CLI Interface for Cargo",
  "subcommands": [
    {
      "name": "bench",
      "description": "Execute all benchmarks of a local package",
      "options": [
        {
          "names": [
            "--bin"
          ],
          "description": "Benchmark only the specified binary",
          "args": {
            "name": "bin",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--example"
          ],
          "description": "Benchmark only the specified example",
          "args": {
            "name": "example",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--test"
          ],
          "description": "Benchmark only the specified test target",
          "args": {
            "name": "test",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--bench"
          ],
          "description": "Benchmark only the specified bench target",
          "args": {
            "name": "bench",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-p",
            "--package"
          ],
          "description": "Package to run benchmarks for",
          "args": {
            "name": "package",
            "isVariadic": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "metadata",
                  "--format-version",
                  "1",
                  "--no-deps"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--exclude"
          ],
          "description": "Exclude packages from the benchmark",
          "args": {
            "name": "exclude",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "metadata",
                  "--format-version",
                  "1",
                  "--no-deps"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-j",
            "--jobs"
          ],
          "description": "Number of parallel jobs, defaults to # of CPUs",
          "args": {
            "name": "jobs"
          }
        },
        {
          "names": [
            "--profile"
          ],
          "description": "Build artifacts with the specified profile",
          "args": {
            "name": "profile"
          }
        },
        {
          "names": [
            "--features"
          ],
          "description": "Space or comma separated list of features to activate",
          "args": {
            "name": "features",
            "isVariadic": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "read-manifest"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--target"
          ],
          "description": "Build for the target triple",
          "args": {
            "name": "target",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "rustc",
                  "--print",
                  "target-list"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--target-dir"
          ],
          "description": "Directory for all generated artifacts",
          "args": {
            "name": "target-dir"
          }
        },
        {
          "names": [
            "--manifest-path"
          ],
          "description": "Path to Cargo.toml",
          "args": {
            "name": "manifest-path"
          }
        },
        {
          "names": [
            "--message-format"
          ],
          "description": "Error format",
          "args": {
            "name": "message-format"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "auto",
              "always",
              "never"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "--lib"
          ],
          "description": "Benchmark only this package's library"
        },
        {
          "names": [
            "--bins"
          ],
          "description": "Benchmark all binaries"
        },
        {
          "names": [
            "--examples"
          ],
          "description": "Benchmark all examples"
        },
        {
          "names": [
            "--tests"
          ],
          "description": "Benchmark all tests"
        },
        {
          "names": [
            "--benches"
          ],
          "description": "Benchmark all benches"
        },
        {
          "names": [
            "--all-targets"
          ],
          "description": "Benchmark all targets"
        },
        {
          "names": [
            "--no-run"
          ],
          "description": "Compile, but don't run benchmarks"
        },
        {
          "names": [
            "--workspace"
          ],
          "description": "Benchmark all packages in the workspace"
        },
        {
          "names": [
            "--all"
          ],
          "description": "Alias for --workspace (deprecated)"
        },
        {
          "names": [
            "--all-features"
          ],
          "description": "Activate all available features"
        },
        {
          "names": [
            "--no-default-features"
          ],
          "description": "Do not activate the `default` feature"
        },
        {
          "names": [
            "--ignore-rust-version"
          ],
          "description": "Ignore `rust-version` specification in packages"
        },
        {
          "names": [
            "--no-fail-fast"
          ],
          "description": "Run all benchmarks regardless of failure"
        },
        {
          "names": [
            "--unit-graph"
          ],
          "description": "Output build graph in JSON (unstable)"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        },
        {
          "names": [
            "--timings"
          ],
          "description": "Timing output formats (unstable)"
        }
      ],
      "args": [
        {
          "name": "BENCHNAME"
        },
        {
          "name": "args",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "build",
      "aliases": [
        "b"
      ],
      "description": "Compile a local package and all of its dependencies",
      "options": [
        {
          "names": [
            "-p",
            "--package"
          ],
          "description": "Package to build (see `cargo help pkgid`)",
          "args": {
            "name": "package",
            "isVariadic": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "metadata",
                  "--format-version",
                  "1",
                  "--no-deps"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--exclude"
          ],
          "description": "Exclude packages from the build",
          "args": {
            "name": "exclude",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "metadata",
                  "--format-version",
                  "1",
                  "--no-deps"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-j",
            "--jobs"
          ],
          "description": "Number of parallel jobs, defaults to # of CPUs",
          "args": {
            "name": "jobs"
          }
        },
        {
          "names": [
            "--bin"
          ],
          "description": "Build only the specified binary",
          "args": {
            "name": "bin",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--example"
          ],
          "description": "Build only the specified example",
          "args": {
            "name": "example",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--test"
          ],
          "description": "Build only the specified test target",
          "args": {
            "name": "test",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--bench"
          ],
          "description": "Build only the specified bench target",
          "args": {
            "name": "bench",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--profile"
          ],
          "description": "Build artifacts with the specified profile",
          "args": {
            "name": "profile"
          }
        },
        {
          "names": [
            "--features"
          ],
          "description": "Space or comma separated list of features to activate",
          "args": {
            "name": "features",
            "isVariadic": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "read-manifest"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--target"
          ],
          "description": "Build for the target triple",
          "args": {
            "name": "target",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "rustc",
                  "--print",
                  "target-list"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--target-dir"
          ],
          "description": "Directory for all generated artifacts",
          "args": {
            "name": "target-dir"
          }
        },
        {
          "names": [
            "--out-dir"
          ],
          "description": "Copy final artifacts to this directory (unstable)",
          "args": {
            "name": "out-dir"
          }
        },
        {
          "names": [
            "--manifest-path"
          ],
          "description": "Path to Cargo.toml",
          "args": {
            "name": "manifest-path"
          }
        },
        {
          "names": [
            "--message-format"
          ],
          "description": "Error format",
          "args": {
            "name": "message-format"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "auto",
              "always",
              "never"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "--workspace"
          ],
          "description": "Build all packages in the workspace"
        },
        {
          "names": [
            "--all"
          ],
          "description": "Alias for --workspace (deprecated)"
        },
        {
          "names": [
            "--lib"
          ],
          "description": "Build only this package's library"
        },
        {
          "names": [
            "--bins"
          ],
          "description": "Build all binaries"
        },
        {
          "names": [
            "--examples"
          ],
          "description": "Build all examples"
        },
        {
          "names": [
            "--tests"
          ],
          "description": "Build all tests"
        },
        {
          "names": [
            "--benches"
          ],
          "description": "Build all benches"
        },
        {
          "names": [
            "--all-targets"
          ],
          "description": "Build all targets"
        },
        {
          "names": [
            "-r",
            "--release"
          ],
          "description": "Build artifacts in release mode, with optimizations"
        },
        {
          "names": [
            "--all-features"
          ],
          "description": "Activate all available features"
        },
        {
          "names": [
            "--no-default-features"
          ],
          "description": "Do not activate the `default` feature"
        },
        {
          "names": [
            "--ignore-rust-version"
          ],
          "description": "Ignore `rust-version` specification in packages"
        },
        {
          "names": [
            "--build-plan"
          ],
          "description": "Output the build plan in JSON (unstable)"
        },
        {
          "names": [
            "--unit-graph"
          ],
          "description": "Output build graph in JSON (unstable)"
        },
        {
          "names": [
            "--future-incompat-report"
          ],
          "description": "Outputs a future incompatibility report at the end of the build"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        },
        {
          "names": [
            "--timings"
          ],
          "description": "Timing output formats (unstable)"
        }
      ]
    },
    {
      "name": "check",
      "aliases": [
        "c"
      ],
      "description": "Check a local package and all of its dependencies for errors",
      "options": [
        {
          "names": [
            "-p",
            "--package"
          ],
          "description": "Package(s) to check",
          "args": {
            "name": "package",
            "isVariadic": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "metadata",
                  "--format-version",
                  "1",
                  "--no-deps"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--exclude"
          ],
          "description": "Exclude packages from the check",
          "args": {
            "name": "exclude",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "metadata",
                  "--format-version",
                  "1",
                  "--no-deps"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-j",
            "--jobs"
          ],
          "description": "Number of parallel jobs, defaults to # of CPUs",
          "args": {
            "name": "jobs"
          }
        },
        {
          "names": [
            "--bin"
          ],
          "description": "Check only the specified binary",
          "args": {
            "name": "bin",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--example"
          ],
          "description": "Check only the specified example",
          "args": {
            "name": "example",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--test"
          ],
          "description": "Check only the specified test target",
          "args": {
            "name": "test",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--bench"
          ],
          "description": "Check only the specified bench target",
          "args": {
            "name": "bench",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--profile"
          ],
          "description": "Check artifacts with the specified profile",
          "args": {
            "name": "profile"
          }
        },
        {
          "names": [
            "--features"
          ],
          "description": "Space or comma separated list of features to activate",
          "args": {
            "name": "features",
            "isVariadic": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "read-manifest"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--target"
          ],
          "description": "Check for the target triple",
          "args": {
            "name": "target",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "rustc",
                  "--print",
                  "target-list"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--target-dir"
          ],
          "description": "Directory for all generated artifacts",
          "args": {
            "name": "target-dir"
          }
        },
        {
          "names": [
            "--manifest-path"
          ],
          "description": "Path to Cargo.toml",
          "args": {
            "name": "manifest-path"
          }
        },
        {
          "names": [
            "--message-format"
          ],
          "description": "Error format",
          "args": {
            "name": "message-format"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "auto",
              "always",
              "never"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "--workspace"
          ],
          "description": "Check all packages in the workspace"
        },
        {
          "names": [
            "--all"
          ],
          "description": "Alias for --workspace (deprecated)"
        },
        {
          "names": [
            "--lib"
          ],
          "description": "Check only this package's library"
        },
        {
          "names": [
            "--bins"
          ],
          "description": "Check all binaries"
        },
        {
          "names": [
            "--examples"
          ],
          "description": "Check all examples"
        },
        {
          "names": [
            "--tests"
          ],
          "description": "Check all tests"
        },
        {
          "names": [
            "--benches"
          ],
          "description": "Check all benches"
        },
        {
          "names": [
            "--all-targets"
          ],
          "description": "Check all targets"
        },
        {
          "names": [
            "-r",
            "--release"
          ],
          "description": "Check artifacts in release mode, with optimizations"
        },
        {
          "names": [
            "--all-features"
          ],
          "description": "Activate all available features"
        },
        {
          "names": [
            "--no-default-features"
          ],
          "description": "Do not activate the `default` feature"
        },
        {
          "names": [
            "--ignore-rust-version"
          ],
          "description": "Ignore `rust-version` specification in packages"
        },
        {
          "names": [
            "--unit-graph"
          ],
          "description": "Output build graph in JSON (unstable)"
        },
        {
          "names": [
            "--future-incompat-report"
          ],
          "description": "Outputs a future incompatibility report at the end of the build"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        },
        {
          "names": [
            "--timings"
          ],
          "description": "Timing output formats (unstable)"
        }
      ]
    },
    {
      "name": "clean",
      "description": "Remove artifacts that cargo has generated in the past",
      "options": [
        {
          "names": [
            "-p",
            "--package"
          ],
          "description": "Package to clean artifacts for",
          "args": {
            "name": "package",
            "isVariadic": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "metadata",
                  "--format-version",
                  "1",
                  "--no-deps"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--manifest-path"
          ],
          "description": "Path to Cargo.toml",
          "args": {
            "name": "manifest-path"
          }
        },
        {
          "names": [
            "--target"
          ],
          "description": "Target triple to clean output for",
          "args": {
            "name": "target",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "rustc",
                  "--print",
                  "target-list"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--target-dir"
          ],
          "description": "Directory for all generated artifacts",
          "args": {
            "name": "target-dir"
          }
        },
        {
          "names": [
            "--profile"
          ],
          "description": "Clean artifacts of the specified profile",
          "args": {
            "name": "profile"
          }
        },
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "auto",
              "always",
              "never"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "-r",
            "--release"
          ],
          "description": "Whether or not to clean release artifacts"
        },
        {
          "names": [
            "--doc"
          ],
          "description": "Whether or not to clean just the documentation directory"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        }
      ]
    },
    {
      "name": "config",
      "description": "Inspect configuration values",
      "subcommands": [
        {
          "name": "get",
          "options": [
            {
              "names": [
                "--format"
              ],
              "description": "Display format",
              "args": {
                "name": "format",
                "suggestions": [
                  "toml",
                  "json",
                  "json-value"
                ]
              }
            },
            {
              "names": [
                "--merged"
              ],
              "description": "Whether or not to merge config values",
              "args": {
                "name": "merged",
                "suggestions": [
                  "yes",
                  "no"
                ]
              }
            },
            {
              "names": [
                "--color"
              ],
              "description": "Coloring: auto, always, never",
              "args": {
                "name": "color",
                "suggestions": [
                  "auto",
                  "always",
                  "never"
                ]
              }
            },
            {
              "names": [
                "--config"
              ],
              "description": "Override a configuration value",
              "args": {
                "name": "config"
              },
              "isRepeatable": true
            },
            {
              "names": [
                "-Z"
              ],
              "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
              "args": {
                "name": "unstable-features"
              },
              "isRepeatable": true
            },
            {
              "names": [
                "--version"
              ],
              "description": "Print version information"
            },
            {
              "names": [
                "--show-origin"
              ],
              "description": "Display where the config value is defined"
            },
            {
              "names": [
                "-h",
                "--help"
              ],
              "description": "Print help information"
            },
            {
              "names": [
                "-v",
                "--verbose"
              ],
              "description": "Use verbose output (-vv very verbose/build.rs output)",
              "isRepeatable": true
            },
            {
              "names": [
                "--frozen"
              ],
              "description": "Require Cargo.lock and cache are up to date"
            },
            {
              "names": [
                "--locked"
              ],
              "description": "Require Cargo.lock is up to date"
            },
            {
              "names": [
                "--offline"
              ],
              "description": "Run without accessing the network"
            }
          ]
        },
        {
          "name": "help",
          "description": "Print this message or the help of the given subcommand(s)",
          "options": [
            {
              "names": [
                "--color"
              ],
              "description": "Coloring: auto, always, never",
              "args": {
                "name": "color",
                "suggestions": [
                  "auto",
                  "always",
                  "never"
                ]
              }
            },
            {
              "names": [
                "--config"
              ],
              "description": "Override a configuration value",
              "args": {
                "name": "config"
              },
              "isRepeatable": true
            },
            {
              "names": [
                "-Z"
              ],
              "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
              "args": {
                "name": "unstable-features"
              },
              "isRepeatable": true
            },
            {
              "names": [
                "--version"
              ],
              "description": "Print version information"
            },
            {
              "names": [
                "-h",
                "--help"
              ],
              "description": "Print help information"
            },
            {
              "names": [
                "-v",
                "--verbose"
              ],
              "description": "Use verbose output (-vv very verbose/build.rs output)",
              "isRepeatable": true
            },
            {
              "names": [
                "--frozen"
              ],
              "description": "Require Cargo.lock and cache are up to date"
            },
            {
              "names": [
                "--locked"
              ],
              "description": "Require Cargo.lock is up to date"
            },
            {
              "names": [
                "--offline"
              ],
              "description": "Run without accessing the network"
            }
          ],
          "args": [
            {
              "name": "subcommand"
            }
          ]
        }
      ],
      "options": [
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "auto",
              "always",
              "never"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        }
      ]
    },
    {
      "name": "doc",
      "aliases": [
        "d"
      ],
      "description": "Build a package's documentation",
      "options": [
        {
          "names": [
            "-p",
            "--package"
          ],
          "description": "Package to document",
          "args": {
            "name": "package",
            "isVariadic": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "metadata",
                  "--format-version",
                  "1",
                  "--no-deps"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--exclude"
          ],
          "description": "Exclude packages from the build",
          "args": {
            "name": "exclude",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "metadata",
                  "--format-version",
                  "1",
                  "--no-deps"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-j",
            "--jobs"
          ],
          "description": "Number of parallel jobs, defaults to # of CPUs",
          "args": {
            "name": "jobs"
          }
        },
        {
          "names": [
            "--bin"
          ],
          "description": "Document only the specified binary",
          "args": {
            "name": "bin",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--example"
          ],
          "description": "Document only the specified example",
          "args": {
            "name": "example",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--profile"
          ],
          "description": "Build artifacts with the specified profile",
          "args": {
            "name": "profile"
          }
        },
        {
          "names": [
            "--features"
          ],
          "description": "Space or comma separated list of features to activate",
          "args": {
            "name": "features",
            "isVariadic": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "read-manifest"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--target"
          ],
          "description": "Build for the target triple",
          "args": {
            "name": "target",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "rustc",
                  "--print",
                  "target-list"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--target-dir"
          ],
          "description": "Directory for all generated artifacts",
          "args": {
            "name": "target-dir"
          }
        },
        {
          "names": [
            "--manifest-path"
          ],
          "description": "Path to Cargo.toml",
          "args": {
            "name": "manifest-path"
          }
        },
        {
          "names": [
            "--message-format"
          ],
          "description": "Error format",
          "args": {
            "name": "message-format"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color"
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "--open"
          ],
          "description": "Opens the docs in a browser after the operation"
        },
        {
          "names": [
            "--workspace"
          ],
          "description": "Document all packages in the workspace"
        },
        {
          "names": [
            "--all"
          ],
          "description": "Alias for --workspace (deprecated)"
        },
        {
          "names": [
            "--no-deps"
          ],
          "description": "Don't build documentation for dependencies"
        },
        {
          "names": [
            "--document-private-items"
          ],
          "description": "Document private items"
        },
        {
          "names": [
            "--lib"
          ],
          "description": "Document only this package's library"
        },
        {
          "names": [
            "--bins"
          ],
          "description": "Document all binaries"
        },
        {
          "names": [
            "--examples"
          ],
          "description": "Document all examples"
        },
        {
          "names": [
            "-r",
            "--release"
          ],
          "description": "Build artifacts in release mode, with optimizations"
        },
        {
          "names": [
            "--all-features"
          ],
          "description": "Activate all available features"
        },
        {
          "names": [
            "--no-default-features"
          ],
          "description": "Do not activate the `default` feature"
        },
        {
          "names": [
            "--ignore-rust-version"
          ],
          "description": "Ignore `rust-version` specification in packages"
        },
        {
          "names": [
            "--unit-graph"
          ],
          "description": "Output build graph in JSON (unstable)"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        },
        {
          "names": [
            "--timings"
          ],
          "description": "Timing output formats (unstable)"
        }
      ]
    },
    {
      "name": "fetch",
      "description": "Fetch dependencies of a package from the network",
      "options": [
        {
          "names": [
            "--manifest-path"
          ],
          "description": "Path to Cargo.toml",
          "args": {
            "name": "manifest-path"
          }
        },
        {
          "names": [
            "--target"
          ],
          "description": "Fetch dependencies for the target triple",
          "args": {
            "name": "target",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "rustc",
                  "--print",
                  "target-list"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "always",
              "never",
              "auto"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        }
      ]
    },
    {
      "name": "fix",
      "description": "Automatically fix lint warnings reported by rustc",
      "options": [
        {
          "names": [
            "-p",
            "--package"
          ],
          "description": "Package(s) to fix",
          "args": {
            "name": "package",
            "isVariadic": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "metadata",
                  "--format-version",
                  "1",
                  "--no-deps"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--exclude"
          ],
          "description": "Exclude packages from the fixes",
          "args": {
            "name": "exclude",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "metadata",
                  "--format-version",
                  "1",
                  "--no-deps"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-j",
            "--jobs"
          ],
          "description": "Number of parallel jobs, defaults to # of CPUs",
          "args": {
            "name": "jobs"
          }
        },
        {
          "names": [
            "--bin"
          ],
          "description": "Fix only the specified binary",
          "args": {
            "name": "bin",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--example"
          ],
          "description": "Fix only the specified example",
          "args": {
            "name": "example",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--test"
          ],
          "description": "Fix only the specified test target",
          "args": {
            "name": "test",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--bench"
          ],
          "description": "Fix only the specified bench target",
          "args": {
            "name": "bench",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--profile"
          ],
          "description": "Build artifacts with the specified profile",
          "args": {
            "name": "profile"
          }
        },
        {
          "names": [
            "--features"
          ],
          "description": "Space or comma separated list of features to activate",
          "args": {
            "name": "features",
            "isVariadic": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "read-manifest"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--target"
          ],
          "description": "Fix for the target triple",
          "args": {
            "name": "target",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "rustc",
                  "--print",
                  "target-list"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--target-dir"
          ],
          "description": "Directory for all generated artifacts",
          "args": {
            "name": "target-dir"
          }
        },
        {
          "names": [
            "--manifest-path"
          ],
          "description": "Path to Cargo.toml",
          "args": {
            "name": "manifest-path"
          }
        },
        {
          "names": [
            "--message-format"
          ],
          "description": "Error format",
          "args": {
            "name": "message-format"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "always",
              "never",
              "auto"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "--workspace"
          ],
          "description": "Fix all packages in the workspace"
        },
        {
          "names": [
            "--all"
          ],
          "description": "Alias for --workspace (deprecated)"
        },
        {
          "names": [
            "--lib"
          ],
          "description": "Fix only this package's library"
        },
        {
          "names": [
            "--bins"
          ],
          "description": "Fix all binaries"
        },
        {
          "names": [
            "--examples"
          ],
          "description": "Fix all examples"
        },
        {
          "names": [
            "--tests"
          ],
          "description": "Fix all tests"
        },
        {
          "names": [
            "--benches"
          ],
          "description": "Fix all benches"
        },
        {
          "names": [
            "--all-targets"
          ],
          "description": "Fix all targets (default)"
        },
        {
          "names": [
            "-r",
            "--release"
          ],
          "description": "Fix artifacts in release mode, with optimizations"
        },
        {
          "names": [
            "--all-features"
          ],
          "description": "Activate all available features"
        },
        {
          "names": [
            "--no-default-features"
          ],
          "description": "Do not activate the `default` feature"
        },
        {
          "names": [
            "--broken-code"
          ],
          "description": "Fix code even if it already has compiler errors"
        },
        {
          "names": [
            "--edition"
          ],
          "description": "Fix in preparation for the next edition"
        },
        {
          "names": [
            "--edition-idioms"
          ],
          "description": "Fix warnings to migrate to the idioms of an edition"
        },
        {
          "names": [
            "--allow-no-vcs"
          ],
          "description": "Fix code even if a VCS was not detected"
        },
        {
          "names": [
            "--allow-dirty"
          ],
          "description": "Fix code even if the working directory is dirty"
        },
        {
          "names": [
            "--allow-staged"
          ],
          "description": "Fix code even if the working directory has staged changes"
        },
        {
          "names": [
            "--ignore-rust-version"
          ],
          "description": "Ignore `rust-version` specification in packages"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        },
        {
          "names": [
            "--timings"
          ],
          "description": "Timing output formats (unstable)"
        }
      ]
    },
    {
      "name": "generate-lockfile",
      "description": "Generate the lockfile for a package",
      "options": [
        {
          "names": [
            "--manifest-path"
          ],
          "description": "Path to Cargo.toml",
          "args": {
            "name": "manifest-path"
          }
        },
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "always",
              "never",
              "auto"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        }
      ]
    },
    {
      "name": "git-checkout",
      "description": "This subcommand has been removed",
      "options": [
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "always",
              "never",
              "auto"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        }
      ]
    },
    {
      "name": "init",
      "description": "Create a new cargo package in an existing directory",
      "options": [
        {
          "names": [
            "--registry"
          ],
          "description": "Registry to use",
          "args": {
            "name": "registry"
          }
        },
        {
          "names": [
            "--vcs"
          ],
          "description": "Initialize a new repository for the given version control system (git, hg, pijul, or fossil) or do not initialize any version control at all (none), overriding a global configuration",
          "args": {
            "name": "vcs",
            "suggestions": [
              "git",
              "hg",
              "pijul",
              "fossil",
              "none"
            ]
          }
        },
        {
          "names": [
            "--edition"
          ],
          "description": "Edition to set for the crate generated",
          "args": {
            "name": "edition",
            "suggestions": [
              "2015",
              "2018",
              "2021"
            ]
          }
        },
        {
          "names": [
            "--name"
          ],
          "description": "Set the resulting package name, defaults to the directory name",
          "args": {
            "name": "name"
          }
        },
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "always",
              "never",
              "auto"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "--bin"
          ],
          "description": "Use a binary (application) template [default]"
        },
        {
          "names": [
            "--lib"
          ],
          "description": "Use a library template"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        }
      ],
      "args": [
        {
          "name": "path"
        }
      ]
    },
    {
      "name": "install",
      "description": "Install a Rust binary. Default location is $HOME/.cargo/bin",
      "options": [
        {
          "names": [
            "--version"
          ],
          "description": "Specify a version to install",
          "args": {
            "name": "version"
          }
        },
        {
          "names": [
            "--git"
          ],
          "description": "Git URL to install the specified crate from",
          "args": {
            "name": "git"
          }
        },
        {
          "names": [
            "--branch"
          ],
          "description": "Branch to use when installing from git",
          "args": {
            "name": "branch"
          }
        },
        {
          "names": [
            "--tag"
          ],
          "description": "Tag to use when installing from git",
          "args": {
            "name": "tag"
          }
        },
        {
          "names": [
            "--rev"
          ],
          "description": "Specific commit to use when installing from git",
          "args": {
            "name": "rev"
          }
        },
        {
          "names": [
            "--path"
          ],
          "description": "Filesystem path to local crate to install",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "-j",
            "--jobs"
          ],
          "description": "Number of parallel jobs, defaults to # of CPUs",
          "args": {
            "name": "jobs"
          }
        },
        {
          "names": [
            "--features"
          ],
          "description": "Space or comma separated list of features to activate",
          "args": {
            "name": "features",
            "isVariadic": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "read-manifest"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--profile"
          ],
          "description": "Install artifacts with the specified profile",
          "args": {
            "name": "profile"
          }
        },
        {
          "names": [
            "--bin"
          ],
          "description": "Install only the specified binary",
          "args": {
            "name": "bin",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--example"
          ],
          "description": "Install only the specified example",
          "args": {
            "name": "example",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--target"
          ],
          "description": "Build for the target triple",
          "args": {
            "name": "target",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "rustc",
                  "--print",
                  "target-list"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--target-dir"
          ],
          "description": "Directory for all generated artifacts",
          "args": {
            "name": "target-dir"
          }
        },
        {
          "names": [
            "--root"
          ],
          "description": "Directory to install packages into",
          "args": {
            "name": "root"
          }
        },
        {
          "names": [
            "--index"
          ],
          "description": "Registry index to install from",
          "args": {
            "name": "index"
          }
        },
        {
          "names": [
            "--registry"
          ],
          "description": "Registry to use",
          "args": {
            "name": "registry"
          }
        },
        {
          "names": [
            "--message-format"
          ],
          "description": "Error format",
          "args": {
            "name": "message-format"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "always",
              "never",
              "auto"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "--list"
          ],
          "description": "List all installed packages and their versions"
        },
        {
          "names": [
            "-f",
            "--force"
          ],
          "description": "Force overwriting existing crates or binaries"
        },
        {
          "names": [
            "--no-track"
          ],
          "description": "Do not save tracking information"
        },
        {
          "names": [
            "--all-features"
          ],
          "description": "Activate all available features"
        },
        {
          "names": [
            "--no-default-features"
          ],
          "description": "Do not activate the `default` feature"
        },
        {
          "names": [
            "--debug"
          ],
          "description": "Build in debug mode instead of release mode"
        },
        {
          "names": [
            "--bins"
          ],
          "description": "Install all binaries"
        },
        {
          "names": [
            "--examples"
          ],
          "description": "Install all examples"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        },
        {
          "names": [
            "--timings"
          ],
          "description": "Timing output formats (unstable)"
        }
      ],
      "args": [
        {
          "name": "crate",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "locate-project",
      "description": "Print a JSON representation of a Cargo.toml file's location",
      "options": [
        {
          "names": [
            "--manifest-path"
          ],
          "description": "Path to Cargo.toml",
          "args": {
            "name": "manifest-path"
          }
        },
        {
          "names": [
            "--message-format"
          ],
          "description": "Output representation [possible values: json, plain]",
          "args": {
            "name": "message-format"
          }
        },
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "always",
              "never",
              "auto"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "--workspace"
          ],
          "description": "Locate Cargo.toml of the workspace root"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        }
      ]
    },
    {
      "name": "login",
      "description": "Save an api token from the registry locally. If token is not specified, it will be read from stdin",
      "options": [
        {
          "names": [
            "--registry"
          ],
          "description": "Registry to use",
          "args": {
            "name": "registry"
          }
        },
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "always",
              "never",
              "auto"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        }
      ],
      "args": [
        {
          "name": "token"
        }
      ]
    },
    {
      "name": "logout",
      "description": "Remove an API token from the registry locally",
      "options": [
        {
          "names": [
            "--registry"
          ],
          "description": "Registry to use",
          "args": {
            "name": "registry"
          }
        },
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "always",
              "never",
              "auto"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        }
      ]
    },
    {
      "name": "metadata",
      "description": "Output the resolved dependencies of a package, the concrete used versions including overrides, in machine-readable format",
      "options": [
        {
          "names": [
            "--features"
          ],
          "description": "Space or comma separated list of features to activate",
          "args": {
            "name": "features",
            "isVariadic": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "read-manifest"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--filter-platform"
          ],
          "description": "Only include resolve dependencies matching the given target-triple",
          "args": {
            "name": "filter-platform"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--manifest-path"
          ],
          "description": "Path to Cargo.toml",
          "args": {
            "name": "manifest-path"
          }
        },
        {
          "names": [
            "--format-version"
          ],
          "description": "Format version",
          "args": {
            "name": "format-version",
            "suggestions": [
              "1"
            ]
          }
        },
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "always",
              "never",
              "auto"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "--all-features"
          ],
          "description": "Activate all available features"
        },
        {
          "names": [
            "--no-default-features"
          ],
          "description": "Do not activate the `default` feature"
        },
        {
          "names": [
            "--no-deps"
          ],
          "description": "Output information only about the workspace members and don't fetch dependencies"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        }
      ]
    },
    {
      "name": "new",
      "description": "Create a new cargo package at <path>",
      "options": [
        {
          "names": [
            "--registry"
          ],
          "description": "Registry to use",
          "args": {
            "name": "registry"
          }
        },
        {
          "names": [
            "--vcs"
          ],
          "description": "Initialize a new repository for the given version control system (git, hg, pijul, or fossil) or do not initialize any version control at all (none), overriding a global configuration",
          "args": {
            "name": "vcs",
            "suggestions": [
              "git",
              "hg",
              "pijul",
              "fossil",
              "none"
            ]
          }
        },
        {
          "names": [
            "--edition"
          ],
          "description": "Edition to set for the crate generated",
          "args": {
            "name": "edition",
            "suggestions": [
              "2015",
              "2018",
              "2021"
            ]
          }
        },
        {
          "names": [
            "--name"
          ],
          "description": "Set the resulting package name, defaults to the directory name",
          "args": {
            "name": "name"
          }
        },
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "always",
              "never",
              "auto"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "--bin"
          ],
          "description": "Use a binary (application) template [default]"
        },
        {
          "names": [
            "--lib"
          ],
          "description": "Use a library template"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        }
      ],
      "args": [
        {
          "name": "path"
        }
      ]
    },
    {
      "name": "owner",
      "description": "Manage the owners of a crate on the registry",
      "options": [
        {
          "names": [
            "-a",
            "--add"
          ],
          "description": "Name of a user or team to invite as an owner",
          "args": {
            "name": "add"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-r",
            "--remove"
          ],
          "description": "Name of a user or team to remove as an owner",
          "args": {
            "name": "remove"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--index"
          ],
          "description": "Registry index to modify owners for",
          "args": {
            "name": "index"
          }
        },
        {
          "names": [
            "--token"
          ],
          "description": "API token to use when authenticating",
          "args": {
            "name": "token"
          }
        },
        {
          "names": [
            "--registry"
          ],
          "description": "Registry to use",
          "args": {
            "name": "registry"
          }
        },
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "always",
              "never",
              "auto"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "-l",
            "--list"
          ],
          "description": "List owners of a crate"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        }
      ],
      "args": [
        {
          "name": "crate"
        }
      ]
    },
    {
      "name": "package",
      "description": "Assemble the local package into a distributable tarball",
      "options": [
        {
          "names": [
            "--target"
          ],
          "description": "Build for the target triple",
          "args": {
            "name": "target",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "rustc",
                  "--print",
                  "target-list"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--target-dir"
          ],
          "description": "Directory for all generated artifacts",
          "args": {
            "name": "target-dir"
          }
        },
        {
          "names": [
            "--features"
          ],
          "description": "Space or comma separated list of features to activate",
          "args": {
            "name": "features",
            "isVariadic": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "read-manifest"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-p",
            "--package"
          ],
          "description": "Package(s) to assemble",
          "args": {
            "name": "package",
            "isVariadic": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "metadata",
                  "--format-version",
                  "1",
                  "--no-deps"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--exclude"
          ],
          "description": "Don't assemble specified packages",
          "args": {
            "name": "exclude",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "metadata",
                  "--format-version",
                  "1",
                  "--no-deps"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--manifest-path"
          ],
          "description": "Path to Cargo.toml",
          "args": {
            "name": "manifest-path"
          }
        },
        {
          "names": [
            "-j",
            "--jobs"
          ],
          "description": "Number of parallel jobs, defaults to # of CPUs",
          "args": {
            "name": "jobs"
          }
        },
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "always",
              "never",
              "auto"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "-l",
            "--list"
          ],
          "description": "Print files included in a package without making one"
        },
        {
          "names": [
            "--no-verify"
          ],
          "description": "Don't verify the contents by building them"
        },
        {
          "names": [
            "--no-metadata"
          ],
          "description": "Ignore warnings about a lack of human-usable metadata"
        },
        {
          "names": [
            "--allow-dirty"
          ],
          "description": "Allow dirty working directories to be packaged"
        },
        {
          "names": [
            "--all-features"
          ],
          "description": "Activate all available features"
        },
        {
          "names": [
            "--no-default-features"
          ],
          "description": "Do not activate the `default` feature"
        },
        {
          "names": [
            "--workspace"
          ],
          "description": "Assemble all packages in the workspace"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        }
      ]
    },
    {
      "name": "pkgid",
      "description": "Print a fully qualified package specification",
      "options": [
        {
          "names": [
            "-p",
            "--package"
          ],
          "description": "Argument to get the package ID specifier for",
          "args": {
            "name": "package",
            "isVariadic": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "metadata",
                  "--format-version",
                  "1",
                  "--no-deps"
                ]
              }
            ]
          }
        },
        {
          "names": [
            "--manifest-path"
          ],
          "description": "Path to Cargo.toml",
          "args": {
            "name": "manifest-path"
          }
        },
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "always",
              "never",
              "auto"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        }
      ],
      "args": [
        {
          "name": "SPEC",
          "generators": [
            {
              "kind": "script",
              "script": [
                "cargo",
                "metadata",
                "--format-version",
                "1",
                "--no-deps"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "publish",
      "description": "Upload a package to the registry",
      "options": [
        {
          "names": [
            "--index"
          ],
          "description": "Registry index URL to upload the package to",
          "args": {
            "name": "index"
          }
        },
        {
          "names": [
            "--token"
          ],
          "description": "Token to use when uploading",
          "args": {
            "name": "token"
          }
        },
        {
          "names": [
            "--target"
          ],
          "description": "Build for the target triple",
          "args": {
            "name": "target",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "rustc",
                  "--print",
                  "target-list"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--target-dir"
          ],
          "description": "Directory for all generated artifacts",
          "args": {
            "name": "target-dir"
          }
        },
        {
          "names": [
            "-p",
            "--package"
          ],
          "description": "Package to publish",
          "args": {
            "name": "package",
            "isVariadic": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "metadata",
                  "--format-version",
                  "1",
                  "--no-deps"
                ]
              }
            ]
          }
        },
        {
          "names": [
            "--manifest-path"
          ],
          "description": "Path to Cargo.toml",
          "args": {
            "name": "manifest-path"
          }
        },
        {
          "names": [
            "--features"
          ],
          "description": "Space or comma separated list of features to activate",
          "args": {
            "name": "features",
            "isVariadic": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "read-manifest"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-j",
            "--jobs"
          ],
          "description": "Number of parallel jobs, defaults to # of CPUs",
          "args": {
            "name": "jobs"
          }
        },
        {
          "names": [
            "--registry"
          ],
          "description": "Registry to publish to",
          "args": {
            "name": "registry"
          }
        },
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "always",
              "never",
              "auto"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "--no-verify"
          ],
          "description": "Don't verify the contents by building them"
        },
        {
          "names": [
            "--allow-dirty"
          ],
          "description": "Allow dirty working directories to be packaged"
        },
        {
          "names": [
            "--all-features"
          ],
          "description": "Activate all available features"
        },
        {
          "names": [
            "--no-default-features"
          ],
          "description": "Do not activate the `default` feature"
        },
        {
          "names": [
            "--dry-run"
          ],
          "description": "Perform all checks without uploading"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        }
      ]
    },
    {
      "name": "read-manifest",
      "description": "Print a JSON representation of a Cargo.toml manifest. Deprecated, use `cargo metadata --no-deps` instead",
      "options": [
        {
          "names": [
            "--manifest-path"
          ],
          "description": "Path to Cargo.toml",
          "args": {
            "name": "manifest-path"
          }
        },
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "always",
              "never",
              "auto"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        }
      ]
    },
    {
      "name": "report",
      "description": "Generate and display various kinds of reports",
      "subcommands": [
        {
          "name": "future-incompatibilities",
          "description": "Reports any crates which will eventually stop compiling",
          "options": [
            {
              "names": [
                "--id"
              ],
              "description": "Identifier of the report generated by a Cargo command invocation",
              "args": {
                "name": "id"
              }
            },
            {
              "names": [
                "-p",
                "--package"
              ],
              "description": "Package to display a report for",
              "args": {
                "name": "package",
                "isVariadic": true,
                "generators": [
                  {
                    "kind": "script",
                    "script": [
                      "cargo",
                      "metadata",
                      "--format-version",
                      "1",
                      "--no-deps"
                    ]
                  }
                ]
              }
            },
            {
              "names": [
                "--color"
              ],
              "description": "Coloring: auto, always, never",
              "args": {
                "name": "color",
                "suggestions": [
                  "always",
                  "never",
                  "auto"
                ]
              }
            },
            {
              "names": [
                "--config"
              ],
              "description": "Override a configuration value",
              "args": {
                "name": "config"
              },
              "isRepeatable": true
            },
            {
              "names": [
                "-Z"
              ],
              "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
              "args": {
                "name": "unstable-features"
              },
              "isRepeatable": true
            },
            {
              "names": [
                "--version"
              ],
              "description": "Print version information"
            },
            {
              "names": [
                "-h",
                "--help"
              ],
              "description": "Print help information"
            },
            {
              "names": [
                "-v",
                "--verbose"
              ],
              "description": "Use verbose output (-vv very verbose/build.rs output)",
              "isRepeatable": true
            },
            {
              "names": [
                "--frozen"
              ],
              "description": "Require Cargo.lock and cache are up to date"
            },
            {
              "names": [
                "--locked"
              ],
              "description": "Require Cargo.lock is up to date"
            },
            {
              "names": [
                "--offline"
              ],
              "description": "Run without accessing the network"
            }
          ]
        },
        {
          "name": "help",
          "description": "Print this message or the help of the given subcommand(s)",
          "options": [
            {
              "names": [
                "--color"
              ],
              "description": "Coloring: auto, always, never",
              "args": {
                "name": "color",
                "suggestions": [
                  "always",
                  "never",
                  "auto"
                ]
              }
            },
            {
              "names": [
                "--config"
              ],
              "description": "Override a configuration value",
              "args": {
                "name": "config"
              },
              "isRepeatable": true
            },
            {
              "names": [
                "-Z"
              ],
              "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
              "args": {
                "name": "unstable-features"
              },
              "isRepeatable": true
            },
            {
              "names": [
                "--version"
              ],
              "description": "Print version information"
            },
            {
              "names": [
                "-h",
                "--help"
              ],
              "description": "Print help information"
            },
            {
              "names": [
                "-v",
                "--verbose"
              ],
              "description": "Use verbose output (-vv very verbose/build.rs output)",
              "isRepeatable": true
            },
            {
              "names": [
                "--frozen"
              ],
              "description": "Require Cargo.lock and cache are up to date"
            },
            {
              "names": [
                "--locked"
              ],
              "description": "Require Cargo.lock is up to date"
            },
            {
              "names": [
                "--offline"
              ],
              "description": "Run without accessing the network"
            }
          ],
          "args": [
            {
              "name": "subcommand"
            }
          ]
        }
      ],
      "options": [
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "always",
              "never",
              "auto"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        }
      ]
    },
    {
      "name": "run",
      "aliases": [
        "r"
      ],
      "description": "Run a binary or example of the local package",
      "options": [
        {
          "names": [
            "--bin"
          ],
          "description": "Name of the bin target to run",
          "args": {
            "name": "bin",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--example"
          ],
          "description": "Name of the example target to run",
          "args": {
            "name": "example",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-p",
            "--package"
          ],
          "description": "Package with the target to run",
          "args": {
            "name": "package",
            "isVariadic": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "metadata",
                  "--format-version",
                  "1",
                  "--no-deps"
                ]
              }
            ]
          }
        },
        {
          "names": [
            "-j",
            "--jobs"
          ],
          "description": "Number of parallel jobs, defaults to # of CPUs",
          "args": {
            "name": "jobs"
          }
        },
        {
          "names": [
            "--profile"
          ],
          "description": "Build artifacts with the specified profile",
          "args": {
            "name": "profile"
          }
        },
        {
          "names": [
            "--features"
          ],
          "description": "Space or comma separated list of features to activate",
          "args": {
            "name": "features",
            "isVariadic": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "read-manifest"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--target"
          ],
          "description": "Build for the target triple",
          "args": {
            "name": "target",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "rustc",
                  "--print",
                  "target-list"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--target-dir"
          ],
          "description": "Directory for all generated artifacts",
          "args": {
            "name": "target-dir"
          }
        },
        {
          "names": [
            "--manifest-path"
          ],
          "description": "Path to Cargo.toml",
          "args": {
            "name": "manifest-path"
          }
        },
        {
          "names": [
            "--message-format"
          ],
          "description": "Error format",
          "args": {
            "name": "message-format"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "always",
              "never",
              "auto"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "-r",
            "--release"
          ],
          "description": "Build artifacts in release mode, with optimizations"
        },
        {
          "names": [
            "--all-features"
          ],
          "description": "Activate all available features"
        },
        {
          "names": [
            "--no-default-features"
          ],
          "description": "Do not activate the `default` feature"
        },
        {
          "names": [
            "--unit-graph"
          ],
          "description": "Output build graph in JSON (unstable)"
        },
        {
          "names": [
            "--ignore-rust-version"
          ],
          "description": "Ignore `rust-version` specification in packages"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        },
        {
          "names": [
            "--timings"
          ],
          "description": "Timing output formats (unstable)"
        }
      ],
      "args": [
        {
          "name": "args",
          "isVariadic": true,
          "isOptional": true
        }
      ]
    },
    {
      "name": "rustc",
      "description": "Compile a package, and pass extra options to the compiler",
      "options": [
        {
          "names": [
            "-p",
            "--package"
          ],
          "description": "Package to build",
          "args": {
            "name": "package",
            "isVariadic": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "metadata",
                  "--format-version",
                  "1",
                  "--no-deps"
                ]
              }
            ]
          }
        },
        {
          "names": [
            "-j",
            "--jobs"
          ],
          "description": "Number of parallel jobs, defaults to # of CPUs",
          "args": {
            "name": "jobs"
          }
        },
        {
          "names": [
            "--bin"
          ],
          "description": "Build only the specified binary",
          "args": {
            "name": "bin",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--example"
          ],
          "description": "Build only the specified example",
          "args": {
            "name": "example",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--test"
          ],
          "description": "Build only the specified test target",
          "args": {
            "name": "test",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--bench"
          ],
          "description": "Build only the specified bench target",
          "args": {
            "name": "bench",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--profile"
          ],
          "description": "Build artifacts with the specified profile",
          "args": {
            "name": "profile"
          }
        },
        {
          "names": [
            "--features"
          ],
          "description": "Space or comma separated list of features to activate",
          "args": {
            "name": "features",
            "isVariadic": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "read-manifest"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--target"
          ],
          "description": "Target triple which compiles will be for",
          "args": {
            "name": "target",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "rustc",
                  "--print",
                  "target-list"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--print"
          ],
          "description": "Output compiler information without compiling",
          "args": {
            "name": "print"
          }
        },
        {
          "names": [
            "--crate-type"
          ],
          "description": "Comma separated list of types of crates for the compiler to emit",
          "args": {
            "name": "crate-type"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--target-dir"
          ],
          "description": "Directory for all generated artifacts",
          "args": {
            "name": "target-dir"
          }
        },
        {
          "names": [
            "--manifest-path"
          ],
          "description": "Path to Cargo.toml",
          "args": {
            "name": "manifest-path"
          }
        },
        {
          "names": [
            "--message-format"
          ],
          "description": "Error format",
          "args": {
            "name": "message-format"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "always",
              "never",
              "auto"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "--lib"
          ],
          "description": "Build only this package's library"
        },
        {
          "names": [
            "--bins"
          ],
          "description": "Build all binaries"
        },
        {
          "names": [
            "--examples"
          ],
          "description": "Build all examples"
        },
        {
          "names": [
            "--tests"
          ],
          "description": "Build all tests"
        },
        {
          "names": [
            "--benches"
          ],
          "description": "Build all benches"
        },
        {
          "names": [
            "--all-targets"
          ],
          "description": "Build all targets"
        },
        {
          "names": [
            "-r",
            "--release"
          ],
          "description": "Build artifacts in release mode, with optimizations"
        },
        {
          "names": [
            "--all-features"
          ],
          "description": "Activate all available features"
        },
        {
          "names": [
            "--no-default-features"
          ],
          "description": "Do not activate the `default` feature"
        },
        {
          "names": [
            "--unit-graph"
          ],
          "description": "Output build graph in JSON (unstable)"
        },
        {
          "names": [
            "--ignore-rust-version"
          ],
          "description": "Ignore `rust-version` specification in packages"
        },
        {
          "names": [
            "--future-incompat-report"
          ],
          "description": "Outputs a future incompatibility report at the end of the build"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        },
        {
          "names": [
            "--timings"
          ],
          "description": "Timing output formats (unstable)"
        }
      ],
      "args": [
        {
          "name": "args",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "rustdoc",
      "description": "Build a package's documentation, using specified custom flags",
      "options": [
        {
          "names": [
            "-p",
            "--package"
          ],
          "description": "Package to document",
          "args": {
            "name": "package",
            "isVariadic": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "metadata",
                  "--format-version",
                  "1",
                  "--no-deps"
                ]
              }
            ]
          }
        },
        {
          "names": [
            "-j",
            "--jobs"
          ],
          "description": "Number of parallel jobs, defaults to # of CPUs",
          "args": {
            "name": "jobs"
          }
        },
        {
          "names": [
            "--bin"
          ],
          "description": "Build only the specified binary",
          "args": {
            "name": "bin",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--example"
          ],
          "description": "Build only the specified example",
          "args": {
            "name": "example",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--test"
          ],
          "description": "Build only the specified test target",
          "args": {
            "name": "test",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--bench"
          ],
          "description": "Build only the specified bench target",
          "args": {
            "name": "bench",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--profile"
          ],
          "description": "Build artifacts with the specified profile",
          "args": {
            "name": "profile"
          }
        },
        {
          "names": [
            "--features"
          ],
          "description": "Space or comma separated list of features to activate",
          "args": {
            "name": "features",
            "isVariadic": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "read-manifest"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--target"
          ],
          "description": "Build for the target triple",
          "args": {
            "name": "target",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "rustc",
                  "--print",
                  "target-list"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--target-dir"
          ],
          "description": "Directory for all generated artifacts",
          "args": {
            "name": "target-dir"
          }
        },
        {
          "names": [
            "--manifest-path"
          ],
          "description": "Path to Cargo.toml",
          "args": {
            "name": "manifest-path"
          }
        },
        {
          "names": [
            "--message-format"
          ],
          "description": "Error format",
          "args": {
            "name": "message-format"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "always",
              "never",
              "auto"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "--open"
          ],
          "description": "Opens the docs in a browser after the operation"
        },
        {
          "names": [
            "--lib"
          ],
          "description": "Build only this package's library"
        },
        {
          "names": [
            "--bins"
          ],
          "description": "Build all binaries"
        },
        {
          "names": [
            "--examples"
          ],
          "description": "Build all examples"
        },
        {
          "names": [
            "--tests"
          ],
          "description": "Build all tests"
        },
        {
          "names": [
            "--benches"
          ],
          "description": "Build all benches"
        },
        {
          "names": [
            "--all-targets"
          ],
          "description": "Build all targets"
        },
        {
          "names": [
            "-r",
            "--release"
          ],
          "description": "Build artifacts in release mode, with optimizations"
        },
        {
          "names": [
            "--all-features"
          ],
          "description": "Activate all available features"
        },
        {
          "names": [
            "--no-default-features"
          ],
          "description": "Do not activate the `default` feature"
        },
        {
          "names": [
            "--unit-graph"
          ],
          "description": "Output build graph in JSON (unstable)"
        },
        {
          "names": [
            "--ignore-rust-version"
          ],
          "description": "Ignore `rust-version` specification in packages"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        },
        {
          "names": [
            "--timings"
          ],
          "description": "Timing output formats (unstable)"
        }
      ],
      "args": [
        {
          "name": "args",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "search",
      "description": "Search packages in crates.io",
      "options": [
        {
          "names": [
            "--index"
          ],
          "description": "Registry index URL to upload the package to",
          "args": {
            "name": "index"
          }
        },
        {
          "names": [
            "--limit"
          ],
          "description": "Limit the number of results (default: 10, max: 100)",
          "args": {
            "name": "limit"
          }
        },
        {
          "names": [
            "--registry"
          ],
          "description": "Registry to use",
          "args": {
            "name": "registry"
          }
        },
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color"
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        }
      ],
      "args": [
        {
          "name": "query",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "test",
      "aliases": [
        "t"
      ],
      "description": "Execute all unit and integration tests and build examples of a local package",
      "options": [
        {
          "names": [
            "--bin"
          ],
          "description": "Test only the specified binary",
          "args": {
            "name": "bin",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--example"
          ],
          "description": "Test only the specified example",
          "args": {
            "name": "example",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--test"
          ],
          "description": "Test only the specified test target",
          "args": {
            "name": "test",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--bench"
          ],
          "description": "Test only the specified bench target",
          "args": {
            "name": "bench",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-p",
            "--package"
          ],
          "description": "Package to run tests for",
          "args": {
            "name": "package",
            "isVariadic": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "metadata",
                  "--format-version",
                  "1",
                  "--no-deps"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--exclude"
          ],
          "description": "Exclude packages from the test",
          "args": {
            "name": "exclude",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "metadata",
                  "--format-version",
                  "1",
                  "--no-deps"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-j",
            "--jobs"
          ],
          "description": "Number of parallel jobs, defaults to # of CPUs",
          "args": {
            "name": "jobs"
          }
        },
        {
          "names": [
            "--profile"
          ],
          "description": "Build artifacts with the specified profile",
          "args": {
            "name": "profile"
          }
        },
        {
          "names": [
            "--features"
          ],
          "description": "Space or comma separated list of features to activate",
          "args": {
            "name": "features",
            "isVariadic": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "read-manifest"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--target"
          ],
          "description": "Build for the target triple",
          "args": {
            "name": "target",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "rustc",
                  "--print",
                  "target-list"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--target-dir"
          ],
          "description": "Directory for all generated artifacts",
          "args": {
            "name": "target-dir"
          }
        },
        {
          "names": [
            "--manifest-path"
          ],
          "description": "Path to Cargo.toml",
          "args": {
            "name": "manifest-path"
          }
        },
        {
          "names": [
            "--message-format"
          ],
          "description": "Error format",
          "args": {
            "name": "message-format"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "auto",
              "always",
              "never"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Display one character per test instead of one line"
        },
        {
          "names": [
            "--lib"
          ],
          "description": "Test only this package's library unit tests"
        },
        {
          "names": [
            "--bins"
          ],
          "description": "Test all binaries"
        },
        {
          "names": [
            "--examples"
          ],
          "description": "Test all examples"
        },
        {
          "names": [
            "--tests"
          ],
          "description": "Test all tests"
        },
        {
          "names": [
            "--benches"
          ],
          "description": "Test all benches"
        },
        {
          "names": [
            "--all-targets"
          ],
          "description": "Test all targets"
        },
        {
          "names": [
            "--doc"
          ],
          "description": "Test only this library's documentation"
        },
        {
          "names": [
            "--no-run"
          ],
          "description": "Compile, but don't run tests"
        },
        {
          "names": [
            "--no-fail-fast"
          ],
          "description": "Run all tests regardless of failure"
        },
        {
          "names": [
            "--workspace"
          ],
          "description": "Test all packages in the workspace"
        },
        {
          "names": [
            "--all"
          ],
          "description": "Alias for --workspace (deprecated)"
        },
        {
          "names": [
            "-r",
            "--release"
          ],
          "description": "Build artifacts in release mode, with optimizations"
        },
        {
          "names": [
            "--all-features"
          ],
          "description": "Activate all available features"
        },
        {
          "names": [
            "--no-default-features"
          ],
          "description": "Do not activate the `default` feature"
        },
        {
          "names": [
            "--ignore-rust-version"
          ],
          "description": "Ignore `rust-version` specification in packages"
        },
        {
          "names": [
            "--unit-graph"
          ],
          "description": "Output build graph in JSON (unstable)"
        },
        {
          "names": [
            "--future-incompat-report"
          ],
          "description": "Outputs a future incompatibility report at the end of the build"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        },
        {
          "names": [
            "--timings"
          ],
          "description": "Timing output formats (unstable)"
        }
      ],
      "args": [
        {
          "name": "TESTNAME",
          "isOptional": true
        },
        {
          "name": "args",
          "isVariadic": true,
          "isOptional": true
        }
      ]
    },
    {
      "name": "tree",
      "description": "Display a tree visualization of a dependency graph",
      "options": [
        {
          "names": [
            "--manifest-path"
          ],
          "description": "Path to Cargo.toml",
          "args": {
            "name": "manifest-path"
          }
        },
        {
          "names": [
            "-p",
            "--package"
          ],
          "description": "Package to be used as the root of the tree",
          "args": {
            "name": "package",
            "isVariadic": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "metadata",
                  "--format-version",
                  "1",
                  "--no-deps"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--exclude"
          ],
          "description": "Exclude specific workspace members",
          "args": {
            "name": "exclude",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "metadata",
                  "--format-version",
                  "1",
                  "--no-deps"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--features"
          ],
          "description": "Space or comma separated list of features to activate",
          "args": {
            "name": "features",
            "isVariadic": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "read-manifest"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--target"
          ],
          "description": "Filter dependencies matching the given target-triple (default host platform). Pass `all` to include all targets",
          "args": {
            "name": "target",
            "suggestions": [
              "all"
            ],
            "generators": [
              {
                "kind": "script",
                "script": [
                  "rustc",
                  "--print",
                  "target-list"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-e",
            "--edges"
          ],
          "description": "The kinds of dependencies to display (features, normal, build, dev, all, no-normal, no-build, no-dev, no-proc-macro)",
          "args": {
            "name": "edges",
            "suggestions": [
              "features",
              "normal",
              "build",
              "dev",
              "all",
              "no-normal",
              "no-build",
              "no-dev",
              "no-proc-macro"
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-i",
            "--invert"
          ],
          "description": "Invert the tree direction and focus on the given package",
          "args": {
            "name": "invert",
            "isVariadic": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "metadata",
                  "--format-version",
                  "1"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--prune"
          ],
          "description": "Prune the given package from the display of the dependency tree",
          "args": {
            "name": "prune",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "metadata",
                  "--format-version",
                  "1"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--depth"
          ],
          "description": "Maximum display depth of the dependency tree",
          "args": {
            "name": "depth"
          }
        },
        {
          "names": [
            "--prefix"
          ],
          "description": "Change the prefix (indentation) of how each entry is displayed",
          "args": {
            "name": "prefix",
            "suggestions": [
              "depth",
              "indent",
              "none"
            ]
          }
        },
        {
          "names": [
            "--charset"
          ],
          "description": "Character set to use in output: utf8, ascii",
          "args": {
            "name": "charset",
            "suggestions": [
              "utf8",
              "ascii"
            ]
          }
        },
        {
          "names": [
            "-f",
            "--format"
          ],
          "description": "Format string used for printing dependencies",
          "args": {
            "name": "format"
          }
        },
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "auto",
              "always",
              "never"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "--workspace"
          ],
          "description": "Display the tree for all packages in the workspace"
        },
        {
          "names": [
            "-a",
            "--all"
          ]
        },
        {
          "names": [
            "--all-targets"
          ]
        },
        {
          "names": [
            "--all-features"
          ],
          "description": "Activate all available features"
        },
        {
          "names": [
            "--no-default-features"
          ],
          "description": "Do not activate the `default` feature"
        },
        {
          "names": [
            "--no-dev-dependencies"
          ]
        },
        {
          "names": [
            "--no-indent"
          ]
        },
        {
          "names": [
            "--prefix-depth"
          ]
        },
        {
          "names": [
            "--no-dedupe"
          ],
          "description": "Do not de-duplicate (repeats all shared dependencies)"
        },
        {
          "names": [
            "-d",
            "--duplicates"
          ],
          "description": "Show only dependencies which come in multiple versions (implies -i)"
        },
        {
          "names": [
            "-V",
            "--version"
          ]
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        }
      ]
    },
    {
      "name": "uninstall",
      "description": "Remove a Rust binary",
      "options": [
        {
          "names": [
            "-p",
            "--package"
          ],
          "description": "Package to uninstall",
          "args": {
            "name": "package",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--bin"
          ],
          "description": "Only uninstall the binary NAME",
          "args": {
            "name": "bin"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--root"
          ],
          "description": "Directory to uninstall packages from",
          "args": {
            "name": "root"
          }
        },
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "auto",
              "always",
              "never"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        }
      ],
      "args": [
        {
          "name": "SPEC",
          "isVariadic": true,
          "generators": [
            {
              "kind": "script",
              "script": [
                "bash",
                "-c",
                "cargo install --list | \\grep -E \"^[a-zA-Z\\-]+\\sv\" | cut -d ' ' -f 1"
              ],
              "splitOn": "\n"
            }
          ]
        }
      ]
    },
    {
      "name": "update",
      "description": "Update dependencies as recorded in the local lock file",
      "options": [
        {
          "names": [
            "-p",
            "--package"
          ],
          "description": "Package to update",
          "args": {
            "name": "package",
            "isVariadic": true,
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "metadata",
                  "--format-version",
                  "1"
                ]
              }
            ]
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--precise"
          ],
          "description": "Update a single dependency to exactly PRECISE when used with -p",
          "args": {
            "name": "precise"
          }
        },
        {
          "names": [
            "--manifest-path"
          ],
          "description": "Path to Cargo.toml",
          "args": {
            "name": "manifest-path"
          }
        },
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "always",
              "never",
              "auto"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "-w",
            "--workspace"
          ],
          "description": "Only update the workspace packages"
        },
        {
          "names": [
            "--aggressive"
          ],
          "description": "Force updating all dependencies of SPEC as well when used with -p"
        },
        {
          "names": [
            "--dry-run"
          ],
          "description": "Don't actually write the lockfile"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        }
      ]
    },
    {
      "name": "vendor",
      "description": "Vendor all dependencies for a project locally",
      "options": [
        {
          "names": [
            "--manifest-path"
          ],
          "description": "Path to Cargo.toml",
          "args": {
            "name": "manifest-path"
          }
        },
        {
          "names": [
            "-s",
            "--sync"
          ],
          "description": "Additional `Cargo.toml` to sync and vendor",
          "args": {
            "name": "tomls",
            "isVariadic": true
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "always",
              "never",
              "auto"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "--no-delete"
          ],
          "description": "Don't delete older crates in the vendor directory"
        },
        {
          "names": [
            "--respect-source-config"
          ],
          "description": "Respect `[source]` config in `.cargo/config`",
          "isRepeatable": true
        },
        {
          "names": [
            "--versioned-dirs"
          ],
          "description": "Always include version in subdir name"
        },
        {
          "names": [
            "--no-merge-sources"
          ]
        },
        {
          "names": [
            "--relative-path"
          ]
        },
        {
          "names": [
            "--only-git-deps"
          ]
        },
        {
          "names": [
            "--disallow-duplicates"
          ]
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        }
      ],
      "args": [
        {
          "name": "path"
        }
      ]
    },
    {
      "name": "verify-project",
      "description": "Check correctness of crate manifest",
      "options": [
        {
          "names": [
            "--manifest-path"
          ],
          "description": "Path to Cargo.toml",
          "args": {
            "name": "manifest-path"
          }
        },
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "always",
              "never",
              "auto"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        }
      ]
    },
    {
      "name": "version",
      "description": "Show version information",
      "options": [
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "always",
              "never",
              "auto"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        }
      ]
    },
    {
      "name": "yank",
      "description": "Remove a pushed crate from the index",
      "options": [
        {
          "names": [
            "--vers"
          ],
          "description": "The version to yank or un-yank",
          "args": {
            "name": "vers"
          }
        },
        {
          "names": [
            "--index"
          ],
          "description": "Registry index to yank from",
          "args": {
            "name": "index"
          }
        },
        {
          "names": [
            "--token"
          ],
          "description": "API token to use when authenticating",
          "args": {
            "name": "token"
          }
        },
        {
          "names": [
            "--registry"
          ],
          "description": "Registry to use",
          "args": {
            "name": "registry"
          }
        },
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "always",
              "never",
              "auto"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "--undo"
          ],
          "description": "Undo a yank, putting a version back into the index"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        }
      ],
      "args": [
        {
          "name": "crate"
        }
      ]
    },
    {
      "name": "help",
      "description": "Print this message or the help of the given subcommand(s)",
      "options": [
        {
          "names": [
            "--color"
          ],
          "description": "Coloring: auto, always, never",
          "args": {
            "name": "color",
            "suggestions": [
              "always",
              "never",
              "auto"
            ]
          }
        },
        {
          "names": [
            "--config"
          ],
          "description": "Override a configuration value",
          "args": {
            "name": "config"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-Z"
          ],
          "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
          "args": {
            "name": "unstable-features"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output (-vv very verbose/build.rs output)",
          "isRepeatable": true
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        }
      ],
      "args": [
        {
          "name": "subcommand"
        }
      ]
    },
    {
      "name": "add",
      "description": "Add dependencies to a Cargo.toml manifest file",
      "options": [
        {
          "names": [
            "--no-default-features"
          ],
          "description": "Disable the default features"
        },
        {
          "names": [
            "--default-features"
          ],
          "description": "Re-enable the default features"
        },
        {
          "names": [
            "-F",
            "--features"
          ],
          "description": "Space or comma separated list of features to activate"
        },
        {
          "names": [
            "--optional"
          ],
          "description": "Mark the dependency as optional"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output"
        },
        {
          "names": [
            "--no-optional"
          ],
          "description": "Mark the dependency as required"
        },
        {
          "names": [
            "--color"
          ],
          "args": {
            "name": "WHEN",
            "suggestions": [
              "auto",
              "always",
              "never"
            ]
          }
        },
        {
          "names": [
            "--rename"
          ],
          "description": "Rename the dependency",
          "args": {
            "name": "NAME"
          }
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--manifest-path"
          ],
          "description": "Path to Cargo.toml"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "-p",
            "--package"
          ],
          "description": "Package to modify",
          "args": {
            "name": "SPEC",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "metadata",
                  "--format-version",
                  "1",
                  "--no-deps"
                ]
              }
            ]
          }
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "--dry-run"
          ],
          "description": "Don't actually write the manifest"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        },
        {
          "names": [
            "--path"
          ],
          "description": "Filesystem path to local crate to add",
          "args": {
            "name": "PATH"
          }
        },
        {
          "names": [
            "--git"
          ],
          "description": "Git repository location",
          "args": {
            "name": "URI"
          }
        },
        {
          "names": [
            "--branch"
          ],
          "description": "Git branch to download the crate from",
          "args": {
            "name": "BRANCH"
          }
        },
        {
          "names": [
            "--tag"
          ],
          "description": "Git tag to download the crate from",
          "args": {
            "name": "TAG"
          }
        },
        {
          "names": [
            "--rev"
          ],
          "description": "Git reference to download the crate from",
          "args": {
            "name": "REV"
          }
        },
        {
          "names": [
            "--registry"
          ],
          "description": "Package registry for this dependency",
          "args": {
            "name": "NAME"
          }
        },
        {
          "names": [
            "--dev"
          ],
          "description": "Add as development dependency"
        },
        {
          "names": [
            "--build"
          ],
          "description": "Add as build dependency"
        },
        {
          "names": [
            "--target"
          ],
          "description": "Add as dependency to the given target platform",
          "args": {
            "name": "TARGET",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "rustc",
                  "--print",
                  "target-list"
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "DEP_ID",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "remove",
      "aliases": [
        "rm"
      ],
      "description": "Remove dependencies from a Cargo.toml manifest file",
      "options": [
        {
          "names": [
            "--dev"
          ],
          "description": "Remove as development dependency"
        },
        {
          "names": [
            "--build"
          ],
          "description": "Remove as build dependency"
        },
        {
          "names": [
            "--target"
          ],
          "description": "Remove as dependency to the given target platform",
          "args": {
            "name": "TARGET",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "rustc",
                  "--print",
                  "target-list"
                ]
              }
            ]
          }
        },
        {
          "names": [
            "-p",
            "--package"
          ],
          "description": "Package to remove from",
          "args": {
            "name": "SPEC",
            "generators": [
              {
                "kind": "script",
                "script": [
                  "cargo",
                  "metadata",
                  "--format-version",
                  "1",
                  "--no-deps"
                ]
              }
            ]
          }
        },
        {
          "names": [
            "--manifest-path"
          ],
          "description": "Path to Cargo.toml"
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Do not print cargo log messages"
        },
        {
          "names": [
            "--dry-run"
          ],
          "description": "Don't actually write the manifest"
        },
        {
          "names": [
            "-v",
            "--verbose"
          ],
          "description": "Use verbose output"
        },
        {
          "names": [
            "--color"
          ],
          "args": {
            "name": "WHEN",
            "suggestions": [
              "auto",
              "always",
              "never"
            ]
          }
        },
        {
          "names": [
            "--frozen"
          ],
          "description": "Require Cargo.lock and cache are up to date"
        },
        {
          "names": [
            "--locked"
          ],
          "description": "Require Cargo.lock is up to date"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Run without accessing the network"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Print help information"
        }
      ],
      "args": [
        {
          "name": "DEP_ID",
          "isVariadic": true,
          "generators": [
            {
              "kind": "script",
              "script": [
                "cargo",
                "metadata",
                "--format-version",
                "1"
              ]
            }
          ]
        }
      ]
    }
  ],
  "options": [
    {
      "names": [
        "--explain"
      ],
      "description": "Run `rustc --explain CODE`",
      "args": {
        "name": "explain"
      }
    },
    {
      "names": [
        "--color"
      ],
      "description": "Coloring: auto, always, never",
      "args": {
        "name": "color",
        "suggestions": [
          "always",
          "never",
          "auto"
        ]
      }
    },
    {
      "names": [
        "--config"
      ],
      "description": "Override a configuration value",
      "args": {
        "name": "config"
      },
      "isRepeatable": true
    },
    {
      "names": [
        "-Z"
      ],
      "description": "Unstable (nightly-only) flags to Cargo, see 'cargo -Z help' for details",
      "args": {
        "name": "unstable-features"
      },
      "isRepeatable": true
    },
    {
      "names": [
        "-h",
        "--help"
      ],
      "description": "Print help information"
    },
    {
      "names": [
        "-V",
        "--version"
      ],
      "description": "Print version info and exit"
    },
    {
      "names": [
        "--list"
      ],
      "description": "List installed commands"
    },
    {
      "names": [
        "-v",
        "--verbose"
      ],
      "description": "Use verbose output (-vv very verbose/build.rs output)",
      "isRepeatable": true
    },
    {
      "names": [
        "-q",
        "--quiet"
      ],
      "description": "Do not print cargo log messages"
    },
    {
      "names": [
        "--frozen"
      ],
      "description": "Require Cargo.lock and cache are up to date"
    },
    {
      "names": [
        "--locked"
      ],
      "description": "Require Cargo.lock is up to date"
    },
    {
      "names": [
        "--offline"
      ],
      "description": "Run without accessing the network"
    }
  ]
};
