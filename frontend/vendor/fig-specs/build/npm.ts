// 由 scripts/sync_fig_specs.mjs 生成（withfig/autocomplete @ aef52acff84c45edde61ae610cc2c964802b9a38）——纯数据，勿手改。
// 归一化形态见 src/lib/completion/fig/types.ts；重生成：pnpm fig:sync
import type { FigSpecRoot } from "../../../src/lib/completion/fig/types";

export const spec: FigSpecRoot = {
  "name": "npm",
  "description": "Node package manager",
  "subcommands": [
    {
      "name": "install",
      "aliases": [
        "i",
        "add"
      ],
      "description": "Install a package and its dependencies",
      "options": [
        {
          "names": [
            "-P",
            "--save-prod"
          ],
          "description": "Package will appear in your `dependencies`. This is the default unless `-D` or `-O` are present"
        },
        {
          "names": [
            "-D",
            "--save-dev"
          ],
          "description": "Package will appear in your `devDependencies`"
        },
        {
          "names": [
            "-O",
            "--save-optional"
          ],
          "description": "Package will appear in your `optionalDependencies`"
        },
        {
          "names": [
            "--no-save"
          ],
          "description": "Prevents saving to `dependencies`"
        },
        {
          "names": [
            "-E",
            "--save-exact"
          ],
          "description": "Saved dependencies will be configured with an exact version rather than using npm's default semver range operator"
        },
        {
          "names": [
            "-B",
            "--save-bundle"
          ],
          "description": "Saved dependencies will also be added to your bundleDependencies list"
        },
        {
          "names": [
            "-g",
            "--global"
          ],
          "description": "Operates in 'global' mode, so that packages are installed into the prefix folder instead of the current working directory"
        },
        {
          "names": [
            "--global-style"
          ],
          "description": "Causes npm to install the package into your local node_modules folder with the same layout it uses with the global node_modules folder"
        },
        {
          "names": [
            "--legacy-bundling"
          ],
          "description": "Causes npm to install the package such that versions of npm prior to 1.4, such as the one included with node 0.8, can install the package"
        },
        {
          "names": [
            "--legacy-peer-deps"
          ],
          "description": "Bypass peerDependency auto-installation. Emulate install behavior of NPM v4 through v6"
        },
        {
          "names": [
            "--strict-peer-deps"
          ],
          "description": "If set to true, and --legacy-peer-deps is not set, then any conflicting peerDependencies will be treated as an install failure"
        },
        {
          "names": [
            "--no-package-lock"
          ],
          "description": "Ignores package-lock.json files when installing"
        },
        {
          "names": [
            "--registry"
          ],
          "description": "The base URL of the npm registry",
          "args": {
            "name": "registry"
          }
        },
        {
          "names": [
            "--verbose"
          ],
          "description": "Show extra information",
          "args": {
            "name": "verbose"
          }
        },
        {
          "names": [
            "--omit"
          ],
          "description": "Dependency types to omit from the installation tree on disk",
          "args": {
            "name": "Package type",
            "suggestions": [
              "dev",
              "optional",
              "peer"
            ]
          }
        },
        {
          "names": [
            "--ignore-scripts"
          ],
          "description": "If true, npm does not run scripts specified in package.json files"
        },
        {
          "names": [
            "--no-audit"
          ],
          "description": "Submit audit reports alongside the current npm command to the default registry and all registries configured for scopes"
        },
        {
          "names": [
            "--no-bin-links"
          ],
          "description": "Tells npm to not create symlinks (or .cmd shims on Windows) for package executables"
        },
        {
          "names": [
            "--no-fund"
          ],
          "description": "Hides the message at the end of each npm install acknowledging the number of dependencies looking for funding"
        },
        {
          "names": [
            "--dry-run"
          ],
          "description": "Indicates that you don't want npm to make any changes and that it should only report what it would have done"
        },
        {
          "names": [
            "-w",
            "--workspace"
          ],
          "description": "Enable running a command in the context of the configured workspaces of the current project",
          "args": {
            "name": "workspace",
            "isVariadic": true
          }
        },
        {
          "names": [
            "-ws",
            "--workspaces"
          ],
          "description": "Enable running a command in the context of all the configured workspaces"
        }
      ],
      "args": [
        {
          "name": "package",
          "isVariadic": true,
          "isOptional": true
        }
      ]
    },
    {
      "name": "run",
      "aliases": [
        "run-script"
      ],
      "description": "Run arbitrary package scripts",
      "options": [
        {
          "names": [
            "-w",
            "--workspace"
          ],
          "description": "Enable running a command in the context of the configured workspaces of the current project",
          "args": {
            "name": "workspace",
            "isVariadic": true
          }
        },
        {
          "names": [
            "-ws",
            "--workspaces"
          ],
          "description": "Enable running a command in the context of all the configured workspaces"
        },
        {
          "names": [
            "--if-present"
          ],
          "description": "Npm will not exit with an error code when run-script is invoked for a script that isn't defined in the scripts section of package.json"
        },
        {
          "names": [
            "--silent"
          ]
        },
        {
          "names": [
            "--ignore-scripts"
          ],
          "description": "If true, npm does not run scripts specified in package.json files"
        },
        {
          "names": [
            "--script-shell"
          ],
          "description": "The shell to use for scripts run with the npm exec, npm run and npm init <pkg> commands",
          "args": {
            "name": "script-shell"
          }
        },
        {
          "names": [
            "--"
          ],
          "args": {
            "name": "args",
            "isVariadic": true
          }
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
        }
      ]
    },
    {
      "name": "init",
      "description": "Trigger the initialization",
      "options": [
        {
          "names": [
            "-y",
            "--yes"
          ],
          "description": "Automatically answer 'yes' to any prompts that npm might print on the command line"
        },
        {
          "names": [
            "-w"
          ],
          "description": "Create the folders and boilerplate expected while also adding a reference to your project workspaces property",
          "args": {
            "name": "dir"
          }
        }
      ]
    },
    {
      "name": "access",
      "description": "Set access controls on private packages"
    },
    {
      "name": "adduser",
      "aliases": [
        "login"
      ],
      "description": "Add a registry user account",
      "options": [
        {
          "names": [
            "--registry"
          ],
          "description": "The base URL of the npm registry",
          "args": {
            "name": "registry"
          }
        },
        {
          "names": [
            "--scope"
          ],
          "description": "Associate an operation with a scope for a scoped registry",
          "args": {
            "name": "scope",
            "description": "Scope name"
          }
        }
      ]
    },
    {
      "name": "audit",
      "description": "Run a security audit",
      "subcommands": [
        {
          "name": "fix",
          "description": "If the fix argument is provided, then remediations will be applied to the package tree",
          "options": [
            {
              "names": [
                "--dry-run"
              ],
              "description": "Indicates that you don't want npm to make any changes and that it should only report what it would have done"
            },
            {
              "names": [
                "-f",
                "--force"
              ],
              "description": "Removes various protections against unfortunate side effects, common mistakes, unnecessary performance degradation, and malicious input"
            },
            {
              "names": [
                "-w",
                "--workspace"
              ],
              "description": "Enable running a command in the context of the configured workspaces of the current project",
              "args": {
                "name": "workspace",
                "isVariadic": true
              }
            },
            {
              "names": [
                "-ws",
                "--workspaces"
              ],
              "description": "Enable running a command in the context of all the configured workspaces"
            }
          ]
        }
      ],
      "options": [
        {
          "names": [
            "-w",
            "--workspace"
          ],
          "description": "Enable running a command in the context of the configured workspaces of the current project",
          "args": {
            "name": "workspace",
            "isVariadic": true
          }
        },
        {
          "names": [
            "-ws",
            "--workspaces"
          ],
          "description": "Enable running a command in the context of all the configured workspaces"
        },
        {
          "names": [
            "--audit-level"
          ],
          "description": "The minimum level of vulnerability for npm audit to exit with a non-zero exit code",
          "args": {
            "name": "audit",
            "suggestions": [
              "info",
              "low",
              "moderate",
              "high",
              "critical",
              "none"
            ]
          }
        },
        {
          "names": [
            "--package-lock-only"
          ],
          "description": "Current operation will only use the package-lock.json, ignoring node_modules"
        },
        {
          "names": [
            "--json"
          ],
          "description": "Show output in json format"
        },
        {
          "names": [
            "--omit"
          ],
          "description": "Dependency types to omit from the installation tree on disk",
          "args": {
            "name": "Package type",
            "suggestions": [
              "dev",
              "optional",
              "peer"
            ]
          }
        }
      ]
    },
    {
      "name": "bin",
      "description": "Print the folder where npm will install executables",
      "options": [
        {
          "names": [
            "-g",
            "--global"
          ],
          "description": "Operates in 'global' mode, so that packages are installed into the prefix folder instead of the current working directory"
        }
      ]
    },
    {
      "name": "bugs",
      "aliases": [
        "issues"
      ],
      "description": "Report bugs for a package in a web browser",
      "options": [
        {
          "names": [
            "--no-browser"
          ],
          "description": "Display in command line instead of browser"
        },
        {
          "names": [
            "--browser"
          ],
          "description": "The browser that is called by the npm bugs command to open websites",
          "args": {
            "name": "browser"
          }
        },
        {
          "names": [
            "--registry"
          ],
          "description": "The base URL of the npm registry",
          "args": {
            "name": "registry"
          }
        }
      ],
      "args": [
        {
          "name": "package",
          "isVariadic": true,
          "isOptional": true
        }
      ]
    },
    {
      "name": "cache",
      "description": "Manipulates packages cache",
      "subcommands": [
        {
          "name": "add",
          "description": "Add the specified packages to the local cache"
        },
        {
          "name": "clean",
          "description": "Delete all data out of the cache folder"
        },
        {
          "name": "verify",
          "description": "Verify the contents of the cache folder, garbage collecting any unneeded data, and verifying the integrity of the cache index and all cached data"
        }
      ],
      "options": [
        {
          "names": [
            "--cache"
          ],
          "description": "The location of npm's cache directory",
          "args": {
            "name": "cache"
          }
        }
      ]
    },
    {
      "name": "ci",
      "aliases": [
        "clean-install",
        "install-clean"
      ],
      "description": "Install a project with a clean slate",
      "options": [
        {
          "names": [
            "--audit"
          ],
          "description": "When \"true\" submit audit reports alongside the current npm command to the default registry and all registries configured for scopes",
          "args": {
            "name": "audit",
            "suggestions": [
              "true",
              "false"
            ]
          }
        },
        {
          "names": [
            "--no-audit"
          ],
          "description": "Do not submit audit reports alongside the current npm command"
        },
        {
          "names": [
            "--ignore-scripts"
          ],
          "description": "If true, npm does not run scripts specified in package.json files"
        },
        {
          "names": [
            "--script-shell"
          ],
          "description": "The shell to use for scripts run with the npm exec, npm run and npm init <pkg> commands",
          "args": {
            "name": "script-shell"
          }
        },
        {
          "names": [
            "--verbose"
          ],
          "description": "Show extra information",
          "args": {
            "name": "verbose"
          }
        },
        {
          "names": [
            "--registry"
          ],
          "description": "The base URL of the npm registry",
          "args": {
            "name": "registry"
          }
        }
      ]
    },
    {
      "name": "cit",
      "description": "Install a project with a clean slate and run tests"
    },
    {
      "name": "clean-install-test",
      "description": "Install a project with a clean slate and run tests"
    },
    {
      "name": "completion",
      "description": "Tab completion for npm"
    },
    {
      "name": "config",
      "aliases": [
        "c"
      ],
      "description": "Manage the npm configuration files",
      "subcommands": [
        {
          "name": "set",
          "description": "Sets the config key to the value",
          "options": [
            {
              "names": [
                "-g",
                "--global"
              ],
              "description": "Sets it globally"
            }
          ],
          "args": [
            {
              "name": "key"
            },
            {
              "name": "value"
            }
          ]
        },
        {
          "name": "get",
          "description": "Echo the config value to stdout",
          "args": [
            {
              "name": "key"
            }
          ]
        },
        {
          "name": "list",
          "description": "Show all the config settings",
          "options": [
            {
              "names": [
                "-g"
              ],
              "description": "Lists globally installed packages"
            },
            {
              "names": [
                "-l"
              ],
              "description": "Also shows defaults"
            },
            {
              "names": [
                "--json"
              ],
              "description": "Show output in json format"
            }
          ]
        },
        {
          "name": "delete",
          "description": "Deletes the key from all configuration files",
          "args": [
            {
              "name": "key"
            }
          ]
        },
        {
          "name": "edit",
          "description": "Opens the config file in an editor",
          "options": [
            {
              "names": [
                "--global"
              ],
              "description": "Edits the global config"
            }
          ]
        }
      ]
    },
    {
      "name": "create",
      "description": "Create a package.json file"
    },
    {
      "name": "dedupe",
      "aliases": [
        "ddp"
      ],
      "description": "Reduce duplication in the package tree"
    },
    {
      "name": "deprecate",
      "description": "Deprecate a version of a package",
      "options": [
        {
          "names": [
            "--registry"
          ],
          "description": "The base URL of the npm registry",
          "args": {
            "name": "registry"
          }
        }
      ]
    },
    {
      "name": "dist-tag",
      "description": "Modify package distribution tags"
    },
    {
      "name": "docs",
      "aliases": [
        "home"
      ],
      "description": "Open documentation for a package in a web browser",
      "options": [
        {
          "names": [
            "-w",
            "--workspace"
          ],
          "description": "Enable running a command in the context of the configured workspaces of the current project",
          "args": {
            "name": "workspace",
            "isVariadic": true
          }
        },
        {
          "names": [
            "-ws",
            "--workspaces"
          ],
          "description": "Enable running a command in the context of all the configured workspaces"
        },
        {
          "names": [
            "--registry"
          ],
          "description": "The base URL of the npm registry",
          "args": {
            "name": "registry"
          }
        },
        {
          "names": [
            "--no-browser"
          ],
          "description": "Display in command line instead of browser"
        },
        {
          "names": [
            "--browser"
          ],
          "description": "The browser that is called by the npm docs command to open websites",
          "args": {
            "name": "browser"
          }
        }
      ],
      "args": [
        {
          "name": "package",
          "isVariadic": true,
          "isOptional": true
        }
      ]
    },
    {
      "name": "doctor",
      "description": "Check your npm environment",
      "options": [
        {
          "names": [
            "--registry"
          ],
          "description": "The base URL of the npm registry",
          "args": {
            "name": "registry"
          }
        }
      ]
    },
    {
      "name": "edit",
      "description": "Edit an installed package",
      "options": [
        {
          "names": [
            "--editor"
          ],
          "description": "The command to run for npm edit or npm config edit"
        }
      ]
    },
    {
      "name": "explore",
      "description": "Browse an installed package",
      "args": [
        {
          "name": "package"
        }
      ]
    },
    {
      "name": "fund",
      "description": "Retrieve funding information"
    },
    {
      "name": "get",
      "description": "Echo the config value to stdout"
    },
    {
      "name": "help",
      "description": "Get help on npm",
      "options": [
        {
          "names": [
            "--viewer"
          ],
          "description": "The program to use to view help content",
          "args": {
            "name": "viewer"
          }
        }
      ],
      "args": [
        {
          "name": "term",
          "description": "Terms to search for",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "help-search",
      "description": "Search npm help documentation",
      "options": [
        {
          "names": [
            "-l",
            "--long"
          ],
          "description": "Show extended information"
        }
      ],
      "args": [
        {
          "name": "text",
          "description": "Text to search for"
        }
      ]
    },
    {
      "name": "hook",
      "description": "Manage registry hooks"
    },
    {
      "name": "install-ci-test",
      "description": "Install a project with a clean slate and run tests"
    },
    {
      "name": "install-test",
      "description": "Install package(s) and run tests"
    },
    {
      "name": "it",
      "description": "Install package(s) and run tests"
    },
    {
      "name": "link",
      "description": "Symlink a package folder",
      "args": [
        {
          "name": "path"
        }
      ]
    },
    {
      "name": "ln",
      "description": "Symlink a package folder"
    },
    {
      "name": "logout",
      "description": "Log out of the registry",
      "options": [
        {
          "names": [
            "--registry"
          ],
          "description": "The base URL of the npm registry",
          "args": {
            "name": "registry"
          }
        },
        {
          "names": [
            "--scope"
          ],
          "description": "Associate an operation with a scope for a scoped registry",
          "args": {
            "name": "scope",
            "description": "Scope name"
          }
        }
      ]
    },
    {
      "name": "ls",
      "aliases": [
        "list"
      ],
      "description": "List installed packages",
      "options": [
        {
          "names": [
            "-a",
            "-all"
          ],
          "description": "Show all outdated or installed packages"
        },
        {
          "names": [
            "--json"
          ],
          "description": "Show output in json format"
        },
        {
          "names": [
            "-l",
            "--long"
          ],
          "description": "Show extended information"
        },
        {
          "names": [
            "-p",
            "--parseable"
          ],
          "description": "Output parseable results from commands that write to standard output"
        },
        {
          "names": [
            "--depth"
          ],
          "description": "The depth to go when recursing packages",
          "args": {
            "name": "depth"
          }
        },
        {
          "names": [
            "--link"
          ],
          "description": "Limits output to only those packages that are linked"
        },
        {
          "names": [
            "--package-lock-only"
          ],
          "description": "Current operation will only use the package-lock.json, ignoring node_modules"
        },
        {
          "names": [
            "--no-unicode"
          ],
          "description": "Uses unicode characters in the tree output"
        },
        {
          "names": [
            "-g",
            "--global"
          ],
          "description": "Operates in 'global' mode, so that packages are installed into the prefix folder instead of the current working directory"
        },
        {
          "names": [
            "--omit"
          ],
          "description": "Dependency types to omit from the installation tree on disk",
          "args": {
            "name": "Package type",
            "suggestions": [
              "dev",
              "optional",
              "peer"
            ]
          }
        },
        {
          "names": [
            "-w",
            "--workspace"
          ],
          "description": "Enable running a command in the context of the configured workspaces of the current project",
          "args": {
            "name": "workspace",
            "isVariadic": true
          }
        },
        {
          "names": [
            "-ws",
            "--workspaces"
          ],
          "description": "Enable running a command in the context of all the configured workspaces"
        }
      ],
      "args": [
        {
          "name": "[@scope]/pkg",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "org",
      "description": "Manage orgs",
      "subcommands": [
        {
          "name": "set",
          "description": "Add a user to an org or manage roles",
          "options": [
            {
              "names": [
                "--registry"
              ],
              "description": "The base URL of the npm registry",
              "args": {
                "name": "registry"
              }
            },
            {
              "names": [
                "--otp"
              ],
              "description": "One-time password from a two-factor authenticator",
              "args": {
                "name": "otp"
              }
            }
          ],
          "args": [
            {
              "name": "orgname",
              "description": "Organization name"
            },
            {
              "name": "username",
              "description": "User name"
            },
            {
              "name": "role",
              "isOptional": true,
              "suggestions": [
                "developer",
                "admin",
                "owner"
              ]
            }
          ]
        },
        {
          "name": "rm",
          "description": "Remove a user from an org",
          "options": [
            {
              "names": [
                "--registry"
              ],
              "description": "The base URL of the npm registry",
              "args": {
                "name": "registry"
              }
            },
            {
              "names": [
                "--otp"
              ],
              "description": "One-time password from a two-factor authenticator",
              "args": {
                "name": "otp"
              }
            }
          ],
          "args": [
            {
              "name": "orgname",
              "description": "Organization name"
            },
            {
              "name": "username",
              "description": "User name"
            }
          ]
        },
        {
          "name": "ls",
          "description": "List users in an org or see what roles a particular user has in an org",
          "options": [
            {
              "names": [
                "--registry"
              ],
              "description": "The base URL of the npm registry",
              "args": {
                "name": "registry"
              }
            },
            {
              "names": [
                "--otp"
              ],
              "description": "One-time password from a two-factor authenticator",
              "args": {
                "name": "otp"
              }
            },
            {
              "names": [
                "--json"
              ],
              "description": "Show output in json format"
            },
            {
              "names": [
                "-p",
                "--parseable"
              ],
              "description": "Output parseable results from commands that write to standard output"
            }
          ],
          "args": [
            {
              "name": "orgname",
              "description": "Organization name"
            },
            {
              "name": "username",
              "description": "User name",
              "isOptional": true
            }
          ]
        }
      ]
    },
    {
      "name": "outdated",
      "description": "Check for outdated packages",
      "options": [
        {
          "names": [
            "-a",
            "-all"
          ],
          "description": "Show all outdated or installed packages"
        },
        {
          "names": [
            "--json"
          ],
          "description": "Show output in json format"
        },
        {
          "names": [
            "-l",
            "--long"
          ],
          "description": "Show extended information"
        },
        {
          "names": [
            "-p",
            "--parseable"
          ],
          "description": "Output parseable results from commands that write to standard output"
        },
        {
          "names": [
            "-g"
          ],
          "description": "Checks globally"
        },
        {
          "names": [
            "-w",
            "--workspace"
          ],
          "description": "Enable running a command in the context of the configured workspaces of the current project",
          "args": {
            "name": "workspace",
            "isVariadic": true
          }
        },
        {
          "names": [
            "-ws",
            "--workspaces"
          ],
          "description": "Enable running a command in the context of all the configured workspaces"
        }
      ],
      "args": [
        {
          "name": "[<@scope>/]<pkg>",
          "isVariadic": true,
          "isOptional": true
        }
      ]
    },
    {
      "name": "owner",
      "aliases": [
        "author"
      ],
      "description": "Manage package owners",
      "subcommands": [
        {
          "name": "ls",
          "description": "List all the users who have access to modify a package and push new versions. Handy when you need to know who to bug for help",
          "options": [
            {
              "names": [
                "--registry"
              ],
              "description": "The base URL of the npm registry",
              "args": {
                "name": "registry"
              }
            }
          ],
          "args": [
            {
              "name": "[@scope/]pkg"
            }
          ]
        },
        {
          "name": "add",
          "description": "Add a new user as a maintainer of a package. This user is enabled to modify metadata, publish new versions, and add other owners",
          "options": [
            {
              "names": [
                "--registry"
              ],
              "description": "The base URL of the npm registry",
              "args": {
                "name": "registry"
              }
            },
            {
              "names": [
                "--otp"
              ],
              "description": "One-time password from a two-factor authenticator",
              "args": {
                "name": "otp"
              }
            }
          ],
          "args": [
            {
              "name": "user"
            },
            {
              "name": "[@scope/]pkg"
            }
          ]
        },
        {
          "name": "rm",
          "description": "Remove a user from the package owner list. This immediately revokes their privileges",
          "options": [
            {
              "names": [
                "--registry"
              ],
              "description": "The base URL of the npm registry",
              "args": {
                "name": "registry"
              }
            },
            {
              "names": [
                "--otp"
              ],
              "description": "One-time password from a two-factor authenticator",
              "args": {
                "name": "otp"
              }
            }
          ],
          "args": [
            {
              "name": "user"
            },
            {
              "name": "[@scope/]pkg"
            }
          ]
        }
      ]
    },
    {
      "name": "pack",
      "description": "Create a tarball from a package",
      "options": [
        {
          "names": [
            "--json"
          ],
          "description": "Show output in json format"
        },
        {
          "names": [
            "--dry-run"
          ],
          "description": "Indicates that you don't want npm to make any changes and that it should only report what it would have done"
        },
        {
          "names": [
            "-w",
            "--workspace"
          ],
          "description": "Enable running a command in the context of the configured workspaces of the current project",
          "args": {
            "name": "workspace",
            "isVariadic": true
          }
        },
        {
          "names": [
            "-ws",
            "--workspaces"
          ],
          "description": "Enable running a command in the context of all the configured workspaces"
        },
        {
          "names": [
            "--pack-destination"
          ],
          "description": "Directory in which npm pack will save tarballs",
          "args": {
            "name": "pack-destination"
          }
        }
      ],
      "args": [
        {
          "name": "[<@scope>/]<pkg>"
        }
      ]
    },
    {
      "name": "ping",
      "description": "Ping npm registry",
      "options": [
        {
          "names": [
            "--registry"
          ],
          "description": "The base URL of the npm registry",
          "args": {
            "name": "registry"
          }
        }
      ]
    },
    {
      "name": "pkg",
      "description": "Manages your package.json",
      "subcommands": [
        {
          "name": "get",
          "description": "Retrieves a value key, defined in your package.json file. It is possible to get multiple values and values for child fields",
          "options": [
            {
              "names": [
                "--json"
              ],
              "description": "Show output in json format"
            },
            {
              "names": [
                "-w",
                "--workspace"
              ],
              "description": "Enable running a command in the context of the configured workspaces of the current project",
              "args": {
                "name": "workspace",
                "isVariadic": true
              }
            },
            {
              "names": [
                "-ws",
                "--workspaces"
              ],
              "description": "Enable running a command in the context of all the configured workspaces"
            }
          ],
          "args": [
            {
              "name": "field",
              "description": "Name of the field to get. You can view child fields by separating them with a period",
              "isVariadic": true
            }
          ]
        },
        {
          "name": "set",
          "description": "Sets a value in your package.json based on the field value. It is possible to set multiple values and values for child fields",
          "options": [
            {
              "names": [
                "--json"
              ],
              "description": "Show output in json format"
            },
            {
              "names": [
                "-w",
                "--workspace"
              ],
              "description": "Enable running a command in the context of the configured workspaces of the current project",
              "args": {
                "name": "workspace",
                "isVariadic": true
              }
            },
            {
              "names": [
                "-ws",
                "--workspaces"
              ],
              "description": "Enable running a command in the context of all the configured workspaces"
            },
            {
              "names": [
                "-f",
                "--force"
              ],
              "description": "Removes various protections against unfortunate side effects, common mistakes, unnecessary performance degradation, and malicious input. Allow clobbering existing values in npm pkg"
            }
          ],
          "args": [
            {
              "name": "field",
              "description": "Name of the field to set. You can set child fields by separating them with a period",
              "isVariadic": true
            }
          ]
        },
        {
          "name": "delete",
          "description": "Deletes a key from your package.json",
          "options": [
            {
              "names": [
                "-w",
                "--workspace"
              ],
              "description": "Enable running a command in the context of the configured workspaces of the current project",
              "args": {
                "name": "workspace",
                "isVariadic": true
              }
            },
            {
              "names": [
                "-ws",
                "--workspaces"
              ],
              "description": "Enable running a command in the context of all the configured workspaces"
            },
            {
              "names": [
                "-f",
                "--force"
              ],
              "description": "Removes various protections against unfortunate side effects, common mistakes, unnecessary performance degradation, and malicious input. Allow clobbering existing values in npm pkg"
            }
          ],
          "args": [
            {
              "name": "key",
              "description": "Name of the key to delete. You can delete child fields by separating them with a period",
              "isVariadic": true
            }
          ]
        }
      ]
    },
    {
      "name": "prefix",
      "description": "Display prefix",
      "options": [
        {
          "names": [
            "-g",
            "--global"
          ],
          "description": "Print the global prefix to standard out"
        }
      ]
    },
    {
      "name": "profile",
      "description": "Change settings on your registry profile",
      "subcommands": [
        {
          "name": "get",
          "description": "Display all of the properties of your profile, or one or more specific properties",
          "options": [
            {
              "names": [
                "--registry"
              ],
              "description": "The base URL of the npm registry",
              "args": {
                "name": "registry"
              }
            },
            {
              "names": [
                "--json"
              ],
              "description": "Show output in json format"
            },
            {
              "names": [
                "-p",
                "--parseable"
              ],
              "description": "Output parseable results from commands that write to standard output"
            },
            {
              "names": [
                "--otp"
              ],
              "description": "One-time password from a two-factor authenticator",
              "args": {
                "name": "otp"
              }
            }
          ],
          "args": [
            {
              "name": "property",
              "description": "Property name",
              "isOptional": true
            }
          ]
        },
        {
          "name": "set",
          "description": "Set the value of a profile property",
          "subcommands": [
            {
              "name": "password",
              "description": "Change your password. This is interactive, you'll be prompted for your current password and a new password"
            }
          ],
          "options": [
            {
              "names": [
                "--registry"
              ],
              "description": "The base URL of the npm registry",
              "args": {
                "name": "registry"
              }
            },
            {
              "names": [
                "--json"
              ],
              "description": "Show output in json format"
            },
            {
              "names": [
                "-p",
                "--parseable"
              ],
              "description": "Output parseable results from commands that write to standard output"
            },
            {
              "names": [
                "--otp"
              ],
              "description": "One-time password from a two-factor authenticator",
              "args": {
                "name": "otp"
              }
            }
          ],
          "args": [
            {
              "name": "property",
              "description": "Property name",
              "suggestions": [
                "email",
                "fullname",
                "homepage",
                "freenode",
                "twitter",
                "github"
              ]
            },
            {
              "name": "value",
              "description": "Property value"
            }
          ]
        },
        {
          "name": "enable-2fa",
          "description": "Enables two-factor authentication",
          "options": [
            {
              "names": [
                "--registry"
              ],
              "description": "The base URL of the npm registry",
              "args": {
                "name": "registry"
              }
            },
            {
              "names": [
                "--otp"
              ],
              "description": "One-time password from a two-factor authenticator",
              "args": {
                "name": "otp"
              }
            }
          ],
          "args": [
            {
              "name": "mode",
              "description": "Mode for two-factor authentication. Defaults to auth-and-writes mode",
              "isOptional": true,
              "suggestions": [
                "auth-only",
                "auth-and-writes"
              ]
            }
          ]
        },
        {
          "name": "disable-2fa",
          "description": "Disables two-factor authentication",
          "options": [
            {
              "names": [
                "--registry"
              ],
              "description": "The base URL of the npm registry",
              "args": {
                "name": "registry"
              }
            },
            {
              "names": [
                "--otp"
              ],
              "description": "One-time password from a two-factor authenticator",
              "args": {
                "name": "otp"
              }
            }
          ]
        }
      ]
    },
    {
      "name": "prune",
      "description": "Remove extraneous packages",
      "options": [
        {
          "names": [
            "--omit"
          ],
          "description": "Dependency types to omit from the installation tree on disk",
          "args": {
            "name": "Package type",
            "suggestions": [
              "dev",
              "optional",
              "peer"
            ]
          }
        },
        {
          "names": [
            "--dry-run"
          ],
          "description": "Indicates that you don't want npm to make any changes and that it should only report what it would have done"
        },
        {
          "names": [
            "--json"
          ],
          "description": "Show output in json format"
        },
        {
          "names": [
            "--production"
          ],
          "description": "Remove the packages specified in your devDependencies"
        },
        {
          "names": [
            "-w",
            "--workspace"
          ],
          "description": "Enable running a command in the context of the configured workspaces of the current project",
          "args": {
            "name": "workspace",
            "isVariadic": true
          }
        },
        {
          "names": [
            "-ws",
            "--workspaces"
          ],
          "description": "Enable running a command in the context of all the configured workspaces"
        }
      ],
      "args": [
        {
          "name": "[<@scope>/]<pkg>",
          "isOptional": true
        }
      ]
    },
    {
      "name": "publish",
      "description": "Publish a package",
      "options": [
        {
          "names": [
            "--tag"
          ],
          "description": "Registers the published package with the given tag",
          "args": {
            "name": "tag"
          }
        },
        {
          "names": [
            "-w",
            "--workspace"
          ],
          "description": "Enable running a command in the context of the configured workspaces of the current project",
          "args": {
            "name": "workspace",
            "isVariadic": true
          }
        },
        {
          "names": [
            "-ws",
            "--workspaces"
          ],
          "description": "Enable running a command in the context of all the configured workspaces"
        },
        {
          "names": [
            "--access"
          ],
          "description": "Sets scoped package to be publicly viewable if set to 'public'",
          "args": {
            "suggestions": [
              "restricted",
              "public"
            ]
          }
        },
        {
          "names": [
            "--dry-run"
          ],
          "description": "Indicates that you don't want npm to make any changes and that it should only report what it would have done"
        },
        {
          "names": [
            "--otp"
          ],
          "description": "One-time password from a two-factor authenticator",
          "args": {
            "name": "otp"
          }
        }
      ],
      "args": [
        {
          "name": "tarball|folder",
          "description": "A url or file path to a gzipped tar archive containing a single folder with a package.json file inside | A folder containing a package.json file",
          "isOptional": true
        }
      ]
    },
    {
      "name": "rebuild",
      "aliases": [
        "rb"
      ],
      "description": "Rebuild a package",
      "options": [
        {
          "names": [
            "-g",
            "--global"
          ],
          "description": "Operates in 'global' mode, so that packages are installed into the prefix folder instead of the current working directory"
        },
        {
          "names": [
            "-w",
            "--workspace"
          ],
          "description": "Enable running a command in the context of the configured workspaces of the current project",
          "args": {
            "name": "workspace",
            "isVariadic": true
          }
        },
        {
          "names": [
            "-ws",
            "--workspaces"
          ],
          "description": "Enable running a command in the context of all the configured workspaces"
        },
        {
          "names": [
            "--ignore-scripts"
          ],
          "description": "If true, npm does not run scripts specified in package.json files"
        },
        {
          "names": [
            "--no-bin-links"
          ],
          "description": "Tells npm to not create symlinks (or .cmd shims on Windows) for package executables"
        }
      ],
      "args": [
        {
          "name": "[<@scope>/]<pkg>[@<version>]"
        }
      ]
    },
    {
      "name": "repo",
      "description": "Open package repository page in the browser",
      "options": [
        {
          "names": [
            "-w",
            "--workspace"
          ],
          "description": "Enable running a command in the context of the configured workspaces of the current project",
          "args": {
            "name": "workspace",
            "isVariadic": true
          }
        },
        {
          "names": [
            "-ws",
            "--workspaces"
          ],
          "description": "Enable running a command in the context of all the configured workspaces"
        },
        {
          "names": [
            "--no-browser"
          ],
          "description": "Display in command line instead of browser"
        },
        {
          "names": [
            "--browser"
          ],
          "description": "The browser that is called by the npm repo command to open websites",
          "args": {
            "name": "browser"
          }
        }
      ],
      "args": [
        {
          "name": "package",
          "isVariadic": true,
          "isOptional": true
        }
      ]
    },
    {
      "name": "restart",
      "description": "Restart a package",
      "options": [
        {
          "names": [
            "--ignore-scripts"
          ],
          "description": "If true, npm does not run scripts specified in package.json files"
        },
        {
          "names": [
            "--script-shell"
          ],
          "description": "The shell to use for scripts run with the npm exec, npm run and npm init <pkg> commands",
          "args": {
            "name": "script-shell"
          }
        },
        {
          "names": [
            "--"
          ],
          "args": {
            "name": "arg",
            "description": "Arguments to be passed to the restart script"
          }
        }
      ]
    },
    {
      "name": "root",
      "description": "Display npm root",
      "options": [
        {
          "names": [
            "-g",
            "--global"
          ],
          "description": "Print the effective global node_modules folder to standard out"
        }
      ]
    },
    {
      "name": "search",
      "aliases": [
        "s",
        "se",
        "find"
      ],
      "description": "Search for packages",
      "options": [
        {
          "names": [
            "-l",
            "--long"
          ],
          "description": "Show extended information"
        },
        {
          "names": [
            "--json"
          ],
          "description": "Show output in json format"
        },
        {
          "names": [
            "--color"
          ],
          "description": "Show colors",
          "args": {
            "name": "always",
            "description": "Always show colors",
            "suggestions": [
              "always"
            ]
          }
        },
        {
          "names": [
            "--no-color"
          ],
          "description": "Do not show colors"
        },
        {
          "names": [
            "-p",
            "--parseable"
          ],
          "description": "Output parseable results from commands that write to standard output"
        },
        {
          "names": [
            "--no-description"
          ],
          "description": "Do not show descriptions"
        },
        {
          "names": [
            "--searchopts"
          ],
          "description": "Space-separated options that are always passed to search",
          "args": {
            "name": "searchopts"
          }
        },
        {
          "names": [
            "--searchexclude"
          ],
          "description": "Space-separated options that limit the results from search",
          "args": {
            "name": "searchexclude"
          }
        },
        {
          "names": [
            "--registry"
          ],
          "description": "The base URL of the npm registry",
          "args": {
            "name": "registry"
          }
        },
        {
          "names": [
            "--prefer-online"
          ],
          "description": "If true, staleness checks for cached data will be forced, making the CLI look for updates immediately even for fresh package data"
        },
        {
          "names": [
            "--prefer-offline"
          ],
          "description": "If true, staleness checks for cached data will be bypassed, but missing data will be requested from the server"
        },
        {
          "names": [
            "--offline"
          ],
          "description": "Force offline mode: no network requests will be done during install"
        }
      ],
      "args": [
        {
          "name": "search terms",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "set",
      "description": "Sets the config key to the value"
    },
    {
      "name": "set-script",
      "description": "Set tasks in the scripts section of package.json",
      "options": [
        {
          "names": [
            "-w",
            "--workspace"
          ],
          "description": "Enable running a command in the context of the configured workspaces of the current project",
          "args": {
            "name": "workspace",
            "isVariadic": true
          }
        },
        {
          "names": [
            "-ws",
            "--workspaces"
          ],
          "description": "Enable running a command in the context of all the configured workspaces"
        }
      ],
      "args": [
        {
          "name": "script",
          "description": "Name of the task to be added to the scripts section of package.json"
        },
        {
          "name": "command",
          "description": "Command to run when script is called"
        }
      ]
    },
    {
      "name": "shrinkwrap",
      "description": "Lock down dependency versions for publication"
    },
    {
      "name": "star",
      "description": "Mark your favorite packages",
      "options": [
        {
          "names": [
            "--registry"
          ],
          "description": "The base URL of the npm registry",
          "args": {
            "name": "registry"
          }
        },
        {
          "names": [
            "--no-unicode"
          ],
          "description": "Do not use unicode characters in the tree output"
        }
      ],
      "args": [
        {
          "name": "pkg",
          "description": "Package to mark as favorite"
        }
      ]
    },
    {
      "name": "stars",
      "description": "View packages marked as favorites",
      "options": [
        {
          "names": [
            "--registry"
          ],
          "description": "The base URL of the npm registry",
          "args": {
            "name": "registry"
          }
        }
      ],
      "args": [
        {
          "name": "user",
          "description": "View packages marked as favorites by <user>",
          "isOptional": true
        }
      ]
    },
    {
      "name": "start",
      "description": "Start a package",
      "options": [
        {
          "names": [
            "--ignore-scripts"
          ],
          "description": "If true, npm does not run scripts specified in package.json files"
        },
        {
          "names": [
            "--script-shell"
          ],
          "description": "The shell to use for scripts run with the npm exec, npm run and npm init <pkg> commands",
          "args": {
            "name": "script-shell"
          }
        },
        {
          "names": [
            "--"
          ],
          "args": {
            "name": "arg",
            "description": "Arguments to be passed to the start script"
          }
        }
      ]
    },
    {
      "name": "stop",
      "description": "Stop a package",
      "options": [
        {
          "names": [
            "--ignore-scripts"
          ],
          "description": "If true, npm does not run scripts specified in package.json files"
        },
        {
          "names": [
            "--script-shell"
          ],
          "description": "The shell to use for scripts run with the npm exec, npm run and npm init <pkg> commands",
          "args": {
            "name": "script-shell"
          }
        },
        {
          "names": [
            "--"
          ],
          "args": {
            "name": "arg",
            "description": "Arguments to be passed to the stop script"
          }
        }
      ]
    },
    {
      "name": "team",
      "description": "Manage organization teams and team memberships",
      "subcommands": [
        {
          "name": "create",
          "options": [
            {
              "names": [
                "--registry"
              ],
              "description": "The base URL of the npm registry",
              "args": {
                "name": "registry"
              }
            },
            {
              "names": [
                "--otp"
              ],
              "description": "One-time password from a two-factor authenticator",
              "args": {
                "name": "otp"
              }
            }
          ],
          "args": [
            {
              "name": "scope:team"
            }
          ]
        },
        {
          "name": "destroy",
          "options": [
            {
              "names": [
                "--registry"
              ],
              "description": "The base URL of the npm registry",
              "args": {
                "name": "registry"
              }
            },
            {
              "names": [
                "--otp"
              ],
              "description": "One-time password from a two-factor authenticator",
              "args": {
                "name": "otp"
              }
            }
          ],
          "args": [
            {
              "name": "scope:team"
            }
          ]
        },
        {
          "name": "add",
          "options": [
            {
              "names": [
                "--registry"
              ],
              "description": "The base URL of the npm registry",
              "args": {
                "name": "registry"
              }
            },
            {
              "names": [
                "--otp"
              ],
              "description": "One-time password from a two-factor authenticator",
              "args": {
                "name": "otp"
              }
            }
          ],
          "args": [
            {
              "name": "scope:team"
            },
            {
              "name": "user"
            }
          ]
        },
        {
          "name": "rm",
          "options": [
            {
              "names": [
                "--registry"
              ],
              "description": "The base URL of the npm registry",
              "args": {
                "name": "registry"
              }
            },
            {
              "names": [
                "--otp"
              ],
              "description": "One-time password from a two-factor authenticator",
              "args": {
                "name": "otp"
              }
            }
          ],
          "args": [
            {
              "name": "scope:team"
            },
            {
              "name": "user"
            }
          ]
        },
        {
          "name": "ls",
          "options": [
            {
              "names": [
                "--registry"
              ],
              "description": "The base URL of the npm registry",
              "args": {
                "name": "registry"
              }
            },
            {
              "names": [
                "--json"
              ],
              "description": "Show output in json format"
            },
            {
              "names": [
                "-p",
                "--parseable"
              ],
              "description": "Output parseable results from commands that write to standard output"
            }
          ],
          "args": [
            {
              "name": "scope|scope:team"
            }
          ]
        }
      ]
    },
    {
      "name": "test",
      "aliases": [
        "tst",
        "t"
      ],
      "description": "Test a package",
      "options": [
        {
          "names": [
            "--ignore-scripts"
          ],
          "description": "If true, npm does not run scripts specified in package.json files"
        },
        {
          "names": [
            "--script-shell"
          ],
          "description": "The shell to use for scripts run with the npm exec, npm run and npm init <pkg> commands",
          "args": {
            "name": "script-shell"
          }
        }
      ]
    },
    {
      "name": "token",
      "description": "Manage your authentication tokens",
      "subcommands": [
        {
          "name": "list",
          "description": "Shows a table of all active authentication tokens",
          "options": [
            {
              "names": [
                "--json"
              ],
              "description": "Show output in json format"
            },
            {
              "names": [
                "-p",
                "--parseable"
              ],
              "description": "Output parseable results from commands that write to standard output"
            }
          ]
        },
        {
          "name": "create",
          "description": "Create a new authentication token",
          "options": [
            {
              "names": [
                "--read-only"
              ],
              "description": "This is used to mark a token as unable to publish when configuring limited access tokens with the npm token create command"
            },
            {
              "names": [
                "--cidr"
              ],
              "description": "This is a list of CIDR address to be used when configuring limited access tokens with the npm token create command",
              "args": {
                "name": "cidr"
              },
              "isRepeatable": true
            }
          ]
        },
        {
          "name": "revoke",
          "description": "Immediately removes an authentication token from the registry. You will no longer be able to use it",
          "args": [
            {
              "name": "idtoken"
            }
          ]
        }
      ],
      "options": [
        {
          "names": [
            "--registry"
          ],
          "description": "The base URL of the npm registry",
          "args": {
            "name": "registry"
          }
        },
        {
          "names": [
            "--otp"
          ],
          "description": "One-time password from a two-factor authenticator",
          "args": {
            "name": "otp"
          }
        }
      ]
    },
    {
      "name": "uninstall",
      "description": "Uninstall a package",
      "options": [
        {
          "names": [
            "-S",
            "--save"
          ],
          "description": "Package will be removed from your dependencies"
        },
        {
          "names": [
            "-D",
            "--save-dev"
          ],
          "description": "Package will appear in your `devDependencies`"
        },
        {
          "names": [
            "-O",
            "--save-optional"
          ],
          "description": "Package will appear in your `optionalDependencies`"
        },
        {
          "names": [
            "--no-save"
          ],
          "description": "Prevents saving to `dependencies`"
        },
        {
          "names": [
            "-g"
          ],
          "description": "Uninstall global package"
        },
        {
          "names": [
            "-w",
            "--workspace"
          ],
          "description": "Enable running a command in the context of the configured workspaces of the current project",
          "args": {
            "name": "workspace",
            "isVariadic": true
          }
        },
        {
          "names": [
            "-ws",
            "--workspaces"
          ],
          "description": "Enable running a command in the context of all the configured workspaces"
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
      "name": "r",
      "aliases": [
        "rm"
      ],
      "description": "Uninstall a package",
      "options": [
        {
          "names": [
            "-S",
            "--save"
          ],
          "description": "Package will be removed from your dependencies"
        },
        {
          "names": [
            "-D",
            "--save-dev"
          ],
          "description": "Package will appear in your `devDependencies`"
        },
        {
          "names": [
            "-O",
            "--save-optional"
          ],
          "description": "Package will appear in your `optionalDependencies`"
        },
        {
          "names": [
            "--no-save"
          ],
          "description": "Prevents saving to `dependencies`"
        },
        {
          "names": [
            "-g"
          ],
          "description": "Uninstall global package"
        },
        {
          "names": [
            "-w",
            "--workspace"
          ],
          "description": "Enable running a command in the context of the configured workspaces of the current project",
          "args": {
            "name": "workspace",
            "isVariadic": true
          }
        },
        {
          "names": [
            "-ws",
            "--workspaces"
          ],
          "description": "Enable running a command in the context of all the configured workspaces"
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
      "name": "un",
      "description": "Uninstall a package",
      "options": [
        {
          "names": [
            "-S",
            "--save"
          ],
          "description": "Package will be removed from your dependencies"
        },
        {
          "names": [
            "-D",
            "--save-dev"
          ],
          "description": "Package will appear in your `devDependencies`"
        },
        {
          "names": [
            "-O",
            "--save-optional"
          ],
          "description": "Package will appear in your `optionalDependencies`"
        },
        {
          "names": [
            "--no-save"
          ],
          "description": "Prevents saving to `dependencies`"
        },
        {
          "names": [
            "-g"
          ],
          "description": "Uninstall global package"
        },
        {
          "names": [
            "-w",
            "--workspace"
          ],
          "description": "Enable running a command in the context of the configured workspaces of the current project",
          "args": {
            "name": "workspace",
            "isVariadic": true
          }
        },
        {
          "names": [
            "-ws",
            "--workspaces"
          ],
          "description": "Enable running a command in the context of all the configured workspaces"
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
      "name": "remove",
      "description": "Uninstall a package",
      "options": [
        {
          "names": [
            "-S",
            "--save"
          ],
          "description": "Package will be removed from your dependencies"
        },
        {
          "names": [
            "-D",
            "--save-dev"
          ],
          "description": "Package will appear in your `devDependencies`"
        },
        {
          "names": [
            "-O",
            "--save-optional"
          ],
          "description": "Package will appear in your `optionalDependencies`"
        },
        {
          "names": [
            "--no-save"
          ],
          "description": "Prevents saving to `dependencies`"
        },
        {
          "names": [
            "-g"
          ],
          "description": "Uninstall global package"
        },
        {
          "names": [
            "-w",
            "--workspace"
          ],
          "description": "Enable running a command in the context of the configured workspaces of the current project",
          "args": {
            "name": "workspace",
            "isVariadic": true
          }
        },
        {
          "names": [
            "-ws",
            "--workspaces"
          ],
          "description": "Enable running a command in the context of all the configured workspaces"
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
      "name": "unlink",
      "description": "Uninstall a package",
      "options": [
        {
          "names": [
            "-S",
            "--save"
          ],
          "description": "Package will be removed from your dependencies"
        },
        {
          "names": [
            "-D",
            "--save-dev"
          ],
          "description": "Package will appear in your `devDependencies`"
        },
        {
          "names": [
            "-O",
            "--save-optional"
          ],
          "description": "Package will appear in your `optionalDependencies`"
        },
        {
          "names": [
            "--no-save"
          ],
          "description": "Prevents saving to `dependencies`"
        },
        {
          "names": [
            "-g"
          ],
          "description": "Uninstall global package"
        },
        {
          "names": [
            "-w",
            "--workspace"
          ],
          "description": "Enable running a command in the context of the configured workspaces of the current project",
          "args": {
            "name": "workspace",
            "isVariadic": true
          }
        },
        {
          "names": [
            "-ws",
            "--workspaces"
          ],
          "description": "Enable running a command in the context of all the configured workspaces"
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
      "name": "unpublish",
      "description": "Remove a package from the registry",
      "options": [
        {
          "names": [
            "--dry-run"
          ],
          "description": "Indicates that you don't want npm to make any changes and that it should only report what it would have done"
        },
        {
          "names": [
            "-f",
            "--force"
          ],
          "description": "Allow unpublishing all versions of a published package. Removes various protections against unfortunate side effects, common mistakes, unnecessary performance degradation, and malicious input"
        },
        {
          "names": [
            "-w",
            "--workspace"
          ],
          "description": "Enable running a command in the context of the configured workspaces of the current project",
          "args": {
            "name": "workspace",
            "isVariadic": true
          }
        },
        {
          "names": [
            "-ws",
            "--workspaces"
          ],
          "description": "Enable running a command in the context of all the configured workspaces"
        }
      ],
      "args": [
        {
          "name": "[<@scope>/]<pkg>[@<version>]"
        }
      ]
    },
    {
      "name": "unstar",
      "description": "Remove an item from your favorite packages",
      "options": [
        {
          "names": [
            "--registry"
          ],
          "description": "The base URL of the npm registry",
          "args": {
            "name": "registry"
          }
        },
        {
          "names": [
            "--otp"
          ],
          "description": "One-time password from a two-factor authenticator",
          "args": {
            "name": "otp"
          }
        },
        {
          "names": [
            "--no-unicode"
          ],
          "description": "Do not use unicode characters in the tree output"
        }
      ],
      "args": [
        {
          "name": "pkg",
          "description": "Package to unmark as favorite"
        }
      ]
    },
    {
      "name": "update",
      "aliases": [
        "upgrade",
        "up"
      ],
      "description": "Update a package",
      "options": [
        {
          "names": [
            "-g"
          ],
          "description": "Update global package"
        },
        {
          "names": [
            "--global-style"
          ],
          "description": "Causes npm to install the package into your local node_modules folder with the same layout it uses with the global node_modules folder"
        },
        {
          "names": [
            "--legacy-bundling"
          ],
          "description": "Causes npm to install the package such that versions of npm prior to 1.4, such as the one included with node 0.8, can install the package"
        },
        {
          "names": [
            "--strict-peer-deps"
          ],
          "description": "If set to true, and --legacy-peer-deps is not set, then any conflicting peerDependencies will be treated as an install failure"
        },
        {
          "names": [
            "--no-package-lock"
          ],
          "description": "Ignores package-lock.json files when installing"
        },
        {
          "names": [
            "--omit"
          ],
          "description": "Dependency types to omit from the installation tree on disk",
          "args": {
            "name": "Package type",
            "suggestions": [
              "dev",
              "optional",
              "peer"
            ]
          }
        },
        {
          "names": [
            "--ignore-scripts"
          ],
          "description": "If true, npm does not run scripts specified in package.json files"
        },
        {
          "names": [
            "--no-audit"
          ],
          "description": "Submit audit reports alongside the current npm command to the default registry and all registries configured for scopes"
        },
        {
          "names": [
            "--no-bin-links"
          ],
          "description": "Tells npm to not create symlinks (or .cmd shims on Windows) for package executables"
        },
        {
          "names": [
            "--no-fund"
          ],
          "description": "Hides the message at the end of each npm install acknowledging the number of dependencies looking for funding"
        },
        {
          "names": [
            "--save"
          ],
          "description": "Update the semver values of direct dependencies in your project package.json"
        },
        {
          "names": [
            "--dry-run"
          ],
          "description": "Indicates that you don't want npm to make any changes and that it should only report what it would have done"
        },
        {
          "names": [
            "-w",
            "--workspace"
          ],
          "description": "Enable running a command in the context of the configured workspaces of the current project",
          "args": {
            "name": "workspace",
            "isVariadic": true
          }
        },
        {
          "names": [
            "-ws",
            "--workspaces"
          ],
          "description": "Enable running a command in the context of all the configured workspaces"
        }
      ]
    },
    {
      "name": "version",
      "description": "Bump a package version",
      "options": [
        {
          "names": [
            "-w",
            "--workspace"
          ],
          "description": "Enable running a command in the context of the configured workspaces of the current project",
          "args": {
            "name": "workspace",
            "isVariadic": true
          }
        },
        {
          "names": [
            "-ws",
            "--workspaces"
          ],
          "description": "Enable running a command in the context of all the configured workspaces"
        },
        {
          "names": [
            "--json"
          ],
          "description": "Show output in json format"
        },
        {
          "names": [
            "--allow-same-version"
          ],
          "description": "Prevents throwing an error when npm version is used to set the new version to the same value as the current version"
        },
        {
          "names": [
            "--no-commit-hooks"
          ],
          "description": "Do not run git commit hooks when using the npm version command"
        },
        {
          "names": [
            "--no-git-tag-version"
          ],
          "description": "Do not tag the commit when using the npm version command"
        },
        {
          "names": [
            "--preid"
          ],
          "description": "The \"prerelease identifier\" to use as a prefix for the \"prerelease\" part of a semver. Like the rc in 1.2.0-rc.8",
          "args": {
            "name": "prerelease-id"
          }
        },
        {
          "names": [
            "--sign-git-tag"
          ],
          "description": "If set to true, then the npm version command will tag the version using -s to add a signature"
        }
      ]
    },
    {
      "name": "view",
      "aliases": [
        "v",
        "info",
        "show"
      ],
      "description": "View registry info",
      "options": [
        {
          "names": [
            "-w",
            "--workspace"
          ],
          "description": "Enable running a command in the context of the configured workspaces of the current project",
          "args": {
            "name": "workspace",
            "isVariadic": true
          }
        },
        {
          "names": [
            "-ws",
            "--workspaces"
          ],
          "description": "Enable running a command in the context of all the configured workspaces"
        },
        {
          "names": [
            "--json"
          ],
          "description": "Show output in json format"
        }
      ]
    },
    {
      "name": "whoami",
      "description": "Display npm username",
      "options": [
        {
          "names": [
            "--registry"
          ],
          "description": "The base URL of the npm registry",
          "args": {
            "name": "registry"
          }
        }
      ]
    }
  ]
};
