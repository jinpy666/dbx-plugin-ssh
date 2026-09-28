// 由 scripts/sync_fig_specs.mjs 生成（withfig/autocomplete @ aef52acff84c45edde61ae610cc2c964802b9a38）——纯数据，勿手改。
// 归一化形态见 src/lib/completion/fig/types.ts；重生成：pnpm fig:sync
import type { FigSpecRoot } from "../../../src/lib/completion/fig/types";

export const spec: FigSpecRoot = {
  "name": "yarn",
  "description": "Manage packages and run scripts",
  "subcommands": [
    {
      "name": "add",
      "description": "Installs a package and any packages that it depends on",
      "options": [
        {
          "names": [
            "-s",
            "--silent"
          ],
          "description": "Skip Yarn console logs"
        },
        {
          "names": [
            "--no-default-rc"
          ],
          "description": "Prevent Yarn from automatically detecting yarnrc and npmrc files"
        },
        {
          "names": [
            "--use-yarnrc"
          ],
          "description": "Specifies a yarnrc file that Yarn should use (.yarnrc only, not .npmrc) (default: )",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--verbose"
          ],
          "description": "Output verbose messages on internal operations"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Trigger an error if any required dependencies are not available in local cache"
        },
        {
          "names": [
            "--prefer-offline"
          ],
          "description": "Use network only if dependencies are not available in local cache"
        },
        {
          "names": [
            "--enable-pnp",
            "--pnp"
          ],
          "description": "Enable the Plug'n'Play installation"
        },
        {
          "names": [
            "--json"
          ],
          "description": "Format Yarn log messages as lines of JSON"
        },
        {
          "names": [
            "--ignore-scripts"
          ],
          "description": "Don't run lifecycle scripts"
        },
        {
          "names": [
            "--har"
          ],
          "description": "Save HAR output of network traffic"
        },
        {
          "names": [
            "--ignore-platform"
          ],
          "description": "Ignore platform checks"
        },
        {
          "names": [
            "--ignore-engines"
          ],
          "description": "Ignore engines check"
        },
        {
          "names": [
            "--ignore-optional"
          ],
          "description": "Ignore optional dependencies"
        },
        {
          "names": [
            "--force"
          ],
          "description": "Install and build packages even if they were built before, overwrite lockfile"
        },
        {
          "names": [
            "--skip-integrity-check"
          ],
          "description": "Run install without checking if node_modules is installed"
        },
        {
          "names": [
            "--check-files"
          ],
          "description": "Install will verify file tree of packages for consistency"
        },
        {
          "names": [
            "--no-bin-links"
          ],
          "description": "Don't generate bin links when setting up packages"
        },
        {
          "names": [
            "--flat"
          ],
          "description": "Only allow one version of a package"
        },
        {
          "names": [
            "--prod",
            "--production"
          ],
          "description": "Instruct Yarn to ignore NODE_ENV and take its production-or-not status from this flag instead"
        },
        {
          "names": [
            "--no-lockfile"
          ],
          "description": "Don't read or generate a lockfile"
        },
        {
          "names": [
            "--pure-lockfile"
          ],
          "description": "Don't generate a lockfile"
        },
        {
          "names": [
            "--frozen-lockfile"
          ],
          "description": "Don't generate a lockfile and fail if an update is needed"
        },
        {
          "names": [
            "--update-checksums"
          ],
          "description": "Update package checksums from current repository"
        },
        {
          "names": [
            "--link-duplicates"
          ],
          "description": "Create hardlinks to the repeated modules in node_modules"
        },
        {
          "names": [
            "--link-folder"
          ],
          "description": "Specify a custom folder to store global links",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--global-folder"
          ],
          "description": "Specify a custom folder to store global packages",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--modules-folder"
          ],
          "description": "Rather than installing modules into the node_modules folder relative to the cwd, output them here",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--preferred-cache-folder"
          ],
          "description": "Specify a custom folder to store the yarn cache if possible",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--cache-folder"
          ],
          "description": "Specify a custom folder that must be used to store the yarn cache",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--mutex"
          ],
          "description": "Use a mutex to ensure only one yarn instance is executing",
          "args": {
            "name": "type[:specifier]"
          }
        },
        {
          "names": [
            "--emoji"
          ],
          "description": "Enables emoji in output",
          "args": {
            "suggestions": [
              "true",
              "false"
            ]
          }
        },
        {
          "names": [
            "--cwd"
          ],
          "description": "Working directory to use",
          "args": {
            "name": "cwd"
          }
        },
        {
          "names": [
            "--proxy",
            "--https-proxy"
          ],
          "args": {
            "name": "host"
          }
        },
        {
          "names": [
            "--registry"
          ],
          "description": "Override configuration registry",
          "args": {
            "name": "url"
          }
        },
        {
          "names": [
            "--no-progress"
          ],
          "description": "Disable progress bar"
        },
        {
          "names": [
            "--network-concurrency"
          ],
          "description": "Maximum number of concurrent network requests",
          "args": {
            "name": "number"
          }
        },
        {
          "names": [
            "--network-timeout"
          ],
          "description": "TCP timeout for network requests",
          "args": {
            "name": "milliseconds"
          }
        },
        {
          "names": [
            "--non-interactive"
          ],
          "description": "Do not show interactive prompts"
        },
        {
          "names": [
            "--scripts-prepend-node-path"
          ],
          "description": "Prepend the node executable dir to the PATH in scripts"
        },
        {
          "names": [
            "--no-node-version-check"
          ],
          "description": "Do not warn when using a potentially unsupported Node version"
        },
        {
          "names": [
            "--focus"
          ],
          "description": "Focus on a single workspace by installing remote copies of its sibling workspaces"
        },
        {
          "names": [
            "--otp"
          ],
          "description": "One-time password for two factor authentication",
          "args": {
            "name": "otpcode"
          }
        },
        {
          "names": [
            "-W",
            "--ignore-workspace-root-check"
          ],
          "description": "Required to run yarn add inside a workspace root"
        },
        {
          "names": [
            "-D",
            "--dev"
          ],
          "description": "Save package to your `devDependencies`"
        },
        {
          "names": [
            "-P",
            "--peer"
          ],
          "description": "Save package to your `peerDependencies`"
        },
        {
          "names": [
            "-O",
            "--optional"
          ],
          "description": "Save package to your `optionalDependencies`"
        },
        {
          "names": [
            "-E",
            "--exact"
          ],
          "description": "Install exact version"
        },
        {
          "names": [
            "-T",
            "--tilde"
          ],
          "description": "Install most recent release with the same minor version"
        },
        {
          "names": [
            "-A",
            "--audit"
          ],
          "description": "Run vulnerability audit on installed packages"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Output usage information"
        }
      ],
      "args": [
        {
          "name": "package",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "audit",
      "description": "Perform a vulnerability audit against the installed packages",
      "options": [
        {
          "names": [
            "--summary"
          ],
          "description": "Only print the summary"
        },
        {
          "names": [
            "--groups"
          ],
          "description": "Only audit dependencies from listed groups. Default: devDependencies, dependencies, optionalDependencies",
          "args": {
            "name": "group_name",
            "isVariadic": true
          }
        },
        {
          "names": [
            "--level"
          ],
          "description": "Only print advisories with severity greater than or equal to one of the following: info|low|moderate|high|critical. Default: info",
          "args": {
            "name": "severity",
            "suggestions": [
              "info",
              "low",
              "moderate",
              "high",
              "critical"
            ]
          }
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Output usage information"
        }
      ]
    },
    {
      "name": "autoclean",
      "description": "Cleans and removes unnecessary files from package dependencies",
      "options": [
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Output usage information"
        },
        {
          "names": [
            "-i",
            "--init"
          ],
          "description": "Creates the .yarnclean file if it does not exist, and adds the default entries"
        },
        {
          "names": [
            "-f",
            "--force"
          ],
          "description": "If a .yarnclean file exists, run the clean process"
        }
      ]
    },
    {
      "name": "bin",
      "description": "Displays the location of the yarn bin folder",
      "options": [
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Output usage information"
        }
      ]
    },
    {
      "name": "cache",
      "description": "Yarn cache list will print out every cached package",
      "subcommands": [
        {
          "name": "clean",
          "description": "Clear global cache"
        },
        {
          "name": "dir",
          "description": "Print yarn’s global cache path"
        },
        {
          "name": "list",
          "description": "Print out every cached package",
          "options": [
            {
              "names": [
                "--pattern"
              ],
              "description": "Filter cached packages by pattern",
              "args": {
                "name": "pattern"
              }
            }
          ]
        }
      ],
      "options": [
        {
          "names": [
            "-s",
            "--silent"
          ],
          "description": "Skip Yarn console logs"
        },
        {
          "names": [
            "--no-default-rc"
          ],
          "description": "Prevent Yarn from automatically detecting yarnrc and npmrc files"
        },
        {
          "names": [
            "--use-yarnrc"
          ],
          "description": "Specifies a yarnrc file that Yarn should use (.yarnrc only, not .npmrc) (default: )",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--verbose"
          ],
          "description": "Output verbose messages on internal operations"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Trigger an error if any required dependencies are not available in local cache"
        },
        {
          "names": [
            "--prefer-offline"
          ],
          "description": "Use network only if dependencies are not available in local cache"
        },
        {
          "names": [
            "--enable-pnp",
            "--pnp"
          ],
          "description": "Enable the Plug'n'Play installation"
        },
        {
          "names": [
            "--json"
          ],
          "description": "Format Yarn log messages as lines of JSON"
        },
        {
          "names": [
            "--ignore-scripts"
          ],
          "description": "Don't run lifecycle scripts"
        },
        {
          "names": [
            "--har"
          ],
          "description": "Save HAR output of network traffic"
        },
        {
          "names": [
            "--ignore-platform"
          ],
          "description": "Ignore platform checks"
        },
        {
          "names": [
            "--ignore-engines"
          ],
          "description": "Ignore engines check"
        },
        {
          "names": [
            "--ignore-optional"
          ],
          "description": "Ignore optional dependencies"
        },
        {
          "names": [
            "--force"
          ],
          "description": "Install and build packages even if they were built before, overwrite lockfile"
        },
        {
          "names": [
            "--skip-integrity-check"
          ],
          "description": "Run install without checking if node_modules is installed"
        },
        {
          "names": [
            "--check-files"
          ],
          "description": "Install will verify file tree of packages for consistency"
        },
        {
          "names": [
            "--no-bin-links"
          ],
          "description": "Don't generate bin links when setting up packages"
        },
        {
          "names": [
            "--flat"
          ],
          "description": "Only allow one version of a package"
        },
        {
          "names": [
            "--prod",
            "--production"
          ],
          "description": "Instruct Yarn to ignore NODE_ENV and take its production-or-not status from this flag instead"
        },
        {
          "names": [
            "--no-lockfile"
          ],
          "description": "Don't read or generate a lockfile"
        },
        {
          "names": [
            "--pure-lockfile"
          ],
          "description": "Don't generate a lockfile"
        },
        {
          "names": [
            "--frozen-lockfile"
          ],
          "description": "Don't generate a lockfile and fail if an update is needed"
        },
        {
          "names": [
            "--update-checksums"
          ],
          "description": "Update package checksums from current repository"
        },
        {
          "names": [
            "--link-duplicates"
          ],
          "description": "Create hardlinks to the repeated modules in node_modules"
        },
        {
          "names": [
            "--link-folder"
          ],
          "description": "Specify a custom folder to store global links",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--global-folder"
          ],
          "description": "Specify a custom folder to store global packages",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--modules-folder"
          ],
          "description": "Rather than installing modules into the node_modules folder relative to the cwd, output them here",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--preferred-cache-folder"
          ],
          "description": "Specify a custom folder to store the yarn cache if possible",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--cache-folder"
          ],
          "description": "Specify a custom folder that must be used to store the yarn cache",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--mutex"
          ],
          "description": "Use a mutex to ensure only one yarn instance is executing",
          "args": {
            "name": "type[:specifier]"
          }
        },
        {
          "names": [
            "--emoji"
          ],
          "description": "Enables emoji in output",
          "args": {
            "suggestions": [
              "true",
              "false"
            ]
          }
        },
        {
          "names": [
            "--cwd"
          ],
          "description": "Working directory to use",
          "args": {
            "name": "cwd"
          }
        },
        {
          "names": [
            "--proxy",
            "--https-proxy"
          ],
          "args": {
            "name": "host"
          }
        },
        {
          "names": [
            "--registry"
          ],
          "description": "Override configuration registry",
          "args": {
            "name": "url"
          }
        },
        {
          "names": [
            "--no-progress"
          ],
          "description": "Disable progress bar"
        },
        {
          "names": [
            "--network-concurrency"
          ],
          "description": "Maximum number of concurrent network requests",
          "args": {
            "name": "number"
          }
        },
        {
          "names": [
            "--network-timeout"
          ],
          "description": "TCP timeout for network requests",
          "args": {
            "name": "milliseconds"
          }
        },
        {
          "names": [
            "--non-interactive"
          ],
          "description": "Do not show interactive prompts"
        },
        {
          "names": [
            "--scripts-prepend-node-path"
          ],
          "description": "Prepend the node executable dir to the PATH in scripts"
        },
        {
          "names": [
            "--no-node-version-check"
          ],
          "description": "Do not warn when using a potentially unsupported Node version"
        },
        {
          "names": [
            "--focus"
          ],
          "description": "Focus on a single workspace by installing remote copies of its sibling workspaces"
        },
        {
          "names": [
            "--otp"
          ],
          "description": "One-time password for two factor authentication",
          "args": {
            "name": "otpcode"
          }
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Output usage information"
        }
      ]
    },
    {
      "name": "config",
      "description": "Configure yarn",
      "subcommands": [
        {
          "name": "set",
          "description": "Sets the config key to a certain value",
          "options": [
            {
              "names": [
                "-g",
                "--global"
              ],
              "description": "Set global config"
            }
          ]
        },
        {
          "name": "get",
          "description": "Print the value for a given key",
          "args": [
            {
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "yarn",
                    "config",
                    "list"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "delete",
          "description": "Deletes a given key from the config",
          "args": [
            {
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "yarn",
                    "config",
                    "list"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "list",
          "description": "Displays the current configuration"
        }
      ],
      "options": [
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Output usage information"
        }
      ]
    },
    {
      "name": "create",
      "description": "Creates new projects from any create-* starter kits",
      "options": [
        {
          "names": [
            "-s",
            "--silent"
          ],
          "description": "Skip Yarn console logs"
        },
        {
          "names": [
            "--no-default-rc"
          ],
          "description": "Prevent Yarn from automatically detecting yarnrc and npmrc files"
        },
        {
          "names": [
            "--use-yarnrc"
          ],
          "description": "Specifies a yarnrc file that Yarn should use (.yarnrc only, not .npmrc) (default: )",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--verbose"
          ],
          "description": "Output verbose messages on internal operations"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Trigger an error if any required dependencies are not available in local cache"
        },
        {
          "names": [
            "--prefer-offline"
          ],
          "description": "Use network only if dependencies are not available in local cache"
        },
        {
          "names": [
            "--enable-pnp",
            "--pnp"
          ],
          "description": "Enable the Plug'n'Play installation"
        },
        {
          "names": [
            "--json"
          ],
          "description": "Format Yarn log messages as lines of JSON"
        },
        {
          "names": [
            "--ignore-scripts"
          ],
          "description": "Don't run lifecycle scripts"
        },
        {
          "names": [
            "--har"
          ],
          "description": "Save HAR output of network traffic"
        },
        {
          "names": [
            "--ignore-platform"
          ],
          "description": "Ignore platform checks"
        },
        {
          "names": [
            "--ignore-engines"
          ],
          "description": "Ignore engines check"
        },
        {
          "names": [
            "--ignore-optional"
          ],
          "description": "Ignore optional dependencies"
        },
        {
          "names": [
            "--force"
          ],
          "description": "Install and build packages even if they were built before, overwrite lockfile"
        },
        {
          "names": [
            "--skip-integrity-check"
          ],
          "description": "Run install without checking if node_modules is installed"
        },
        {
          "names": [
            "--check-files"
          ],
          "description": "Install will verify file tree of packages for consistency"
        },
        {
          "names": [
            "--no-bin-links"
          ],
          "description": "Don't generate bin links when setting up packages"
        },
        {
          "names": [
            "--flat"
          ],
          "description": "Only allow one version of a package"
        },
        {
          "names": [
            "--prod",
            "--production"
          ],
          "description": "Instruct Yarn to ignore NODE_ENV and take its production-or-not status from this flag instead"
        },
        {
          "names": [
            "--no-lockfile"
          ],
          "description": "Don't read or generate a lockfile"
        },
        {
          "names": [
            "--pure-lockfile"
          ],
          "description": "Don't generate a lockfile"
        },
        {
          "names": [
            "--frozen-lockfile"
          ],
          "description": "Don't generate a lockfile and fail if an update is needed"
        },
        {
          "names": [
            "--update-checksums"
          ],
          "description": "Update package checksums from current repository"
        },
        {
          "names": [
            "--link-duplicates"
          ],
          "description": "Create hardlinks to the repeated modules in node_modules"
        },
        {
          "names": [
            "--link-folder"
          ],
          "description": "Specify a custom folder to store global links",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--global-folder"
          ],
          "description": "Specify a custom folder to store global packages",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--modules-folder"
          ],
          "description": "Rather than installing modules into the node_modules folder relative to the cwd, output them here",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--preferred-cache-folder"
          ],
          "description": "Specify a custom folder to store the yarn cache if possible",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--cache-folder"
          ],
          "description": "Specify a custom folder that must be used to store the yarn cache",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--mutex"
          ],
          "description": "Use a mutex to ensure only one yarn instance is executing",
          "args": {
            "name": "type[:specifier]"
          }
        },
        {
          "names": [
            "--emoji"
          ],
          "description": "Enables emoji in output",
          "args": {
            "suggestions": [
              "true",
              "false"
            ]
          }
        },
        {
          "names": [
            "--cwd"
          ],
          "description": "Working directory to use",
          "args": {
            "name": "cwd"
          }
        },
        {
          "names": [
            "--proxy",
            "--https-proxy"
          ],
          "args": {
            "name": "host"
          }
        },
        {
          "names": [
            "--registry"
          ],
          "description": "Override configuration registry",
          "args": {
            "name": "url"
          }
        },
        {
          "names": [
            "--no-progress"
          ],
          "description": "Disable progress bar"
        },
        {
          "names": [
            "--network-concurrency"
          ],
          "description": "Maximum number of concurrent network requests",
          "args": {
            "name": "number"
          }
        },
        {
          "names": [
            "--network-timeout"
          ],
          "description": "TCP timeout for network requests",
          "args": {
            "name": "milliseconds"
          }
        },
        {
          "names": [
            "--non-interactive"
          ],
          "description": "Do not show interactive prompts"
        },
        {
          "names": [
            "--scripts-prepend-node-path"
          ],
          "description": "Prepend the node executable dir to the PATH in scripts"
        },
        {
          "names": [
            "--no-node-version-check"
          ],
          "description": "Do not warn when using a potentially unsupported Node version"
        },
        {
          "names": [
            "--focus"
          ],
          "description": "Focus on a single workspace by installing remote copies of its sibling workspaces"
        },
        {
          "names": [
            "--otp"
          ],
          "description": "One-time password for two factor authentication",
          "args": {
            "name": "otpcode"
          }
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Output usage information"
        }
      ],
      "args": [
        {
          "name": "cli"
        }
      ]
    },
    {
      "name": "exec",
      "options": [
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Output usage information"
        }
      ]
    },
    {
      "name": "generate-lock-entry",
      "description": "Generates a lock file entry",
      "options": [
        {
          "names": [
            "--use-manifest"
          ],
          "description": "Specify which manifest file to use for generating lock entry"
        },
        {
          "names": [
            "--resolved"
          ],
          "description": "Generate from <*.tgz>#<hash>"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Output usage information"
        }
      ]
    },
    {
      "name": "global",
      "description": "Manage yarn globally",
      "subcommands": [
        {
          "name": "add",
          "description": "Install globally packages on your operating system",
          "args": [
            {
              "name": "package",
              "isVariadic": true
            }
          ]
        },
        {
          "name": "bin",
          "description": "Displays the location of the yarn global bin folder"
        },
        {
          "name": "dir",
          "description": "Displays the location of the global installation folder"
        },
        {
          "name": "ls",
          "description": "List globally installed packages (deprecated)"
        },
        {
          "name": "list",
          "description": "List globally installed packages"
        },
        {
          "name": "remove",
          "description": "Remove globally installed packages",
          "options": [
            {
              "names": [
                "-s",
                "--silent"
              ],
              "description": "Skip Yarn console logs"
            },
            {
              "names": [
                "--no-default-rc"
              ],
              "description": "Prevent Yarn from automatically detecting yarnrc and npmrc files"
            },
            {
              "names": [
                "--use-yarnrc"
              ],
              "description": "Specifies a yarnrc file that Yarn should use (.yarnrc only, not .npmrc) (default: )",
              "args": {
                "name": "path"
              }
            },
            {
              "names": [
                "--verbose"
              ],
              "description": "Output verbose messages on internal operations"
            },
            {
              "names": [
                "--offline"
              ],
              "description": "Trigger an error if any required dependencies are not available in local cache"
            },
            {
              "names": [
                "--prefer-offline"
              ],
              "description": "Use network only if dependencies are not available in local cache"
            },
            {
              "names": [
                "--enable-pnp",
                "--pnp"
              ],
              "description": "Enable the Plug'n'Play installation"
            },
            {
              "names": [
                "--json"
              ],
              "description": "Format Yarn log messages as lines of JSON"
            },
            {
              "names": [
                "--ignore-scripts"
              ],
              "description": "Don't run lifecycle scripts"
            },
            {
              "names": [
                "--har"
              ],
              "description": "Save HAR output of network traffic"
            },
            {
              "names": [
                "--ignore-platform"
              ],
              "description": "Ignore platform checks"
            },
            {
              "names": [
                "--ignore-engines"
              ],
              "description": "Ignore engines check"
            },
            {
              "names": [
                "--ignore-optional"
              ],
              "description": "Ignore optional dependencies"
            },
            {
              "names": [
                "--force"
              ],
              "description": "Install and build packages even if they were built before, overwrite lockfile"
            },
            {
              "names": [
                "--skip-integrity-check"
              ],
              "description": "Run install without checking if node_modules is installed"
            },
            {
              "names": [
                "--check-files"
              ],
              "description": "Install will verify file tree of packages for consistency"
            },
            {
              "names": [
                "--no-bin-links"
              ],
              "description": "Don't generate bin links when setting up packages"
            },
            {
              "names": [
                "--flat"
              ],
              "description": "Only allow one version of a package"
            },
            {
              "names": [
                "--prod",
                "--production"
              ],
              "description": "Instruct Yarn to ignore NODE_ENV and take its production-or-not status from this flag instead"
            },
            {
              "names": [
                "--no-lockfile"
              ],
              "description": "Don't read or generate a lockfile"
            },
            {
              "names": [
                "--pure-lockfile"
              ],
              "description": "Don't generate a lockfile"
            },
            {
              "names": [
                "--frozen-lockfile"
              ],
              "description": "Don't generate a lockfile and fail if an update is needed"
            },
            {
              "names": [
                "--update-checksums"
              ],
              "description": "Update package checksums from current repository"
            },
            {
              "names": [
                "--link-duplicates"
              ],
              "description": "Create hardlinks to the repeated modules in node_modules"
            },
            {
              "names": [
                "--link-folder"
              ],
              "description": "Specify a custom folder to store global links",
              "args": {
                "name": "path"
              }
            },
            {
              "names": [
                "--global-folder"
              ],
              "description": "Specify a custom folder to store global packages",
              "args": {
                "name": "path"
              }
            },
            {
              "names": [
                "--modules-folder"
              ],
              "description": "Rather than installing modules into the node_modules folder relative to the cwd, output them here",
              "args": {
                "name": "path"
              }
            },
            {
              "names": [
                "--preferred-cache-folder"
              ],
              "description": "Specify a custom folder to store the yarn cache if possible",
              "args": {
                "name": "path"
              }
            },
            {
              "names": [
                "--cache-folder"
              ],
              "description": "Specify a custom folder that must be used to store the yarn cache",
              "args": {
                "name": "path"
              }
            },
            {
              "names": [
                "--mutex"
              ],
              "description": "Use a mutex to ensure only one yarn instance is executing",
              "args": {
                "name": "type[:specifier]"
              }
            },
            {
              "names": [
                "--emoji"
              ],
              "description": "Enables emoji in output",
              "args": {
                "suggestions": [
                  "true",
                  "false"
                ]
              }
            },
            {
              "names": [
                "--cwd"
              ],
              "description": "Working directory to use",
              "args": {
                "name": "cwd"
              }
            },
            {
              "names": [
                "--proxy",
                "--https-proxy"
              ],
              "args": {
                "name": "host"
              }
            },
            {
              "names": [
                "--registry"
              ],
              "description": "Override configuration registry",
              "args": {
                "name": "url"
              }
            },
            {
              "names": [
                "--no-progress"
              ],
              "description": "Disable progress bar"
            },
            {
              "names": [
                "--network-concurrency"
              ],
              "description": "Maximum number of concurrent network requests",
              "args": {
                "name": "number"
              }
            },
            {
              "names": [
                "--network-timeout"
              ],
              "description": "TCP timeout for network requests",
              "args": {
                "name": "milliseconds"
              }
            },
            {
              "names": [
                "--non-interactive"
              ],
              "description": "Do not show interactive prompts"
            },
            {
              "names": [
                "--scripts-prepend-node-path"
              ],
              "description": "Prepend the node executable dir to the PATH in scripts"
            },
            {
              "names": [
                "--no-node-version-check"
              ],
              "description": "Do not warn when using a potentially unsupported Node version"
            },
            {
              "names": [
                "--focus"
              ],
              "description": "Focus on a single workspace by installing remote copies of its sibling workspaces"
            },
            {
              "names": [
                "--otp"
              ],
              "description": "One-time password for two factor authentication",
              "args": {
                "name": "otpcode"
              }
            },
            {
              "names": [
                "-W",
                "--ignore-workspace-root-check"
              ],
              "description": "Required to run yarn remove inside a workspace root"
            },
            {
              "names": [
                "-h",
                "--help"
              ],
              "description": "Output usage information"
            }
          ],
          "args": [
            {
              "name": "package",
              "isVariadic": true
            }
          ]
        },
        {
          "name": "upgrade",
          "description": "Upgrade globally installed packages",
          "options": [
            {
              "names": [
                "-s",
                "--silent"
              ],
              "description": "Skip Yarn console logs"
            },
            {
              "names": [
                "--no-default-rc"
              ],
              "description": "Prevent Yarn from automatically detecting yarnrc and npmrc files"
            },
            {
              "names": [
                "--use-yarnrc"
              ],
              "description": "Specifies a yarnrc file that Yarn should use (.yarnrc only, not .npmrc) (default: )",
              "args": {
                "name": "path"
              }
            },
            {
              "names": [
                "--verbose"
              ],
              "description": "Output verbose messages on internal operations"
            },
            {
              "names": [
                "--offline"
              ],
              "description": "Trigger an error if any required dependencies are not available in local cache"
            },
            {
              "names": [
                "--prefer-offline"
              ],
              "description": "Use network only if dependencies are not available in local cache"
            },
            {
              "names": [
                "--enable-pnp",
                "--pnp"
              ],
              "description": "Enable the Plug'n'Play installation"
            },
            {
              "names": [
                "--json"
              ],
              "description": "Format Yarn log messages as lines of JSON"
            },
            {
              "names": [
                "--ignore-scripts"
              ],
              "description": "Don't run lifecycle scripts"
            },
            {
              "names": [
                "--har"
              ],
              "description": "Save HAR output of network traffic"
            },
            {
              "names": [
                "--ignore-platform"
              ],
              "description": "Ignore platform checks"
            },
            {
              "names": [
                "--ignore-engines"
              ],
              "description": "Ignore engines check"
            },
            {
              "names": [
                "--ignore-optional"
              ],
              "description": "Ignore optional dependencies"
            },
            {
              "names": [
                "--force"
              ],
              "description": "Install and build packages even if they were built before, overwrite lockfile"
            },
            {
              "names": [
                "--skip-integrity-check"
              ],
              "description": "Run install without checking if node_modules is installed"
            },
            {
              "names": [
                "--check-files"
              ],
              "description": "Install will verify file tree of packages for consistency"
            },
            {
              "names": [
                "--no-bin-links"
              ],
              "description": "Don't generate bin links when setting up packages"
            },
            {
              "names": [
                "--flat"
              ],
              "description": "Only allow one version of a package"
            },
            {
              "names": [
                "--prod",
                "--production"
              ],
              "description": "Instruct Yarn to ignore NODE_ENV and take its production-or-not status from this flag instead"
            },
            {
              "names": [
                "--no-lockfile"
              ],
              "description": "Don't read or generate a lockfile"
            },
            {
              "names": [
                "--pure-lockfile"
              ],
              "description": "Don't generate a lockfile"
            },
            {
              "names": [
                "--frozen-lockfile"
              ],
              "description": "Don't generate a lockfile and fail if an update is needed"
            },
            {
              "names": [
                "--update-checksums"
              ],
              "description": "Update package checksums from current repository"
            },
            {
              "names": [
                "--link-duplicates"
              ],
              "description": "Create hardlinks to the repeated modules in node_modules"
            },
            {
              "names": [
                "--link-folder"
              ],
              "description": "Specify a custom folder to store global links",
              "args": {
                "name": "path"
              }
            },
            {
              "names": [
                "--global-folder"
              ],
              "description": "Specify a custom folder to store global packages",
              "args": {
                "name": "path"
              }
            },
            {
              "names": [
                "--modules-folder"
              ],
              "description": "Rather than installing modules into the node_modules folder relative to the cwd, output them here",
              "args": {
                "name": "path"
              }
            },
            {
              "names": [
                "--preferred-cache-folder"
              ],
              "description": "Specify a custom folder to store the yarn cache if possible",
              "args": {
                "name": "path"
              }
            },
            {
              "names": [
                "--cache-folder"
              ],
              "description": "Specify a custom folder that must be used to store the yarn cache",
              "args": {
                "name": "path"
              }
            },
            {
              "names": [
                "--mutex"
              ],
              "description": "Use a mutex to ensure only one yarn instance is executing",
              "args": {
                "name": "type[:specifier]"
              }
            },
            {
              "names": [
                "--emoji"
              ],
              "description": "Enables emoji in output",
              "args": {
                "suggestions": [
                  "true",
                  "false"
                ]
              }
            },
            {
              "names": [
                "--cwd"
              ],
              "description": "Working directory to use",
              "args": {
                "name": "cwd"
              }
            },
            {
              "names": [
                "--proxy",
                "--https-proxy"
              ],
              "args": {
                "name": "host"
              }
            },
            {
              "names": [
                "--registry"
              ],
              "description": "Override configuration registry",
              "args": {
                "name": "url"
              }
            },
            {
              "names": [
                "--no-progress"
              ],
              "description": "Disable progress bar"
            },
            {
              "names": [
                "--network-concurrency"
              ],
              "description": "Maximum number of concurrent network requests",
              "args": {
                "name": "number"
              }
            },
            {
              "names": [
                "--network-timeout"
              ],
              "description": "TCP timeout for network requests",
              "args": {
                "name": "milliseconds"
              }
            },
            {
              "names": [
                "--non-interactive"
              ],
              "description": "Do not show interactive prompts"
            },
            {
              "names": [
                "--scripts-prepend-node-path"
              ],
              "description": "Prepend the node executable dir to the PATH in scripts"
            },
            {
              "names": [
                "--no-node-version-check"
              ],
              "description": "Do not warn when using a potentially unsupported Node version"
            },
            {
              "names": [
                "--focus"
              ],
              "description": "Focus on a single workspace by installing remote copies of its sibling workspaces"
            },
            {
              "names": [
                "--otp"
              ],
              "description": "One-time password for two factor authentication",
              "args": {
                "name": "otpcode"
              }
            },
            {
              "names": [
                "-S",
                "--scope"
              ],
              "description": "Upgrade packages under the specified scope",
              "args": {
                "name": "scope"
              }
            },
            {
              "names": [
                "-L",
                "--latest"
              ],
              "description": "List the latest version of packages"
            },
            {
              "names": [
                "-E",
                "--exact"
              ],
              "description": "Install exact version. Only used when --latest is specified"
            },
            {
              "names": [
                "-P",
                "--pattern"
              ],
              "description": "Upgrade packages that match pattern",
              "args": {
                "name": "pattern"
              }
            },
            {
              "names": [
                "-T",
                "--tilde"
              ],
              "description": "Install most recent release with the same minor version. Only used when --latest is specified"
            },
            {
              "names": [
                "-C",
                "--caret"
              ],
              "description": "Install most recent release with the same major version. Only used when --latest is specified"
            },
            {
              "names": [
                "-A",
                "--audit"
              ],
              "description": "Run vulnerability audit on installed packages"
            },
            {
              "names": [
                "-h",
                "--help"
              ],
              "description": "Output usage information"
            }
          ]
        },
        {
          "name": "upgrade-interactive",
          "description": "Display the outdated packages before performing any upgrade",
          "options": [
            {
              "names": [
                "--latest"
              ],
              "description": "Use the version tagged latest in the registry"
            }
          ]
        }
      ],
      "options": [
        {
          "names": [
            "-s",
            "--silent"
          ],
          "description": "Skip Yarn console logs"
        },
        {
          "names": [
            "--no-default-rc"
          ],
          "description": "Prevent Yarn from automatically detecting yarnrc and npmrc files"
        },
        {
          "names": [
            "--use-yarnrc"
          ],
          "description": "Specifies a yarnrc file that Yarn should use (.yarnrc only, not .npmrc) (default: )",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--verbose"
          ],
          "description": "Output verbose messages on internal operations"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Trigger an error if any required dependencies are not available in local cache"
        },
        {
          "names": [
            "--prefer-offline"
          ],
          "description": "Use network only if dependencies are not available in local cache"
        },
        {
          "names": [
            "--enable-pnp",
            "--pnp"
          ],
          "description": "Enable the Plug'n'Play installation"
        },
        {
          "names": [
            "--json"
          ],
          "description": "Format Yarn log messages as lines of JSON"
        },
        {
          "names": [
            "--ignore-scripts"
          ],
          "description": "Don't run lifecycle scripts"
        },
        {
          "names": [
            "--har"
          ],
          "description": "Save HAR output of network traffic"
        },
        {
          "names": [
            "--ignore-platform"
          ],
          "description": "Ignore platform checks"
        },
        {
          "names": [
            "--ignore-engines"
          ],
          "description": "Ignore engines check"
        },
        {
          "names": [
            "--ignore-optional"
          ],
          "description": "Ignore optional dependencies"
        },
        {
          "names": [
            "--force"
          ],
          "description": "Install and build packages even if they were built before, overwrite lockfile"
        },
        {
          "names": [
            "--skip-integrity-check"
          ],
          "description": "Run install without checking if node_modules is installed"
        },
        {
          "names": [
            "--check-files"
          ],
          "description": "Install will verify file tree of packages for consistency"
        },
        {
          "names": [
            "--no-bin-links"
          ],
          "description": "Don't generate bin links when setting up packages"
        },
        {
          "names": [
            "--flat"
          ],
          "description": "Only allow one version of a package"
        },
        {
          "names": [
            "--prod",
            "--production"
          ],
          "description": "Instruct Yarn to ignore NODE_ENV and take its production-or-not status from this flag instead"
        },
        {
          "names": [
            "--no-lockfile"
          ],
          "description": "Don't read or generate a lockfile"
        },
        {
          "names": [
            "--pure-lockfile"
          ],
          "description": "Don't generate a lockfile"
        },
        {
          "names": [
            "--frozen-lockfile"
          ],
          "description": "Don't generate a lockfile and fail if an update is needed"
        },
        {
          "names": [
            "--update-checksums"
          ],
          "description": "Update package checksums from current repository"
        },
        {
          "names": [
            "--link-duplicates"
          ],
          "description": "Create hardlinks to the repeated modules in node_modules"
        },
        {
          "names": [
            "--link-folder"
          ],
          "description": "Specify a custom folder to store global links",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--global-folder"
          ],
          "description": "Specify a custom folder to store global packages",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--modules-folder"
          ],
          "description": "Rather than installing modules into the node_modules folder relative to the cwd, output them here",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--preferred-cache-folder"
          ],
          "description": "Specify a custom folder to store the yarn cache if possible",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--cache-folder"
          ],
          "description": "Specify a custom folder that must be used to store the yarn cache",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--mutex"
          ],
          "description": "Use a mutex to ensure only one yarn instance is executing",
          "args": {
            "name": "type[:specifier]"
          }
        },
        {
          "names": [
            "--emoji"
          ],
          "description": "Enables emoji in output",
          "args": {
            "suggestions": [
              "true",
              "false"
            ]
          }
        },
        {
          "names": [
            "--cwd"
          ],
          "description": "Working directory to use",
          "args": {
            "name": "cwd"
          }
        },
        {
          "names": [
            "--proxy",
            "--https-proxy"
          ],
          "args": {
            "name": "host"
          }
        },
        {
          "names": [
            "--registry"
          ],
          "description": "Override configuration registry",
          "args": {
            "name": "url"
          }
        },
        {
          "names": [
            "--no-progress"
          ],
          "description": "Disable progress bar"
        },
        {
          "names": [
            "--network-concurrency"
          ],
          "description": "Maximum number of concurrent network requests",
          "args": {
            "name": "number"
          }
        },
        {
          "names": [
            "--network-timeout"
          ],
          "description": "TCP timeout for network requests",
          "args": {
            "name": "milliseconds"
          }
        },
        {
          "names": [
            "--non-interactive"
          ],
          "description": "Do not show interactive prompts"
        },
        {
          "names": [
            "--scripts-prepend-node-path"
          ],
          "description": "Prepend the node executable dir to the PATH in scripts"
        },
        {
          "names": [
            "--no-node-version-check"
          ],
          "description": "Do not warn when using a potentially unsupported Node version"
        },
        {
          "names": [
            "--focus"
          ],
          "description": "Focus on a single workspace by installing remote copies of its sibling workspaces"
        },
        {
          "names": [
            "--otp"
          ],
          "description": "One-time password for two factor authentication",
          "args": {
            "name": "otpcode"
          }
        },
        {
          "names": [
            "--prefix"
          ],
          "description": "Bin prefix to use to install binaries",
          "args": {
            "name": "prefix"
          }
        },
        {
          "names": [
            "--latest"
          ],
          "description": "Bin prefix to use to install binaries"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Output usage information"
        }
      ]
    },
    {
      "name": "help",
      "description": "Output usage information"
    },
    {
      "name": "import",
      "description": "Generates yarn.lock from an npm package-lock.json file"
    },
    {
      "name": "info",
      "description": "Show information about a package"
    },
    {
      "name": "init",
      "description": "Interactively creates or updates a package.json file",
      "options": [
        {
          "names": [
            "-s",
            "--silent"
          ],
          "description": "Skip Yarn console logs"
        },
        {
          "names": [
            "--no-default-rc"
          ],
          "description": "Prevent Yarn from automatically detecting yarnrc and npmrc files"
        },
        {
          "names": [
            "--use-yarnrc"
          ],
          "description": "Specifies a yarnrc file that Yarn should use (.yarnrc only, not .npmrc) (default: )",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--verbose"
          ],
          "description": "Output verbose messages on internal operations"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Trigger an error if any required dependencies are not available in local cache"
        },
        {
          "names": [
            "--prefer-offline"
          ],
          "description": "Use network only if dependencies are not available in local cache"
        },
        {
          "names": [
            "--enable-pnp",
            "--pnp"
          ],
          "description": "Enable the Plug'n'Play installation"
        },
        {
          "names": [
            "--json"
          ],
          "description": "Format Yarn log messages as lines of JSON"
        },
        {
          "names": [
            "--ignore-scripts"
          ],
          "description": "Don't run lifecycle scripts"
        },
        {
          "names": [
            "--har"
          ],
          "description": "Save HAR output of network traffic"
        },
        {
          "names": [
            "--ignore-platform"
          ],
          "description": "Ignore platform checks"
        },
        {
          "names": [
            "--ignore-engines"
          ],
          "description": "Ignore engines check"
        },
        {
          "names": [
            "--ignore-optional"
          ],
          "description": "Ignore optional dependencies"
        },
        {
          "names": [
            "--force"
          ],
          "description": "Install and build packages even if they were built before, overwrite lockfile"
        },
        {
          "names": [
            "--skip-integrity-check"
          ],
          "description": "Run install without checking if node_modules is installed"
        },
        {
          "names": [
            "--check-files"
          ],
          "description": "Install will verify file tree of packages for consistency"
        },
        {
          "names": [
            "--no-bin-links"
          ],
          "description": "Don't generate bin links when setting up packages"
        },
        {
          "names": [
            "--flat"
          ],
          "description": "Only allow one version of a package"
        },
        {
          "names": [
            "--prod",
            "--production"
          ],
          "description": "Instruct Yarn to ignore NODE_ENV and take its production-or-not status from this flag instead"
        },
        {
          "names": [
            "--no-lockfile"
          ],
          "description": "Don't read or generate a lockfile"
        },
        {
          "names": [
            "--pure-lockfile"
          ],
          "description": "Don't generate a lockfile"
        },
        {
          "names": [
            "--frozen-lockfile"
          ],
          "description": "Don't generate a lockfile and fail if an update is needed"
        },
        {
          "names": [
            "--update-checksums"
          ],
          "description": "Update package checksums from current repository"
        },
        {
          "names": [
            "--link-duplicates"
          ],
          "description": "Create hardlinks to the repeated modules in node_modules"
        },
        {
          "names": [
            "--link-folder"
          ],
          "description": "Specify a custom folder to store global links",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--global-folder"
          ],
          "description": "Specify a custom folder to store global packages",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--modules-folder"
          ],
          "description": "Rather than installing modules into the node_modules folder relative to the cwd, output them here",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--preferred-cache-folder"
          ],
          "description": "Specify a custom folder to store the yarn cache if possible",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--cache-folder"
          ],
          "description": "Specify a custom folder that must be used to store the yarn cache",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--mutex"
          ],
          "description": "Use a mutex to ensure only one yarn instance is executing",
          "args": {
            "name": "type[:specifier]"
          }
        },
        {
          "names": [
            "--emoji"
          ],
          "description": "Enables emoji in output",
          "args": {
            "suggestions": [
              "true",
              "false"
            ]
          }
        },
        {
          "names": [
            "--cwd"
          ],
          "description": "Working directory to use",
          "args": {
            "name": "cwd"
          }
        },
        {
          "names": [
            "--proxy",
            "--https-proxy"
          ],
          "args": {
            "name": "host"
          }
        },
        {
          "names": [
            "--registry"
          ],
          "description": "Override configuration registry",
          "args": {
            "name": "url"
          }
        },
        {
          "names": [
            "--no-progress"
          ],
          "description": "Disable progress bar"
        },
        {
          "names": [
            "--network-concurrency"
          ],
          "description": "Maximum number of concurrent network requests",
          "args": {
            "name": "number"
          }
        },
        {
          "names": [
            "--network-timeout"
          ],
          "description": "TCP timeout for network requests",
          "args": {
            "name": "milliseconds"
          }
        },
        {
          "names": [
            "--non-interactive"
          ],
          "description": "Do not show interactive prompts"
        },
        {
          "names": [
            "--scripts-prepend-node-path"
          ],
          "description": "Prepend the node executable dir to the PATH in scripts"
        },
        {
          "names": [
            "--no-node-version-check"
          ],
          "description": "Do not warn when using a potentially unsupported Node version"
        },
        {
          "names": [
            "--focus"
          ],
          "description": "Focus on a single workspace by installing remote copies of its sibling workspaces"
        },
        {
          "names": [
            "--otp"
          ],
          "description": "One-time password for two factor authentication",
          "args": {
            "name": "otpcode"
          }
        },
        {
          "names": [
            "-y",
            "--yes"
          ],
          "description": "Use default options"
        },
        {
          "names": [
            "-p",
            "--private"
          ],
          "description": "Use default options and private true"
        },
        {
          "names": [
            "-i",
            "--install"
          ],
          "description": "Install a specific Yarn release",
          "args": {
            "name": "version"
          }
        },
        {
          "names": [
            "-2"
          ],
          "description": "Generates the project using Yarn 2"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Output usage information"
        }
      ]
    },
    {
      "name": "install",
      "description": "Install all the dependencies listed within package.json",
      "options": [
        {
          "names": [
            "-s",
            "--silent"
          ],
          "description": "Skip Yarn console logs"
        },
        {
          "names": [
            "--no-default-rc"
          ],
          "description": "Prevent Yarn from automatically detecting yarnrc and npmrc files"
        },
        {
          "names": [
            "--use-yarnrc"
          ],
          "description": "Specifies a yarnrc file that Yarn should use (.yarnrc only, not .npmrc) (default: )",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--verbose"
          ],
          "description": "Output verbose messages on internal operations"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Trigger an error if any required dependencies are not available in local cache"
        },
        {
          "names": [
            "--prefer-offline"
          ],
          "description": "Use network only if dependencies are not available in local cache"
        },
        {
          "names": [
            "--enable-pnp",
            "--pnp"
          ],
          "description": "Enable the Plug'n'Play installation"
        },
        {
          "names": [
            "--json"
          ],
          "description": "Format Yarn log messages as lines of JSON"
        },
        {
          "names": [
            "--ignore-scripts"
          ],
          "description": "Don't run lifecycle scripts"
        },
        {
          "names": [
            "--har"
          ],
          "description": "Save HAR output of network traffic"
        },
        {
          "names": [
            "--ignore-platform"
          ],
          "description": "Ignore platform checks"
        },
        {
          "names": [
            "--ignore-engines"
          ],
          "description": "Ignore engines check"
        },
        {
          "names": [
            "--ignore-optional"
          ],
          "description": "Ignore optional dependencies"
        },
        {
          "names": [
            "--force"
          ],
          "description": "Install and build packages even if they were built before, overwrite lockfile"
        },
        {
          "names": [
            "--skip-integrity-check"
          ],
          "description": "Run install without checking if node_modules is installed"
        },
        {
          "names": [
            "--check-files"
          ],
          "description": "Install will verify file tree of packages for consistency"
        },
        {
          "names": [
            "--no-bin-links"
          ],
          "description": "Don't generate bin links when setting up packages"
        },
        {
          "names": [
            "--flat"
          ],
          "description": "Only allow one version of a package"
        },
        {
          "names": [
            "--prod",
            "--production"
          ],
          "description": "Instruct Yarn to ignore NODE_ENV and take its production-or-not status from this flag instead"
        },
        {
          "names": [
            "--no-lockfile"
          ],
          "description": "Don't read or generate a lockfile"
        },
        {
          "names": [
            "--pure-lockfile"
          ],
          "description": "Don't generate a lockfile"
        },
        {
          "names": [
            "--frozen-lockfile"
          ],
          "description": "Don't generate a lockfile and fail if an update is needed"
        },
        {
          "names": [
            "--update-checksums"
          ],
          "description": "Update package checksums from current repository"
        },
        {
          "names": [
            "--link-duplicates"
          ],
          "description": "Create hardlinks to the repeated modules in node_modules"
        },
        {
          "names": [
            "--link-folder"
          ],
          "description": "Specify a custom folder to store global links",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--global-folder"
          ],
          "description": "Specify a custom folder to store global packages",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--modules-folder"
          ],
          "description": "Rather than installing modules into the node_modules folder relative to the cwd, output them here",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--preferred-cache-folder"
          ],
          "description": "Specify a custom folder to store the yarn cache if possible",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--cache-folder"
          ],
          "description": "Specify a custom folder that must be used to store the yarn cache",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--mutex"
          ],
          "description": "Use a mutex to ensure only one yarn instance is executing",
          "args": {
            "name": "type[:specifier]"
          }
        },
        {
          "names": [
            "--emoji"
          ],
          "description": "Enables emoji in output",
          "args": {
            "suggestions": [
              "true",
              "false"
            ]
          }
        },
        {
          "names": [
            "--cwd"
          ],
          "description": "Working directory to use",
          "args": {
            "name": "cwd"
          }
        },
        {
          "names": [
            "--proxy",
            "--https-proxy"
          ],
          "args": {
            "name": "host"
          }
        },
        {
          "names": [
            "--registry"
          ],
          "description": "Override configuration registry",
          "args": {
            "name": "url"
          }
        },
        {
          "names": [
            "--no-progress"
          ],
          "description": "Disable progress bar"
        },
        {
          "names": [
            "--network-concurrency"
          ],
          "description": "Maximum number of concurrent network requests",
          "args": {
            "name": "number"
          }
        },
        {
          "names": [
            "--network-timeout"
          ],
          "description": "TCP timeout for network requests",
          "args": {
            "name": "milliseconds"
          }
        },
        {
          "names": [
            "--non-interactive"
          ],
          "description": "Do not show interactive prompts"
        },
        {
          "names": [
            "--scripts-prepend-node-path"
          ],
          "description": "Prepend the node executable dir to the PATH in scripts"
        },
        {
          "names": [
            "--no-node-version-check"
          ],
          "description": "Do not warn when using a potentially unsupported Node version"
        },
        {
          "names": [
            "--focus"
          ],
          "description": "Focus on a single workspace by installing remote copies of its sibling workspaces"
        },
        {
          "names": [
            "--otp"
          ],
          "description": "One-time password for two factor authentication",
          "args": {
            "name": "otpcode"
          }
        },
        {
          "names": [
            "-A",
            "--audit"
          ],
          "description": "Run vulnerability audit on installed packages"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Output usage information"
        }
      ]
    },
    {
      "name": "licenses",
      "subcommands": [
        {
          "name": "list",
          "description": "List licenses for installed packages"
        },
        {
          "name": "generate-disclaimer",
          "description": "List of licenses from all the packages"
        }
      ]
    },
    {
      "name": "link",
      "description": "Symlink a package folder during development",
      "options": [
        {
          "names": [
            "-s",
            "--silent"
          ],
          "description": "Skip Yarn console logs"
        },
        {
          "names": [
            "--no-default-rc"
          ],
          "description": "Prevent Yarn from automatically detecting yarnrc and npmrc files"
        },
        {
          "names": [
            "--use-yarnrc"
          ],
          "description": "Specifies a yarnrc file that Yarn should use (.yarnrc only, not .npmrc) (default: )",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--verbose"
          ],
          "description": "Output verbose messages on internal operations"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Trigger an error if any required dependencies are not available in local cache"
        },
        {
          "names": [
            "--prefer-offline"
          ],
          "description": "Use network only if dependencies are not available in local cache"
        },
        {
          "names": [
            "--enable-pnp",
            "--pnp"
          ],
          "description": "Enable the Plug'n'Play installation"
        },
        {
          "names": [
            "--json"
          ],
          "description": "Format Yarn log messages as lines of JSON"
        },
        {
          "names": [
            "--ignore-scripts"
          ],
          "description": "Don't run lifecycle scripts"
        },
        {
          "names": [
            "--har"
          ],
          "description": "Save HAR output of network traffic"
        },
        {
          "names": [
            "--ignore-platform"
          ],
          "description": "Ignore platform checks"
        },
        {
          "names": [
            "--ignore-engines"
          ],
          "description": "Ignore engines check"
        },
        {
          "names": [
            "--ignore-optional"
          ],
          "description": "Ignore optional dependencies"
        },
        {
          "names": [
            "--force"
          ],
          "description": "Install and build packages even if they were built before, overwrite lockfile"
        },
        {
          "names": [
            "--skip-integrity-check"
          ],
          "description": "Run install without checking if node_modules is installed"
        },
        {
          "names": [
            "--check-files"
          ],
          "description": "Install will verify file tree of packages for consistency"
        },
        {
          "names": [
            "--no-bin-links"
          ],
          "description": "Don't generate bin links when setting up packages"
        },
        {
          "names": [
            "--flat"
          ],
          "description": "Only allow one version of a package"
        },
        {
          "names": [
            "--prod",
            "--production"
          ],
          "description": "Instruct Yarn to ignore NODE_ENV and take its production-or-not status from this flag instead"
        },
        {
          "names": [
            "--no-lockfile"
          ],
          "description": "Don't read or generate a lockfile"
        },
        {
          "names": [
            "--pure-lockfile"
          ],
          "description": "Don't generate a lockfile"
        },
        {
          "names": [
            "--frozen-lockfile"
          ],
          "description": "Don't generate a lockfile and fail if an update is needed"
        },
        {
          "names": [
            "--update-checksums"
          ],
          "description": "Update package checksums from current repository"
        },
        {
          "names": [
            "--link-duplicates"
          ],
          "description": "Create hardlinks to the repeated modules in node_modules"
        },
        {
          "names": [
            "--link-folder"
          ],
          "description": "Specify a custom folder to store global links",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--global-folder"
          ],
          "description": "Specify a custom folder to store global packages",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--modules-folder"
          ],
          "description": "Rather than installing modules into the node_modules folder relative to the cwd, output them here",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--preferred-cache-folder"
          ],
          "description": "Specify a custom folder to store the yarn cache if possible",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--cache-folder"
          ],
          "description": "Specify a custom folder that must be used to store the yarn cache",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--mutex"
          ],
          "description": "Use a mutex to ensure only one yarn instance is executing",
          "args": {
            "name": "type[:specifier]"
          }
        },
        {
          "names": [
            "--emoji"
          ],
          "description": "Enables emoji in output",
          "args": {
            "suggestions": [
              "true",
              "false"
            ]
          }
        },
        {
          "names": [
            "--cwd"
          ],
          "description": "Working directory to use",
          "args": {
            "name": "cwd"
          }
        },
        {
          "names": [
            "--proxy",
            "--https-proxy"
          ],
          "args": {
            "name": "host"
          }
        },
        {
          "names": [
            "--registry"
          ],
          "description": "Override configuration registry",
          "args": {
            "name": "url"
          }
        },
        {
          "names": [
            "--no-progress"
          ],
          "description": "Disable progress bar"
        },
        {
          "names": [
            "--network-concurrency"
          ],
          "description": "Maximum number of concurrent network requests",
          "args": {
            "name": "number"
          }
        },
        {
          "names": [
            "--network-timeout"
          ],
          "description": "TCP timeout for network requests",
          "args": {
            "name": "milliseconds"
          }
        },
        {
          "names": [
            "--non-interactive"
          ],
          "description": "Do not show interactive prompts"
        },
        {
          "names": [
            "--scripts-prepend-node-path"
          ],
          "description": "Prepend the node executable dir to the PATH in scripts"
        },
        {
          "names": [
            "--no-node-version-check"
          ],
          "description": "Do not warn when using a potentially unsupported Node version"
        },
        {
          "names": [
            "--focus"
          ],
          "description": "Focus on a single workspace by installing remote copies of its sibling workspaces"
        },
        {
          "names": [
            "--otp"
          ],
          "description": "One-time password for two factor authentication",
          "args": {
            "name": "otpcode"
          }
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Output usage information"
        }
      ],
      "args": [
        {
          "name": "package",
          "isOptional": true
        }
      ]
    },
    {
      "name": "list",
      "description": "Lists all dependencies for the current working directory",
      "options": [
        {
          "names": [
            "--depth"
          ],
          "description": "Restrict the depth of the dependencies"
        },
        {
          "names": [
            "--pattern"
          ],
          "description": "Filter the list of dependencies by the pattern"
        }
      ]
    },
    {
      "name": "login",
      "description": "Store registry username and email"
    },
    {
      "name": "logout",
      "description": "Clear registry username and email"
    },
    {
      "name": "node"
    },
    {
      "name": "outdated",
      "description": "Checks for outdated package dependencies",
      "options": [
        {
          "names": [
            "-s",
            "--silent"
          ],
          "description": "Skip Yarn console logs"
        },
        {
          "names": [
            "--no-default-rc"
          ],
          "description": "Prevent Yarn from automatically detecting yarnrc and npmrc files"
        },
        {
          "names": [
            "--use-yarnrc"
          ],
          "description": "Specifies a yarnrc file that Yarn should use (.yarnrc only, not .npmrc) (default: )",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--verbose"
          ],
          "description": "Output verbose messages on internal operations"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Trigger an error if any required dependencies are not available in local cache"
        },
        {
          "names": [
            "--prefer-offline"
          ],
          "description": "Use network only if dependencies are not available in local cache"
        },
        {
          "names": [
            "--enable-pnp",
            "--pnp"
          ],
          "description": "Enable the Plug'n'Play installation"
        },
        {
          "names": [
            "--json"
          ],
          "description": "Format Yarn log messages as lines of JSON"
        },
        {
          "names": [
            "--ignore-scripts"
          ],
          "description": "Don't run lifecycle scripts"
        },
        {
          "names": [
            "--har"
          ],
          "description": "Save HAR output of network traffic"
        },
        {
          "names": [
            "--ignore-platform"
          ],
          "description": "Ignore platform checks"
        },
        {
          "names": [
            "--ignore-engines"
          ],
          "description": "Ignore engines check"
        },
        {
          "names": [
            "--ignore-optional"
          ],
          "description": "Ignore optional dependencies"
        },
        {
          "names": [
            "--force"
          ],
          "description": "Install and build packages even if they were built before, overwrite lockfile"
        },
        {
          "names": [
            "--skip-integrity-check"
          ],
          "description": "Run install without checking if node_modules is installed"
        },
        {
          "names": [
            "--check-files"
          ],
          "description": "Install will verify file tree of packages for consistency"
        },
        {
          "names": [
            "--no-bin-links"
          ],
          "description": "Don't generate bin links when setting up packages"
        },
        {
          "names": [
            "--flat"
          ],
          "description": "Only allow one version of a package"
        },
        {
          "names": [
            "--prod",
            "--production"
          ],
          "description": "Instruct Yarn to ignore NODE_ENV and take its production-or-not status from this flag instead"
        },
        {
          "names": [
            "--no-lockfile"
          ],
          "description": "Don't read or generate a lockfile"
        },
        {
          "names": [
            "--pure-lockfile"
          ],
          "description": "Don't generate a lockfile"
        },
        {
          "names": [
            "--frozen-lockfile"
          ],
          "description": "Don't generate a lockfile and fail if an update is needed"
        },
        {
          "names": [
            "--update-checksums"
          ],
          "description": "Update package checksums from current repository"
        },
        {
          "names": [
            "--link-duplicates"
          ],
          "description": "Create hardlinks to the repeated modules in node_modules"
        },
        {
          "names": [
            "--link-folder"
          ],
          "description": "Specify a custom folder to store global links",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--global-folder"
          ],
          "description": "Specify a custom folder to store global packages",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--modules-folder"
          ],
          "description": "Rather than installing modules into the node_modules folder relative to the cwd, output them here",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--preferred-cache-folder"
          ],
          "description": "Specify a custom folder to store the yarn cache if possible",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--cache-folder"
          ],
          "description": "Specify a custom folder that must be used to store the yarn cache",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--mutex"
          ],
          "description": "Use a mutex to ensure only one yarn instance is executing",
          "args": {
            "name": "type[:specifier]"
          }
        },
        {
          "names": [
            "--emoji"
          ],
          "description": "Enables emoji in output",
          "args": {
            "suggestions": [
              "true",
              "false"
            ]
          }
        },
        {
          "names": [
            "--cwd"
          ],
          "description": "Working directory to use",
          "args": {
            "name": "cwd"
          }
        },
        {
          "names": [
            "--proxy",
            "--https-proxy"
          ],
          "args": {
            "name": "host"
          }
        },
        {
          "names": [
            "--registry"
          ],
          "description": "Override configuration registry",
          "args": {
            "name": "url"
          }
        },
        {
          "names": [
            "--no-progress"
          ],
          "description": "Disable progress bar"
        },
        {
          "names": [
            "--network-concurrency"
          ],
          "description": "Maximum number of concurrent network requests",
          "args": {
            "name": "number"
          }
        },
        {
          "names": [
            "--network-timeout"
          ],
          "description": "TCP timeout for network requests",
          "args": {
            "name": "milliseconds"
          }
        },
        {
          "names": [
            "--non-interactive"
          ],
          "description": "Do not show interactive prompts"
        },
        {
          "names": [
            "--scripts-prepend-node-path"
          ],
          "description": "Prepend the node executable dir to the PATH in scripts"
        },
        {
          "names": [
            "--no-node-version-check"
          ],
          "description": "Do not warn when using a potentially unsupported Node version"
        },
        {
          "names": [
            "--focus"
          ],
          "description": "Focus on a single workspace by installing remote copies of its sibling workspaces"
        },
        {
          "names": [
            "--otp"
          ],
          "description": "One-time password for two factor authentication",
          "args": {
            "name": "otpcode"
          }
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Output usage information"
        }
      ]
    },
    {
      "name": "owner",
      "description": "Manage package owners",
      "subcommands": [
        {
          "name": "list",
          "description": "Lists all of the owners of a package",
          "args": [
            {
              "name": "package"
            }
          ]
        },
        {
          "name": "add",
          "description": "Adds the user as an owner of the package",
          "args": [
            {
              "name": "package"
            }
          ]
        },
        {
          "name": "remove",
          "description": "Removes the user as an owner of the package",
          "args": [
            {
              "name": "user"
            },
            {
              "name": "package"
            }
          ]
        }
      ]
    },
    {
      "name": "pack",
      "description": "Creates a compressed gzip archive of package dependencies",
      "options": [
        {
          "names": [
            "--filename"
          ],
          "description": "Creates a compressed gzip archive of package dependencies and names the file filename"
        }
      ]
    },
    {
      "name": "policies",
      "description": "Defines project-wide policies for your project",
      "subcommands": [
        {
          "name": "set-version",
          "description": "Will download the latest stable release",
          "options": [
            {
              "names": [
                "--rc"
              ],
              "description": "Download the latest rc release"
            }
          ]
        }
      ]
    },
    {
      "name": "publish",
      "description": "Publishes a package to the npm registry",
      "options": [
        {
          "names": [
            "-s",
            "--silent"
          ],
          "description": "Skip Yarn console logs"
        },
        {
          "names": [
            "--no-default-rc"
          ],
          "description": "Prevent Yarn from automatically detecting yarnrc and npmrc files"
        },
        {
          "names": [
            "--use-yarnrc"
          ],
          "description": "Specifies a yarnrc file that Yarn should use (.yarnrc only, not .npmrc) (default: )",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--verbose"
          ],
          "description": "Output verbose messages on internal operations"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Trigger an error if any required dependencies are not available in local cache"
        },
        {
          "names": [
            "--prefer-offline"
          ],
          "description": "Use network only if dependencies are not available in local cache"
        },
        {
          "names": [
            "--enable-pnp",
            "--pnp"
          ],
          "description": "Enable the Plug'n'Play installation"
        },
        {
          "names": [
            "--json"
          ],
          "description": "Format Yarn log messages as lines of JSON"
        },
        {
          "names": [
            "--ignore-scripts"
          ],
          "description": "Don't run lifecycle scripts"
        },
        {
          "names": [
            "--har"
          ],
          "description": "Save HAR output of network traffic"
        },
        {
          "names": [
            "--ignore-platform"
          ],
          "description": "Ignore platform checks"
        },
        {
          "names": [
            "--ignore-engines"
          ],
          "description": "Ignore engines check"
        },
        {
          "names": [
            "--ignore-optional"
          ],
          "description": "Ignore optional dependencies"
        },
        {
          "names": [
            "--force"
          ],
          "description": "Install and build packages even if they were built before, overwrite lockfile"
        },
        {
          "names": [
            "--skip-integrity-check"
          ],
          "description": "Run install without checking if node_modules is installed"
        },
        {
          "names": [
            "--check-files"
          ],
          "description": "Install will verify file tree of packages for consistency"
        },
        {
          "names": [
            "--no-bin-links"
          ],
          "description": "Don't generate bin links when setting up packages"
        },
        {
          "names": [
            "--flat"
          ],
          "description": "Only allow one version of a package"
        },
        {
          "names": [
            "--prod",
            "--production"
          ],
          "description": "Instruct Yarn to ignore NODE_ENV and take its production-or-not status from this flag instead"
        },
        {
          "names": [
            "--no-lockfile"
          ],
          "description": "Don't read or generate a lockfile"
        },
        {
          "names": [
            "--pure-lockfile"
          ],
          "description": "Don't generate a lockfile"
        },
        {
          "names": [
            "--frozen-lockfile"
          ],
          "description": "Don't generate a lockfile and fail if an update is needed"
        },
        {
          "names": [
            "--update-checksums"
          ],
          "description": "Update package checksums from current repository"
        },
        {
          "names": [
            "--link-duplicates"
          ],
          "description": "Create hardlinks to the repeated modules in node_modules"
        },
        {
          "names": [
            "--link-folder"
          ],
          "description": "Specify a custom folder to store global links",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--global-folder"
          ],
          "description": "Specify a custom folder to store global packages",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--modules-folder"
          ],
          "description": "Rather than installing modules into the node_modules folder relative to the cwd, output them here",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--preferred-cache-folder"
          ],
          "description": "Specify a custom folder to store the yarn cache if possible",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--cache-folder"
          ],
          "description": "Specify a custom folder that must be used to store the yarn cache",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--mutex"
          ],
          "description": "Use a mutex to ensure only one yarn instance is executing",
          "args": {
            "name": "type[:specifier]"
          }
        },
        {
          "names": [
            "--emoji"
          ],
          "description": "Enables emoji in output",
          "args": {
            "suggestions": [
              "true",
              "false"
            ]
          }
        },
        {
          "names": [
            "--cwd"
          ],
          "description": "Working directory to use",
          "args": {
            "name": "cwd"
          }
        },
        {
          "names": [
            "--proxy",
            "--https-proxy"
          ],
          "args": {
            "name": "host"
          }
        },
        {
          "names": [
            "--registry"
          ],
          "description": "Override configuration registry",
          "args": {
            "name": "url"
          }
        },
        {
          "names": [
            "--no-progress"
          ],
          "description": "Disable progress bar"
        },
        {
          "names": [
            "--network-concurrency"
          ],
          "description": "Maximum number of concurrent network requests",
          "args": {
            "name": "number"
          }
        },
        {
          "names": [
            "--network-timeout"
          ],
          "description": "TCP timeout for network requests",
          "args": {
            "name": "milliseconds"
          }
        },
        {
          "names": [
            "--non-interactive"
          ],
          "description": "Do not show interactive prompts"
        },
        {
          "names": [
            "--scripts-prepend-node-path"
          ],
          "description": "Prepend the node executable dir to the PATH in scripts"
        },
        {
          "names": [
            "--no-node-version-check"
          ],
          "description": "Do not warn when using a potentially unsupported Node version"
        },
        {
          "names": [
            "--focus"
          ],
          "description": "Focus on a single workspace by installing remote copies of its sibling workspaces"
        },
        {
          "names": [
            "--otp"
          ],
          "description": "One-time password for two factor authentication",
          "args": {
            "name": "otpcode"
          }
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Output usage information"
        },
        {
          "names": [
            "--major"
          ],
          "description": "Auto-increment major version number"
        },
        {
          "names": [
            "--minor"
          ],
          "description": "Auto-increment minor version number"
        },
        {
          "names": [
            "--patch"
          ],
          "description": "Auto-increment patch version number"
        },
        {
          "names": [
            "--premajor"
          ],
          "description": "Auto-increment premajor version number"
        },
        {
          "names": [
            "--preminor"
          ],
          "description": "Auto-increment preminor version number"
        },
        {
          "names": [
            "--prepatch"
          ],
          "description": "Auto-increment prepatch version number"
        },
        {
          "names": [
            "--prerelease"
          ],
          "description": "Auto-increment prerelease version number"
        },
        {
          "names": [
            "--preid"
          ],
          "description": "Add a custom identifier to the prerelease",
          "args": {
            "name": "preid"
          }
        },
        {
          "names": [
            "--message"
          ],
          "description": "Message",
          "args": {
            "name": "message"
          }
        },
        {
          "names": [
            "--no-git-tag-version"
          ],
          "description": "No git tag version"
        },
        {
          "names": [
            "--no-commit-hooks"
          ],
          "description": "Bypass git hooks when committing new version"
        },
        {
          "names": [
            "--access"
          ],
          "description": "Access",
          "args": {
            "name": "access"
          }
        },
        {
          "names": [
            "--tag"
          ],
          "description": "Tag",
          "args": {
            "name": "tag"
          }
        }
      ],
      "args": [
        {
          "name": "Tarball or Folder"
        }
      ]
    },
    {
      "name": "remove",
      "description": "Remove installed package",
      "options": [
        {
          "names": [
            "-s",
            "--silent"
          ],
          "description": "Skip Yarn console logs"
        },
        {
          "names": [
            "--no-default-rc"
          ],
          "description": "Prevent Yarn from automatically detecting yarnrc and npmrc files"
        },
        {
          "names": [
            "--use-yarnrc"
          ],
          "description": "Specifies a yarnrc file that Yarn should use (.yarnrc only, not .npmrc) (default: )",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--verbose"
          ],
          "description": "Output verbose messages on internal operations"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Trigger an error if any required dependencies are not available in local cache"
        },
        {
          "names": [
            "--prefer-offline"
          ],
          "description": "Use network only if dependencies are not available in local cache"
        },
        {
          "names": [
            "--enable-pnp",
            "--pnp"
          ],
          "description": "Enable the Plug'n'Play installation"
        },
        {
          "names": [
            "--json"
          ],
          "description": "Format Yarn log messages as lines of JSON"
        },
        {
          "names": [
            "--ignore-scripts"
          ],
          "description": "Don't run lifecycle scripts"
        },
        {
          "names": [
            "--har"
          ],
          "description": "Save HAR output of network traffic"
        },
        {
          "names": [
            "--ignore-platform"
          ],
          "description": "Ignore platform checks"
        },
        {
          "names": [
            "--ignore-engines"
          ],
          "description": "Ignore engines check"
        },
        {
          "names": [
            "--ignore-optional"
          ],
          "description": "Ignore optional dependencies"
        },
        {
          "names": [
            "--force"
          ],
          "description": "Install and build packages even if they were built before, overwrite lockfile"
        },
        {
          "names": [
            "--skip-integrity-check"
          ],
          "description": "Run install without checking if node_modules is installed"
        },
        {
          "names": [
            "--check-files"
          ],
          "description": "Install will verify file tree of packages for consistency"
        },
        {
          "names": [
            "--no-bin-links"
          ],
          "description": "Don't generate bin links when setting up packages"
        },
        {
          "names": [
            "--flat"
          ],
          "description": "Only allow one version of a package"
        },
        {
          "names": [
            "--prod",
            "--production"
          ],
          "description": "Instruct Yarn to ignore NODE_ENV and take its production-or-not status from this flag instead"
        },
        {
          "names": [
            "--no-lockfile"
          ],
          "description": "Don't read or generate a lockfile"
        },
        {
          "names": [
            "--pure-lockfile"
          ],
          "description": "Don't generate a lockfile"
        },
        {
          "names": [
            "--frozen-lockfile"
          ],
          "description": "Don't generate a lockfile and fail if an update is needed"
        },
        {
          "names": [
            "--update-checksums"
          ],
          "description": "Update package checksums from current repository"
        },
        {
          "names": [
            "--link-duplicates"
          ],
          "description": "Create hardlinks to the repeated modules in node_modules"
        },
        {
          "names": [
            "--link-folder"
          ],
          "description": "Specify a custom folder to store global links",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--global-folder"
          ],
          "description": "Specify a custom folder to store global packages",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--modules-folder"
          ],
          "description": "Rather than installing modules into the node_modules folder relative to the cwd, output them here",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--preferred-cache-folder"
          ],
          "description": "Specify a custom folder to store the yarn cache if possible",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--cache-folder"
          ],
          "description": "Specify a custom folder that must be used to store the yarn cache",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--mutex"
          ],
          "description": "Use a mutex to ensure only one yarn instance is executing",
          "args": {
            "name": "type[:specifier]"
          }
        },
        {
          "names": [
            "--emoji"
          ],
          "description": "Enables emoji in output",
          "args": {
            "suggestions": [
              "true",
              "false"
            ]
          }
        },
        {
          "names": [
            "--cwd"
          ],
          "description": "Working directory to use",
          "args": {
            "name": "cwd"
          }
        },
        {
          "names": [
            "--proxy",
            "--https-proxy"
          ],
          "args": {
            "name": "host"
          }
        },
        {
          "names": [
            "--registry"
          ],
          "description": "Override configuration registry",
          "args": {
            "name": "url"
          }
        },
        {
          "names": [
            "--no-progress"
          ],
          "description": "Disable progress bar"
        },
        {
          "names": [
            "--network-concurrency"
          ],
          "description": "Maximum number of concurrent network requests",
          "args": {
            "name": "number"
          }
        },
        {
          "names": [
            "--network-timeout"
          ],
          "description": "TCP timeout for network requests",
          "args": {
            "name": "milliseconds"
          }
        },
        {
          "names": [
            "--non-interactive"
          ],
          "description": "Do not show interactive prompts"
        },
        {
          "names": [
            "--scripts-prepend-node-path"
          ],
          "description": "Prepend the node executable dir to the PATH in scripts"
        },
        {
          "names": [
            "--no-node-version-check"
          ],
          "description": "Do not warn when using a potentially unsupported Node version"
        },
        {
          "names": [
            "--focus"
          ],
          "description": "Focus on a single workspace by installing remote copies of its sibling workspaces"
        },
        {
          "names": [
            "--otp"
          ],
          "description": "One-time password for two factor authentication",
          "args": {
            "name": "otpcode"
          }
        },
        {
          "names": [
            "-W",
            "--ignore-workspace-root-check"
          ],
          "description": "Required to run yarn remove inside a workspace root"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Output usage information"
        }
      ],
      "args": [
        {
          "isVariadic": true,
          "generators": [
            {
              "kind": "script",
              "script": [
                "bash",
                "-c",
                "until [[ -f package.json ]] || [[ $PWD = '/' ]]; do cd ..; done; cat package.json"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "run",
      "description": "Runs a defined package script",
      "options": [
        {
          "names": [
            "-s",
            "--silent"
          ],
          "description": "Skip Yarn console logs"
        },
        {
          "names": [
            "--no-default-rc"
          ],
          "description": "Prevent Yarn from automatically detecting yarnrc and npmrc files"
        },
        {
          "names": [
            "--use-yarnrc"
          ],
          "description": "Specifies a yarnrc file that Yarn should use (.yarnrc only, not .npmrc) (default: )",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--verbose"
          ],
          "description": "Output verbose messages on internal operations"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Trigger an error if any required dependencies are not available in local cache"
        },
        {
          "names": [
            "--prefer-offline"
          ],
          "description": "Use network only if dependencies are not available in local cache"
        },
        {
          "names": [
            "--enable-pnp",
            "--pnp"
          ],
          "description": "Enable the Plug'n'Play installation"
        },
        {
          "names": [
            "--json"
          ],
          "description": "Format Yarn log messages as lines of JSON"
        },
        {
          "names": [
            "--ignore-scripts"
          ],
          "description": "Don't run lifecycle scripts"
        },
        {
          "names": [
            "--har"
          ],
          "description": "Save HAR output of network traffic"
        },
        {
          "names": [
            "--ignore-platform"
          ],
          "description": "Ignore platform checks"
        },
        {
          "names": [
            "--ignore-engines"
          ],
          "description": "Ignore engines check"
        },
        {
          "names": [
            "--ignore-optional"
          ],
          "description": "Ignore optional dependencies"
        },
        {
          "names": [
            "--force"
          ],
          "description": "Install and build packages even if they were built before, overwrite lockfile"
        },
        {
          "names": [
            "--skip-integrity-check"
          ],
          "description": "Run install without checking if node_modules is installed"
        },
        {
          "names": [
            "--check-files"
          ],
          "description": "Install will verify file tree of packages for consistency"
        },
        {
          "names": [
            "--no-bin-links"
          ],
          "description": "Don't generate bin links when setting up packages"
        },
        {
          "names": [
            "--flat"
          ],
          "description": "Only allow one version of a package"
        },
        {
          "names": [
            "--prod",
            "--production"
          ],
          "description": "Instruct Yarn to ignore NODE_ENV and take its production-or-not status from this flag instead"
        },
        {
          "names": [
            "--no-lockfile"
          ],
          "description": "Don't read or generate a lockfile"
        },
        {
          "names": [
            "--pure-lockfile"
          ],
          "description": "Don't generate a lockfile"
        },
        {
          "names": [
            "--frozen-lockfile"
          ],
          "description": "Don't generate a lockfile and fail if an update is needed"
        },
        {
          "names": [
            "--update-checksums"
          ],
          "description": "Update package checksums from current repository"
        },
        {
          "names": [
            "--link-duplicates"
          ],
          "description": "Create hardlinks to the repeated modules in node_modules"
        },
        {
          "names": [
            "--link-folder"
          ],
          "description": "Specify a custom folder to store global links",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--global-folder"
          ],
          "description": "Specify a custom folder to store global packages",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--modules-folder"
          ],
          "description": "Rather than installing modules into the node_modules folder relative to the cwd, output them here",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--preferred-cache-folder"
          ],
          "description": "Specify a custom folder to store the yarn cache if possible",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--cache-folder"
          ],
          "description": "Specify a custom folder that must be used to store the yarn cache",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--mutex"
          ],
          "description": "Use a mutex to ensure only one yarn instance is executing",
          "args": {
            "name": "type[:specifier]"
          }
        },
        {
          "names": [
            "--emoji"
          ],
          "description": "Enables emoji in output",
          "args": {
            "suggestions": [
              "true",
              "false"
            ]
          }
        },
        {
          "names": [
            "--cwd"
          ],
          "description": "Working directory to use",
          "args": {
            "name": "cwd"
          }
        },
        {
          "names": [
            "--proxy",
            "--https-proxy"
          ],
          "args": {
            "name": "host"
          }
        },
        {
          "names": [
            "--registry"
          ],
          "description": "Override configuration registry",
          "args": {
            "name": "url"
          }
        },
        {
          "names": [
            "--no-progress"
          ],
          "description": "Disable progress bar"
        },
        {
          "names": [
            "--network-concurrency"
          ],
          "description": "Maximum number of concurrent network requests",
          "args": {
            "name": "number"
          }
        },
        {
          "names": [
            "--network-timeout"
          ],
          "description": "TCP timeout for network requests",
          "args": {
            "name": "milliseconds"
          }
        },
        {
          "names": [
            "--non-interactive"
          ],
          "description": "Do not show interactive prompts"
        },
        {
          "names": [
            "--scripts-prepend-node-path"
          ],
          "description": "Prepend the node executable dir to the PATH in scripts"
        },
        {
          "names": [
            "--no-node-version-check"
          ],
          "description": "Do not warn when using a potentially unsupported Node version"
        },
        {
          "names": [
            "--focus"
          ],
          "description": "Focus on a single workspace by installing remote copies of its sibling workspaces"
        },
        {
          "names": [
            "--otp"
          ],
          "description": "One-time password for two factor authentication",
          "args": {
            "name": "otpcode"
          }
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Output usage information"
        }
      ],
      "args": [
        {
          "name": "script",
          "description": "Script to run from your package.json",
          "generators": [
            {
              "kind": "script",
              "script": [
                "bash",
                "-c",
                "until [[ -f package.json ]] || [[ $PWD = '/' ]]; do cd ..; done; cat package.json"
              ]
            }
          ]
        },
        {
          "name": "env",
          "description": "Lists environment variables available to scripts",
          "isOptional": true,
          "suggestions": [
            "env"
          ]
        }
      ]
    },
    {
      "name": "tag",
      "description": "Add, remove, or list tags on a package"
    },
    {
      "name": "team",
      "description": "Maintain team memberships",
      "subcommands": [
        {
          "name": "create",
          "description": "Create a new team",
          "args": [
            {
              "name": "<scope:team>"
            }
          ]
        },
        {
          "name": "destroy",
          "description": "Destroys an existing team",
          "args": [
            {
              "name": "<scope:team>"
            }
          ]
        },
        {
          "name": "add",
          "description": "Add a user to an existing team",
          "args": [
            {
              "name": "<scope:team>"
            },
            {
              "name": "<user>"
            }
          ]
        },
        {
          "name": "remove",
          "description": "Remove a user from a team they belong to",
          "args": [
            {
              "name": "<scope:team> <user>"
            }
          ]
        },
        {
          "name": "list",
          "description": "If performed on an organization name, will return a list of existing teams under that organization. If performed on a team, it will instead return a list of all users belonging to that particular team",
          "args": [
            {
              "name": "<scope>|<scope:team>"
            }
          ]
        }
      ]
    },
    {
      "name": "unlink",
      "description": "Unlink a previously created symlink for a package"
    },
    {
      "name": "unplug"
    },
    {
      "name": "upgrade",
      "description": "Upgrades packages to their latest version based on the specified range",
      "options": [
        {
          "names": [
            "-s",
            "--silent"
          ],
          "description": "Skip Yarn console logs"
        },
        {
          "names": [
            "--no-default-rc"
          ],
          "description": "Prevent Yarn from automatically detecting yarnrc and npmrc files"
        },
        {
          "names": [
            "--use-yarnrc"
          ],
          "description": "Specifies a yarnrc file that Yarn should use (.yarnrc only, not .npmrc) (default: )",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--verbose"
          ],
          "description": "Output verbose messages on internal operations"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Trigger an error if any required dependencies are not available in local cache"
        },
        {
          "names": [
            "--prefer-offline"
          ],
          "description": "Use network only if dependencies are not available in local cache"
        },
        {
          "names": [
            "--enable-pnp",
            "--pnp"
          ],
          "description": "Enable the Plug'n'Play installation"
        },
        {
          "names": [
            "--json"
          ],
          "description": "Format Yarn log messages as lines of JSON"
        },
        {
          "names": [
            "--ignore-scripts"
          ],
          "description": "Don't run lifecycle scripts"
        },
        {
          "names": [
            "--har"
          ],
          "description": "Save HAR output of network traffic"
        },
        {
          "names": [
            "--ignore-platform"
          ],
          "description": "Ignore platform checks"
        },
        {
          "names": [
            "--ignore-engines"
          ],
          "description": "Ignore engines check"
        },
        {
          "names": [
            "--ignore-optional"
          ],
          "description": "Ignore optional dependencies"
        },
        {
          "names": [
            "--force"
          ],
          "description": "Install and build packages even if they were built before, overwrite lockfile"
        },
        {
          "names": [
            "--skip-integrity-check"
          ],
          "description": "Run install without checking if node_modules is installed"
        },
        {
          "names": [
            "--check-files"
          ],
          "description": "Install will verify file tree of packages for consistency"
        },
        {
          "names": [
            "--no-bin-links"
          ],
          "description": "Don't generate bin links when setting up packages"
        },
        {
          "names": [
            "--flat"
          ],
          "description": "Only allow one version of a package"
        },
        {
          "names": [
            "--prod",
            "--production"
          ],
          "description": "Instruct Yarn to ignore NODE_ENV and take its production-or-not status from this flag instead"
        },
        {
          "names": [
            "--no-lockfile"
          ],
          "description": "Don't read or generate a lockfile"
        },
        {
          "names": [
            "--pure-lockfile"
          ],
          "description": "Don't generate a lockfile"
        },
        {
          "names": [
            "--frozen-lockfile"
          ],
          "description": "Don't generate a lockfile and fail if an update is needed"
        },
        {
          "names": [
            "--update-checksums"
          ],
          "description": "Update package checksums from current repository"
        },
        {
          "names": [
            "--link-duplicates"
          ],
          "description": "Create hardlinks to the repeated modules in node_modules"
        },
        {
          "names": [
            "--link-folder"
          ],
          "description": "Specify a custom folder to store global links",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--global-folder"
          ],
          "description": "Specify a custom folder to store global packages",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--modules-folder"
          ],
          "description": "Rather than installing modules into the node_modules folder relative to the cwd, output them here",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--preferred-cache-folder"
          ],
          "description": "Specify a custom folder to store the yarn cache if possible",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--cache-folder"
          ],
          "description": "Specify a custom folder that must be used to store the yarn cache",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--mutex"
          ],
          "description": "Use a mutex to ensure only one yarn instance is executing",
          "args": {
            "name": "type[:specifier]"
          }
        },
        {
          "names": [
            "--emoji"
          ],
          "description": "Enables emoji in output",
          "args": {
            "suggestions": [
              "true",
              "false"
            ]
          }
        },
        {
          "names": [
            "--cwd"
          ],
          "description": "Working directory to use",
          "args": {
            "name": "cwd"
          }
        },
        {
          "names": [
            "--proxy",
            "--https-proxy"
          ],
          "args": {
            "name": "host"
          }
        },
        {
          "names": [
            "--registry"
          ],
          "description": "Override configuration registry",
          "args": {
            "name": "url"
          }
        },
        {
          "names": [
            "--no-progress"
          ],
          "description": "Disable progress bar"
        },
        {
          "names": [
            "--network-concurrency"
          ],
          "description": "Maximum number of concurrent network requests",
          "args": {
            "name": "number"
          }
        },
        {
          "names": [
            "--network-timeout"
          ],
          "description": "TCP timeout for network requests",
          "args": {
            "name": "milliseconds"
          }
        },
        {
          "names": [
            "--non-interactive"
          ],
          "description": "Do not show interactive prompts"
        },
        {
          "names": [
            "--scripts-prepend-node-path"
          ],
          "description": "Prepend the node executable dir to the PATH in scripts"
        },
        {
          "names": [
            "--no-node-version-check"
          ],
          "description": "Do not warn when using a potentially unsupported Node version"
        },
        {
          "names": [
            "--focus"
          ],
          "description": "Focus on a single workspace by installing remote copies of its sibling workspaces"
        },
        {
          "names": [
            "--otp"
          ],
          "description": "One-time password for two factor authentication",
          "args": {
            "name": "otpcode"
          }
        },
        {
          "names": [
            "-S",
            "--scope"
          ],
          "description": "Upgrade packages under the specified scope",
          "args": {
            "name": "scope"
          }
        },
        {
          "names": [
            "-L",
            "--latest"
          ],
          "description": "List the latest version of packages"
        },
        {
          "names": [
            "-E",
            "--exact"
          ],
          "description": "Install exact version. Only used when --latest is specified"
        },
        {
          "names": [
            "-P",
            "--pattern"
          ],
          "description": "Upgrade packages that match pattern",
          "args": {
            "name": "pattern"
          }
        },
        {
          "names": [
            "-T",
            "--tilde"
          ],
          "description": "Install most recent release with the same minor version. Only used when --latest is specified"
        },
        {
          "names": [
            "-C",
            "--caret"
          ],
          "description": "Install most recent release with the same major version. Only used when --latest is specified"
        },
        {
          "names": [
            "-A",
            "--audit"
          ],
          "description": "Run vulnerability audit on installed packages"
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Output usage information"
        }
      ],
      "args": [
        {
          "name": "package",
          "isVariadic": true,
          "isOptional": true,
          "generators": [
            {
              "kind": "script",
              "script": [
                "bash",
                "-c",
                "until [[ -f package.json ]] || [[ $PWD = '/' ]]; do cd ..; done; cat package.json"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "upgrade-interactive",
      "description": "Upgrades packages in interactive mode",
      "options": [
        {
          "names": [
            "--latest"
          ],
          "description": "Use the version tagged latest in the registry"
        }
      ]
    },
    {
      "name": "version",
      "description": "Update version of your package",
      "options": [
        {
          "names": [
            "-s",
            "--silent"
          ],
          "description": "Skip Yarn console logs"
        },
        {
          "names": [
            "--no-default-rc"
          ],
          "description": "Prevent Yarn from automatically detecting yarnrc and npmrc files"
        },
        {
          "names": [
            "--use-yarnrc"
          ],
          "description": "Specifies a yarnrc file that Yarn should use (.yarnrc only, not .npmrc) (default: )",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--verbose"
          ],
          "description": "Output verbose messages on internal operations"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Trigger an error if any required dependencies are not available in local cache"
        },
        {
          "names": [
            "--prefer-offline"
          ],
          "description": "Use network only if dependencies are not available in local cache"
        },
        {
          "names": [
            "--enable-pnp",
            "--pnp"
          ],
          "description": "Enable the Plug'n'Play installation"
        },
        {
          "names": [
            "--json"
          ],
          "description": "Format Yarn log messages as lines of JSON"
        },
        {
          "names": [
            "--ignore-scripts"
          ],
          "description": "Don't run lifecycle scripts"
        },
        {
          "names": [
            "--har"
          ],
          "description": "Save HAR output of network traffic"
        },
        {
          "names": [
            "--ignore-platform"
          ],
          "description": "Ignore platform checks"
        },
        {
          "names": [
            "--ignore-engines"
          ],
          "description": "Ignore engines check"
        },
        {
          "names": [
            "--ignore-optional"
          ],
          "description": "Ignore optional dependencies"
        },
        {
          "names": [
            "--force"
          ],
          "description": "Install and build packages even if they were built before, overwrite lockfile"
        },
        {
          "names": [
            "--skip-integrity-check"
          ],
          "description": "Run install without checking if node_modules is installed"
        },
        {
          "names": [
            "--check-files"
          ],
          "description": "Install will verify file tree of packages for consistency"
        },
        {
          "names": [
            "--no-bin-links"
          ],
          "description": "Don't generate bin links when setting up packages"
        },
        {
          "names": [
            "--flat"
          ],
          "description": "Only allow one version of a package"
        },
        {
          "names": [
            "--prod",
            "--production"
          ],
          "description": "Instruct Yarn to ignore NODE_ENV and take its production-or-not status from this flag instead"
        },
        {
          "names": [
            "--no-lockfile"
          ],
          "description": "Don't read or generate a lockfile"
        },
        {
          "names": [
            "--pure-lockfile"
          ],
          "description": "Don't generate a lockfile"
        },
        {
          "names": [
            "--frozen-lockfile"
          ],
          "description": "Don't generate a lockfile and fail if an update is needed"
        },
        {
          "names": [
            "--update-checksums"
          ],
          "description": "Update package checksums from current repository"
        },
        {
          "names": [
            "--link-duplicates"
          ],
          "description": "Create hardlinks to the repeated modules in node_modules"
        },
        {
          "names": [
            "--link-folder"
          ],
          "description": "Specify a custom folder to store global links",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--global-folder"
          ],
          "description": "Specify a custom folder to store global packages",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--modules-folder"
          ],
          "description": "Rather than installing modules into the node_modules folder relative to the cwd, output them here",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--preferred-cache-folder"
          ],
          "description": "Specify a custom folder to store the yarn cache if possible",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--cache-folder"
          ],
          "description": "Specify a custom folder that must be used to store the yarn cache",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--mutex"
          ],
          "description": "Use a mutex to ensure only one yarn instance is executing",
          "args": {
            "name": "type[:specifier]"
          }
        },
        {
          "names": [
            "--emoji"
          ],
          "description": "Enables emoji in output",
          "args": {
            "suggestions": [
              "true",
              "false"
            ]
          }
        },
        {
          "names": [
            "--cwd"
          ],
          "description": "Working directory to use",
          "args": {
            "name": "cwd"
          }
        },
        {
          "names": [
            "--proxy",
            "--https-proxy"
          ],
          "args": {
            "name": "host"
          }
        },
        {
          "names": [
            "--registry"
          ],
          "description": "Override configuration registry",
          "args": {
            "name": "url"
          }
        },
        {
          "names": [
            "--no-progress"
          ],
          "description": "Disable progress bar"
        },
        {
          "names": [
            "--network-concurrency"
          ],
          "description": "Maximum number of concurrent network requests",
          "args": {
            "name": "number"
          }
        },
        {
          "names": [
            "--network-timeout"
          ],
          "description": "TCP timeout for network requests",
          "args": {
            "name": "milliseconds"
          }
        },
        {
          "names": [
            "--non-interactive"
          ],
          "description": "Do not show interactive prompts"
        },
        {
          "names": [
            "--scripts-prepend-node-path"
          ],
          "description": "Prepend the node executable dir to the PATH in scripts"
        },
        {
          "names": [
            "--no-node-version-check"
          ],
          "description": "Do not warn when using a potentially unsupported Node version"
        },
        {
          "names": [
            "--focus"
          ],
          "description": "Focus on a single workspace by installing remote copies of its sibling workspaces"
        },
        {
          "names": [
            "--otp"
          ],
          "description": "One-time password for two factor authentication",
          "args": {
            "name": "otpcode"
          }
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Output usage information"
        },
        {
          "names": [
            "--new-version"
          ],
          "description": "New version",
          "args": {
            "name": "version"
          }
        },
        {
          "names": [
            "--major"
          ],
          "description": "Auto-increment major version number"
        },
        {
          "names": [
            "--minor"
          ],
          "description": "Auto-increment minor version number"
        },
        {
          "names": [
            "--patch"
          ],
          "description": "Auto-increment patch version number"
        },
        {
          "names": [
            "--premajor"
          ],
          "description": "Auto-increment premajor version number"
        },
        {
          "names": [
            "--preminor"
          ],
          "description": "Auto-increment preminor version number"
        },
        {
          "names": [
            "--prepatch"
          ],
          "description": "Auto-increment prepatch version number"
        },
        {
          "names": [
            "--prerelease"
          ],
          "description": "Auto-increment prerelease version number"
        },
        {
          "names": [
            "--preid"
          ],
          "description": "Add a custom identifier to the prerelease",
          "args": {
            "name": "preid"
          }
        },
        {
          "names": [
            "--message"
          ],
          "description": "Message",
          "args": {
            "name": "message"
          }
        },
        {
          "names": [
            "--no-git-tag-version"
          ],
          "description": "No git tag version"
        },
        {
          "names": [
            "--no-commit-hooks"
          ],
          "description": "Bypass git hooks when committing new version"
        },
        {
          "names": [
            "--access"
          ],
          "description": "Access",
          "args": {
            "name": "access"
          }
        },
        {
          "names": [
            "--tag"
          ],
          "description": "Tag",
          "args": {
            "name": "tag"
          }
        }
      ]
    },
    {
      "name": "versions",
      "description": "Displays version information of the currently installed Yarn, Node.js, and its dependencies"
    },
    {
      "name": "why",
      "description": "Show information about why a package is installed",
      "options": [
        {
          "names": [
            "-s",
            "--silent"
          ],
          "description": "Skip Yarn console logs"
        },
        {
          "names": [
            "--no-default-rc"
          ],
          "description": "Prevent Yarn from automatically detecting yarnrc and npmrc files"
        },
        {
          "names": [
            "--use-yarnrc"
          ],
          "description": "Specifies a yarnrc file that Yarn should use (.yarnrc only, not .npmrc) (default: )",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--verbose"
          ],
          "description": "Output verbose messages on internal operations"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Trigger an error if any required dependencies are not available in local cache"
        },
        {
          "names": [
            "--prefer-offline"
          ],
          "description": "Use network only if dependencies are not available in local cache"
        },
        {
          "names": [
            "--enable-pnp",
            "--pnp"
          ],
          "description": "Enable the Plug'n'Play installation"
        },
        {
          "names": [
            "--json"
          ],
          "description": "Format Yarn log messages as lines of JSON"
        },
        {
          "names": [
            "--ignore-scripts"
          ],
          "description": "Don't run lifecycle scripts"
        },
        {
          "names": [
            "--har"
          ],
          "description": "Save HAR output of network traffic"
        },
        {
          "names": [
            "--ignore-platform"
          ],
          "description": "Ignore platform checks"
        },
        {
          "names": [
            "--ignore-engines"
          ],
          "description": "Ignore engines check"
        },
        {
          "names": [
            "--ignore-optional"
          ],
          "description": "Ignore optional dependencies"
        },
        {
          "names": [
            "--force"
          ],
          "description": "Install and build packages even if they were built before, overwrite lockfile"
        },
        {
          "names": [
            "--skip-integrity-check"
          ],
          "description": "Run install without checking if node_modules is installed"
        },
        {
          "names": [
            "--check-files"
          ],
          "description": "Install will verify file tree of packages for consistency"
        },
        {
          "names": [
            "--no-bin-links"
          ],
          "description": "Don't generate bin links when setting up packages"
        },
        {
          "names": [
            "--flat"
          ],
          "description": "Only allow one version of a package"
        },
        {
          "names": [
            "--prod",
            "--production"
          ],
          "description": "Instruct Yarn to ignore NODE_ENV and take its production-or-not status from this flag instead"
        },
        {
          "names": [
            "--no-lockfile"
          ],
          "description": "Don't read or generate a lockfile"
        },
        {
          "names": [
            "--pure-lockfile"
          ],
          "description": "Don't generate a lockfile"
        },
        {
          "names": [
            "--frozen-lockfile"
          ],
          "description": "Don't generate a lockfile and fail if an update is needed"
        },
        {
          "names": [
            "--update-checksums"
          ],
          "description": "Update package checksums from current repository"
        },
        {
          "names": [
            "--link-duplicates"
          ],
          "description": "Create hardlinks to the repeated modules in node_modules"
        },
        {
          "names": [
            "--link-folder"
          ],
          "description": "Specify a custom folder to store global links",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--global-folder"
          ],
          "description": "Specify a custom folder to store global packages",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--modules-folder"
          ],
          "description": "Rather than installing modules into the node_modules folder relative to the cwd, output them here",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--preferred-cache-folder"
          ],
          "description": "Specify a custom folder to store the yarn cache if possible",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--cache-folder"
          ],
          "description": "Specify a custom folder that must be used to store the yarn cache",
          "args": {
            "name": "path"
          }
        },
        {
          "names": [
            "--mutex"
          ],
          "description": "Use a mutex to ensure only one yarn instance is executing",
          "args": {
            "name": "type[:specifier]"
          }
        },
        {
          "names": [
            "--emoji"
          ],
          "description": "Enables emoji in output",
          "args": {
            "suggestions": [
              "true",
              "false"
            ]
          }
        },
        {
          "names": [
            "--cwd"
          ],
          "description": "Working directory to use",
          "args": {
            "name": "cwd"
          }
        },
        {
          "names": [
            "--proxy",
            "--https-proxy"
          ],
          "args": {
            "name": "host"
          }
        },
        {
          "names": [
            "--registry"
          ],
          "description": "Override configuration registry",
          "args": {
            "name": "url"
          }
        },
        {
          "names": [
            "--no-progress"
          ],
          "description": "Disable progress bar"
        },
        {
          "names": [
            "--network-concurrency"
          ],
          "description": "Maximum number of concurrent network requests",
          "args": {
            "name": "number"
          }
        },
        {
          "names": [
            "--network-timeout"
          ],
          "description": "TCP timeout for network requests",
          "args": {
            "name": "milliseconds"
          }
        },
        {
          "names": [
            "--non-interactive"
          ],
          "description": "Do not show interactive prompts"
        },
        {
          "names": [
            "--scripts-prepend-node-path"
          ],
          "description": "Prepend the node executable dir to the PATH in scripts"
        },
        {
          "names": [
            "--no-node-version-check"
          ],
          "description": "Do not warn when using a potentially unsupported Node version"
        },
        {
          "names": [
            "--focus"
          ],
          "description": "Focus on a single workspace by installing remote copies of its sibling workspaces"
        },
        {
          "names": [
            "--otp"
          ],
          "description": "One-time password for two factor authentication",
          "args": {
            "name": "otpcode"
          }
        },
        {
          "names": [
            "-h",
            "--help"
          ],
          "description": "Output usage information"
        },
        {
          "names": [
            "--peers"
          ],
          "description": "Print the peer dependencies that match the specified name"
        },
        {
          "names": [
            "-R",
            "--recursive"
          ],
          "description": "List, for each workspace, what are all the paths that lead to the dependency"
        }
      ],
      "args": [
        {
          "name": "package",
          "generators": [
            {
              "kind": "script",
              "script": [
                "yarn",
                "list",
                "--depth=0",
                "--json"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "workspace",
      "description": "Manage workspace",
      "generators": []
    },
    {
      "name": "workspaces",
      "description": "Show information about your workspaces",
      "options": [
        {
          "names": [
            "subcommand"
          ],
          "args": {
            "suggestions": [
              "info",
              "run"
            ]
          }
        },
        {
          "names": [
            "flags"
          ]
        }
      ]
    },
    {
      "name": "set",
      "description": "Set global Yarn options",
      "subcommands": [
        {
          "name": "resolution",
          "description": "Enforce a package resolution",
          "options": [
            {
              "names": [
                "-s",
                "--save"
              ],
              "description": "Persist the resolution inside the top-level manifest"
            }
          ],
          "args": [
            {
              "name": "descriptor",
              "description": "A descriptor for the package, in the form of 'lodash@npm:^1.2.3'"
            },
            {
              "name": "resolution",
              "description": "The version of the package to resolve"
            }
          ]
        },
        {
          "name": "version",
          "description": "Lock the Yarn version used by the project",
          "options": [
            {
              "names": [
                "--only-if-needed"
              ],
              "description": "Only lock the Yarn version if it isn't already locked"
            }
          ],
          "args": [
            {
              "name": "version",
              "description": "Use the specified version, which can also be a Yarn 2 build (e.g 2.0.0-rc.30) or a Yarn 1 build (e.g 1.22.1)",
              "suggestions": [
                "from-sources",
                "latest",
                "canary",
                "classic",
                "self"
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
        "--disable-pnp"
      ],
      "description": "Disable the Plug'n'Play installation"
    },
    {
      "names": [
        "--emoji"
      ],
      "description": "Enable emoji in output (default: true)",
      "args": {
        "name": "bool",
        "suggestions": [
          "true",
          "false"
        ]
      }
    },
    {
      "names": [
        "--enable-pnp",
        "--pnp"
      ],
      "description": "Enable the Plug'n'Play installation"
    },
    {
      "names": [
        "--flat"
      ],
      "description": "Only allow one version of a package"
    },
    {
      "names": [
        "--focus"
      ],
      "description": "Focus on a single workspace by installing remote copies of its sibling workspaces"
    },
    {
      "names": [
        "--force"
      ],
      "description": "Install and build packages even if they were built before, overwrite lockfile"
    },
    {
      "names": [
        "--frozen-lockfile"
      ],
      "description": "Don't generate a lockfile and fail if an update is needed"
    },
    {
      "names": [
        "--global-folder"
      ],
      "description": "Specify a custom folder to store global packages"
    },
    {
      "names": [
        "--har"
      ],
      "description": "Save HAR output of network traffic"
    },
    {
      "names": [
        "--https-proxy"
      ],
      "args": {
        "name": "path",
        "suggestions": [
          "https://"
        ]
      }
    },
    {
      "names": [
        "--ignore-engines"
      ],
      "description": "Ignore engines check"
    },
    {
      "names": [
        "--ignore-optional"
      ],
      "description": "Ignore optional dependencies"
    },
    {
      "names": [
        "--ignore-platform"
      ],
      "description": "Ignore platform checks"
    },
    {
      "names": [
        "--ignore-scripts"
      ],
      "description": "Don't run lifecycle scripts"
    },
    {
      "names": [
        "--json"
      ],
      "description": "Format Yarn log messages as lines of JSON (see jsonlines.org)"
    },
    {
      "names": [
        "--link-duplicates"
      ],
      "description": "Create hardlinks to the repeated modules in node_modules"
    },
    {
      "names": [
        "--link-folder"
      ],
      "description": "Specify a custom folder to store global links"
    },
    {
      "names": [
        "--modules-folder"
      ],
      "description": "Rather than installing modules into the node_modules folder relative to the cwd, output them here"
    },
    {
      "names": [
        "--mutex"
      ],
      "description": "Use a mutex to ensure only one yarn instance is executing",
      "args": {
        "name": "type",
        "suggestions": [
          ":"
        ]
      }
    },
    {
      "names": [
        "--network-concurrency"
      ],
      "description": "Maximum number of concurrent network requests",
      "args": {
        "name": "number"
      }
    },
    {
      "names": [
        "--network-timeout"
      ],
      "description": "TCP timeout for network requests",
      "args": {
        "name": "milliseconds"
      }
    },
    {
      "names": [
        "--no-bin-links"
      ],
      "description": "Don't generate bin links when setting up packages"
    },
    {
      "names": [
        "--no-default-rc"
      ],
      "description": "Prevent Yarn from automatically detecting yarnrc and npmrc files"
    },
    {
      "names": [
        "--no-lockfile"
      ],
      "description": "Don't read or generate a lockfile"
    },
    {
      "names": [
        "--non-interactive"
      ],
      "description": "Do not show interactive prompts"
    },
    {
      "names": [
        "--no-node-version-check"
      ],
      "description": "Do not warn when using a potentially unsupported Node version"
    },
    {
      "names": [
        "--no-progress"
      ],
      "description": "Disable progress bar"
    },
    {
      "names": [
        "--offline"
      ],
      "description": "Trigger an error if any required dependencies are not available in local cache"
    },
    {
      "names": [
        "--otp"
      ],
      "description": "One-time password for two factor authentication",
      "args": {
        "name": "otpcode"
      }
    },
    {
      "names": [
        "--prefer-offline"
      ],
      "description": "Use network only if dependencies are not available in local cache"
    },
    {
      "names": [
        "--preferred-cache-folder"
      ],
      "description": "Specify a custom folder to store the yarn cache if possible"
    },
    {
      "names": [
        "--prod",
        "--production"
      ]
    },
    {
      "names": [
        "--proxy"
      ],
      "args": {
        "name": "host"
      }
    },
    {
      "names": [
        "--pure-lockfile"
      ],
      "description": "Don't generate a lockfile"
    },
    {
      "names": [
        "--registry"
      ],
      "description": "Override configuration registry",
      "args": {
        "name": "url"
      }
    },
    {
      "names": [
        "-s",
        "--silent"
      ],
      "description": "Skip Yarn console logs, other types of logs (script output) will be printed"
    },
    {
      "names": [
        "--scripts-prepend-node-path"
      ],
      "description": "Prepend the node executable dir to the PATH in scripts",
      "args": {
        "suggestions": [
          "true",
          "false"
        ]
      }
    },
    {
      "names": [
        "--skip-integrity-check"
      ],
      "description": "Run install without checking if node_modules is installed"
    },
    {
      "names": [
        "--strict-semver"
      ]
    },
    {
      "names": [
        "-s",
        "--silent"
      ],
      "description": "Skip Yarn console logs"
    },
    {
      "names": [
        "--no-default-rc"
      ],
      "description": "Prevent Yarn from automatically detecting yarnrc and npmrc files"
    },
    {
      "names": [
        "--use-yarnrc"
      ],
      "description": "Specifies a yarnrc file that Yarn should use (.yarnrc only, not .npmrc) (default: )",
      "args": {
        "name": "path"
      }
    },
    {
      "names": [
        "--verbose"
      ],
      "description": "Output verbose messages on internal operations"
    },
    {
      "names": [
        "--offline"
      ],
      "description": "Trigger an error if any required dependencies are not available in local cache"
    },
    {
      "names": [
        "--prefer-offline"
      ],
      "description": "Use network only if dependencies are not available in local cache"
    },
    {
      "names": [
        "--enable-pnp",
        "--pnp"
      ],
      "description": "Enable the Plug'n'Play installation"
    },
    {
      "names": [
        "--json"
      ],
      "description": "Format Yarn log messages as lines of JSON"
    },
    {
      "names": [
        "--ignore-scripts"
      ],
      "description": "Don't run lifecycle scripts"
    },
    {
      "names": [
        "--har"
      ],
      "description": "Save HAR output of network traffic"
    },
    {
      "names": [
        "--ignore-platform"
      ],
      "description": "Ignore platform checks"
    },
    {
      "names": [
        "--ignore-engines"
      ],
      "description": "Ignore engines check"
    },
    {
      "names": [
        "--ignore-optional"
      ],
      "description": "Ignore optional dependencies"
    },
    {
      "names": [
        "--force"
      ],
      "description": "Install and build packages even if they were built before, overwrite lockfile"
    },
    {
      "names": [
        "--skip-integrity-check"
      ],
      "description": "Run install without checking if node_modules is installed"
    },
    {
      "names": [
        "--check-files"
      ],
      "description": "Install will verify file tree of packages for consistency"
    },
    {
      "names": [
        "--no-bin-links"
      ],
      "description": "Don't generate bin links when setting up packages"
    },
    {
      "names": [
        "--flat"
      ],
      "description": "Only allow one version of a package"
    },
    {
      "names": [
        "--prod",
        "--production"
      ],
      "description": "Instruct Yarn to ignore NODE_ENV and take its production-or-not status from this flag instead"
    },
    {
      "names": [
        "--no-lockfile"
      ],
      "description": "Don't read or generate a lockfile"
    },
    {
      "names": [
        "--pure-lockfile"
      ],
      "description": "Don't generate a lockfile"
    },
    {
      "names": [
        "--frozen-lockfile"
      ],
      "description": "Don't generate a lockfile and fail if an update is needed"
    },
    {
      "names": [
        "--update-checksums"
      ],
      "description": "Update package checksums from current repository"
    },
    {
      "names": [
        "--link-duplicates"
      ],
      "description": "Create hardlinks to the repeated modules in node_modules"
    },
    {
      "names": [
        "--link-folder"
      ],
      "description": "Specify a custom folder to store global links",
      "args": {
        "name": "path"
      }
    },
    {
      "names": [
        "--global-folder"
      ],
      "description": "Specify a custom folder to store global packages",
      "args": {
        "name": "path"
      }
    },
    {
      "names": [
        "--modules-folder"
      ],
      "description": "Rather than installing modules into the node_modules folder relative to the cwd, output them here",
      "args": {
        "name": "path"
      }
    },
    {
      "names": [
        "--preferred-cache-folder"
      ],
      "description": "Specify a custom folder to store the yarn cache if possible",
      "args": {
        "name": "path"
      }
    },
    {
      "names": [
        "--cache-folder"
      ],
      "description": "Specify a custom folder that must be used to store the yarn cache",
      "args": {
        "name": "path"
      }
    },
    {
      "names": [
        "--mutex"
      ],
      "description": "Use a mutex to ensure only one yarn instance is executing",
      "args": {
        "name": "type[:specifier]"
      }
    },
    {
      "names": [
        "--emoji"
      ],
      "description": "Enables emoji in output",
      "args": {
        "suggestions": [
          "true",
          "false"
        ]
      }
    },
    {
      "names": [
        "--cwd"
      ],
      "description": "Working directory to use",
      "args": {
        "name": "cwd"
      }
    },
    {
      "names": [
        "--proxy",
        "--https-proxy"
      ],
      "args": {
        "name": "host"
      }
    },
    {
      "names": [
        "--registry"
      ],
      "description": "Override configuration registry",
      "args": {
        "name": "url"
      }
    },
    {
      "names": [
        "--no-progress"
      ],
      "description": "Disable progress bar"
    },
    {
      "names": [
        "--network-concurrency"
      ],
      "description": "Maximum number of concurrent network requests",
      "args": {
        "name": "number"
      }
    },
    {
      "names": [
        "--network-timeout"
      ],
      "description": "TCP timeout for network requests",
      "args": {
        "name": "milliseconds"
      }
    },
    {
      "names": [
        "--non-interactive"
      ],
      "description": "Do not show interactive prompts"
    },
    {
      "names": [
        "--scripts-prepend-node-path"
      ],
      "description": "Prepend the node executable dir to the PATH in scripts"
    },
    {
      "names": [
        "--no-node-version-check"
      ],
      "description": "Do not warn when using a potentially unsupported Node version"
    },
    {
      "names": [
        "--focus"
      ],
      "description": "Focus on a single workspace by installing remote copies of its sibling workspaces"
    },
    {
      "names": [
        "--otp"
      ],
      "description": "One-time password for two factor authentication",
      "args": {
        "name": "otpcode"
      }
    },
    {
      "names": [
        "-v",
        "--version"
      ],
      "description": "Output the version number"
    },
    {
      "names": [
        "-h",
        "--help"
      ],
      "description": "Output usage information"
    }
  ],
  "args": [
    {
      "isOptional": true,
      "generators": [
        {
          "kind": "script",
          "script": [
            "bash",
            "-c",
            "until [[ -f package.json ]] || [[ $PWD = '/' ]]; do cd ..; done; cat package.json"
          ]
        }
      ]
    }
  ]
};
