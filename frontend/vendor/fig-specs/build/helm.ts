// 由 scripts/sync_fig_specs.mjs 生成（withfig/autocomplete @ aef52acff84c45edde61ae610cc2c964802b9a38）——纯数据，勿手改。
// 归一化形态见 src/lib/completion/fig/types.ts；重生成：pnpm fig:sync
import type { FigSpecRoot } from "../../../src/lib/completion/fig/types";

export const spec: FigSpecRoot = {
  "name": "helm",
  "description": "The Helm package manager for Kubernetes",
  "subcommands": [
    {
      "name": "completion",
      "description": "Generate autocompletion scripts for the specified shell",
      "subcommands": [
        {
          "name": "bash",
          "description": "Generate autocompletion script for bash",
          "options": [
            {
              "names": [
                "--no-descriptions"
              ],
              "description": "Disable completion descriptions"
            }
          ]
        },
        {
          "name": "fish",
          "description": "Generate autocompletion script for fish",
          "options": [
            {
              "names": [
                "--no-descriptions"
              ],
              "description": "Disable completion descriptions"
            }
          ]
        },
        {
          "name": "powershell",
          "description": "Generate autocompletion script for powershell",
          "options": [
            {
              "names": [
                "--no-descriptions"
              ],
              "description": "Disable completion descriptions"
            }
          ]
        },
        {
          "name": "zsh",
          "description": "Generate autocompletion script for zsh",
          "options": [
            {
              "names": [
                "--no-descriptions"
              ],
              "description": "Disable completion descriptions"
            }
          ]
        }
      ]
    },
    {
      "name": "create",
      "description": "Create a new chart with the given name",
      "options": [
        {
          "names": [
            "--starter",
            "-p"
          ],
          "description": "The name or absolute path to Helm starter scaffold",
          "args": {
            "name": "starter"
          }
        }
      ]
    },
    {
      "name": "dep",
      "aliases": [
        "dependencies",
        "dependency"
      ],
      "description": "Manage a chart's dependencies",
      "subcommands": [
        {
          "name": "build",
          "description": "Rebuild the charts/ directory based on the Chart.lock file",
          "options": [
            {
              "names": [
                "--keyring"
              ],
              "description": "Keyring containing public keys",
              "args": {
                "name": "keyring"
              }
            },
            {
              "names": [
                "--skip-refresh"
              ],
              "description": "Do not refresh the local repository cache"
            },
            {
              "names": [
                "--verify"
              ],
              "description": "Verify the packages against signatures"
            }
          ]
        },
        {
          "name": "ls",
          "aliases": [
            "list"
          ],
          "description": "List the dependencies for the given chart",
          "options": [
            {
              "names": [
                "--max-col-width"
              ],
              "description": "Maximum column width for output table",
              "args": {
                "name": "max-col-width"
              }
            }
          ]
        },
        {
          "name": "up",
          "aliases": [
            "update"
          ],
          "description": "Update charts/ based on the contents of Chart.yaml",
          "options": [
            {
              "names": [
                "--keyring"
              ],
              "description": "Keyring containing public keys",
              "args": {
                "name": "keyring"
              }
            },
            {
              "names": [
                "--skip-refresh"
              ],
              "description": "Do not refresh the local repository cache"
            },
            {
              "names": [
                "--verify"
              ],
              "description": "Verify the packages against signatures"
            }
          ]
        }
      ]
    },
    {
      "name": "env",
      "description": "Helm client environment information"
    },
    {
      "name": "get",
      "description": "Download extended information of a named release",
      "subcommands": [
        {
          "name": "all",
          "description": "Download all information for a named release",
          "options": [
            {
              "names": [
                "--revision"
              ],
              "description": "Get the named release with revision",
              "args": {
                "name": "revision"
              }
            },
            {
              "names": [
                "--template"
              ],
              "description": "Go template for formatting the output, eg: {{.Release.Name}}",
              "args": {
                "name": "template"
              }
            }
          ]
        },
        {
          "name": "hooks",
          "description": "Download all hooks for a named release",
          "options": [
            {
              "names": [
                "--revision"
              ],
              "description": "Get the named release with revision",
              "args": {
                "name": "revision"
              }
            }
          ]
        },
        {
          "name": "manifest",
          "description": "Download the manifest for a named release",
          "options": [
            {
              "names": [
                "--revision"
              ],
              "description": "Get the named release with revision",
              "args": {
                "name": "revision"
              }
            }
          ]
        },
        {
          "name": "notes",
          "description": "Download the notes for a named release",
          "options": [
            {
              "names": [
                "--revision"
              ],
              "description": "Get the named release with revision",
              "args": {
                "name": "revision"
              }
            }
          ]
        },
        {
          "name": "values",
          "description": "Download the values file for a named release",
          "options": [
            {
              "names": [
                "--all",
                "-a"
              ],
              "description": "Dump all (computed) values"
            },
            {
              "names": [
                "--output",
                "-o"
              ],
              "description": "Prints the output in the specified format. Allowed values: table, json, yaml",
              "args": {
                "name": "output"
              }
            },
            {
              "names": [
                "--revision"
              ],
              "description": "Get the named release with revision",
              "args": {
                "name": "revision"
              }
            }
          ]
        }
      ]
    },
    {
      "name": "hist",
      "aliases": [
        "history"
      ],
      "description": "Fetch release history",
      "options": [
        {
          "names": [
            "--max"
          ],
          "description": "Maximum number of revision to include in history",
          "args": {
            "name": "max"
          }
        },
        {
          "names": [
            "--output",
            "-o"
          ],
          "description": "Prints the output in the specified format. Allowed values: table, json, yaml",
          "args": {
            "name": "output"
          }
        }
      ]
    },
    {
      "name": "install",
      "description": "Install a chart",
      "options": [
        {
          "names": [
            "--atomic"
          ],
          "description": "If set, the installation process deletes the installation on failure. The --wait flag will be set automatically if --atomic is used"
        },
        {
          "names": [
            "--ca-file"
          ],
          "description": "Verify certificates of HTTPS-enabled servers using this CA bundle",
          "args": {
            "name": "ca-file"
          }
        },
        {
          "names": [
            "--cert-file"
          ],
          "description": "Identify HTTPS client using this SSL certificate file",
          "args": {
            "name": "cert-file"
          }
        },
        {
          "names": [
            "--create-namespace"
          ],
          "description": "Create the release namespace if not present"
        },
        {
          "names": [
            "--dependency-update"
          ],
          "description": "Update dependencies if they are missing before installing the chart"
        },
        {
          "names": [
            "--description"
          ],
          "description": "Add a custom description",
          "args": {
            "name": "description"
          }
        },
        {
          "names": [
            "--devel"
          ],
          "description": "Use development versions, too. Equivalent to version '>0.0.0-0'. If --version is set, this is ignored"
        },
        {
          "names": [
            "--disable-openapi-validation"
          ],
          "description": "If set, the installation process will not validate rendered templates against the Kubernetes OpenAPI Schema"
        },
        {
          "names": [
            "--dry-run"
          ],
          "description": "Simulate an install"
        },
        {
          "names": [
            "--generate-name",
            "-g"
          ],
          "description": "Generate the name (and omit the NAME parameter)"
        },
        {
          "names": [
            "--insecure-skip-tls-verify"
          ],
          "description": "Skip tls certificate checks for the chart download"
        },
        {
          "names": [
            "--key-file"
          ],
          "description": "Identify HTTPS client using this SSL key file",
          "args": {
            "name": "key-file"
          }
        },
        {
          "names": [
            "--keyring"
          ],
          "description": "Location of public keys used for verification",
          "args": {
            "name": "keyring"
          }
        },
        {
          "names": [
            "--name-template"
          ],
          "description": "Specify template used to name the release",
          "args": {
            "name": "name-template"
          }
        },
        {
          "names": [
            "--no-hooks"
          ],
          "description": "Prevent hooks from running during install"
        },
        {
          "names": [
            "--output",
            "-o"
          ],
          "description": "Prints the output in the specified format. Allowed values: table, json, yaml",
          "args": {
            "name": "output"
          }
        },
        {
          "names": [
            "--pass-credentials"
          ],
          "description": "Pass credentials to all domains"
        },
        {
          "names": [
            "--password"
          ],
          "description": "Chart repository password where to locate the requested chart",
          "args": {
            "name": "password"
          }
        },
        {
          "names": [
            "--post-renderer"
          ],
          "description": "The path to an executable to be used for post rendering. If it exists in $PATH, the binary will be used, otherwise it will try to look for the executable at the given path",
          "args": {
            "name": "post-renderer"
          }
        },
        {
          "names": [
            "--post-renderer-args"
          ],
          "description": "An argument to the post-renderer (can specify multiple)",
          "args": {
            "name": "post-renderer-args"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--render-subchart-notes"
          ],
          "description": "If set, render subchart notes along with the parent"
        },
        {
          "names": [
            "--replace"
          ],
          "description": "Re-use the given name, only if that name is a deleted release which remains in the history. This is unsafe in production"
        },
        {
          "names": [
            "--repo"
          ],
          "description": "Chart repository url where to locate the requested chart",
          "args": {
            "name": "repo"
          }
        },
        {
          "names": [
            "--set"
          ],
          "description": "Set values on the command line (can specify multiple or separate values with commas: key1=val1,key2=val2)",
          "args": {
            "name": "set"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--set-file"
          ],
          "description": "Set values from respective files specified via the command line (can specify multiple or separate values with commas: key1=path1,key2=path2)",
          "args": {
            "name": "set-file"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--set-string"
          ],
          "description": "Set STRING values on the command line (can specify multiple or separate values with commas: key1=val1,key2=val2)",
          "args": {
            "name": "set-string"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--skip-crds"
          ],
          "description": "If set, no CRDs will be installed. By default, CRDs are installed if not already present"
        },
        {
          "names": [
            "--timeout"
          ],
          "description": "Time to wait for any individual Kubernetes operation (like Jobs for hooks)",
          "args": {
            "name": "timeout"
          }
        },
        {
          "names": [
            "--username"
          ],
          "description": "Chart repository username where to locate the requested chart",
          "args": {
            "name": "username"
          }
        },
        {
          "names": [
            "--values",
            "-f"
          ],
          "description": "Specify values in a YAML file or a URL (can specify multiple)",
          "args": {
            "name": "values"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--verify"
          ],
          "description": "Verify the package before using it"
        },
        {
          "names": [
            "--version"
          ],
          "description": "Specify a version constraint for the chart version to use. This constraint can be a specific tag (e.g. 1.1.1) or it may reference a valid range (e.g. ^2.0.0). If this is not specified, the latest version is used",
          "args": {
            "name": "version"
          }
        },
        {
          "names": [
            "--wait"
          ],
          "description": "If set, will wait until all Pods, PVCs, Services, and minimum number of Pods of a Deployment, StatefulSet, or ReplicaSet are in a ready state before marking the release as successful. It will wait for as long as --timeout"
        },
        {
          "names": [
            "--wait-for-jobs"
          ],
          "description": "If set and --wait enabled, will wait until all Jobs have been completed before marking the release as successful. It will wait for as long as --timeout"
        }
      ]
    },
    {
      "name": "lint",
      "description": "Examine a chart for possible issues",
      "options": [
        {
          "names": [
            "--quiet"
          ],
          "description": "Print only warnings and errors"
        },
        {
          "names": [
            "--set"
          ],
          "description": "Set values on the command line (can specify multiple or separate values with commas: key1=val1,key2=val2)",
          "args": {
            "name": "set"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--set-file"
          ],
          "description": "Set values from respective files specified via the command line (can specify multiple or separate values with commas: key1=path1,key2=path2)",
          "args": {
            "name": "set-file"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--set-string"
          ],
          "description": "Set STRING values on the command line (can specify multiple or separate values with commas: key1=val1,key2=val2)",
          "args": {
            "name": "set-string"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--strict"
          ],
          "description": "Fail on lint warnings"
        },
        {
          "names": [
            "--values",
            "-f"
          ],
          "description": "Specify values in a YAML file or a URL (can specify multiple)",
          "args": {
            "name": "values"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--with-subcharts"
          ],
          "description": "Lint dependent charts"
        }
      ]
    },
    {
      "name": "ls",
      "aliases": [
        "list"
      ],
      "description": "List releases",
      "options": [
        {
          "names": [
            "--all",
            "-a"
          ],
          "description": "Show all releases without any filter applied"
        },
        {
          "names": [
            "--all-namespaces",
            "-A"
          ],
          "description": "List releases across all namespaces"
        },
        {
          "names": [
            "--date",
            "-d"
          ],
          "description": "Sort by release date"
        },
        {
          "names": [
            "--deployed"
          ],
          "description": "Show deployed releases. If no other is specified, this will be automatically enabled"
        },
        {
          "names": [
            "--failed"
          ],
          "description": "Show failed releases"
        },
        {
          "names": [
            "--filter",
            "-f"
          ],
          "description": "A regular expression (Perl compatible). Any releases that match the expression will be included in the results",
          "args": {
            "name": "filter"
          }
        },
        {
          "names": [
            "--max",
            "-m"
          ],
          "description": "Maximum number of releases to fetch",
          "args": {
            "name": "max"
          }
        },
        {
          "names": [
            "--no-headers"
          ],
          "description": "Don't print headers when using the default output format"
        },
        {
          "names": [
            "--offset"
          ],
          "description": "Next release index in the list, used to offset from start value",
          "args": {
            "name": "offset"
          }
        },
        {
          "names": [
            "--output",
            "-o"
          ],
          "description": "Prints the output in the specified format. Allowed values: table, json, yaml",
          "args": {
            "name": "output"
          }
        },
        {
          "names": [
            "--pending"
          ],
          "description": "Show pending releases"
        },
        {
          "names": [
            "--reverse",
            "-r"
          ],
          "description": "Reverse the sort order"
        },
        {
          "names": [
            "--selector",
            "-l"
          ],
          "description": "Selector (label query) to filter on, supports '=', '==', and '!='.(e.g. -l key1=value1,key2=value2). Works only for secret(default) and configmap storage backends",
          "args": {
            "name": "selector"
          }
        },
        {
          "names": [
            "--short",
            "-q"
          ],
          "description": "Output short (quiet) listing format"
        },
        {
          "names": [
            "--superseded"
          ],
          "description": "Show superseded releases"
        },
        {
          "names": [
            "--time-format"
          ],
          "description": "Format time using golang time formatter. Example: --time-format \"2006-01-02 15:04:05Z0700\"",
          "args": {
            "name": "time-format"
          }
        },
        {
          "names": [
            "--uninstalled"
          ],
          "description": "Show uninstalled releases (if 'helm uninstall --keep-history' was used)"
        },
        {
          "names": [
            "--uninstalling"
          ],
          "description": "Show releases that are currently being uninstalled"
        }
      ]
    },
    {
      "name": "package",
      "description": "Package a chart directory into a chart archive",
      "options": [
        {
          "names": [
            "--app-version"
          ],
          "description": "Set the appVersion on the chart to this version",
          "args": {
            "name": "app-version"
          }
        },
        {
          "names": [
            "--dependency-update",
            "-u"
          ],
          "description": "Update dependencies from \"Chart.yaml\" to dir \"charts/\" before packaging"
        },
        {
          "names": [
            "--destination",
            "-d"
          ],
          "description": "Location to write the chart",
          "args": {
            "name": "destination"
          }
        },
        {
          "names": [
            "--key"
          ],
          "description": "Name of the key to use when signing. Used if --sign is true",
          "args": {
            "name": "key"
          }
        },
        {
          "names": [
            "--keyring"
          ],
          "description": "Location of a public keyring",
          "args": {
            "name": "keyring"
          }
        },
        {
          "names": [
            "--passphrase-file"
          ],
          "description": "Location of a file which contains the passphrase for the signing key. Use \"-\" in order to read from stdin",
          "args": {
            "name": "passphrase-file"
          }
        },
        {
          "names": [
            "--sign"
          ],
          "description": "Use a PGP private key to sign this package"
        },
        {
          "names": [
            "--version"
          ],
          "description": "Set the version on the chart to this semver version",
          "args": {
            "name": "version"
          }
        }
      ]
    },
    {
      "name": "plugin",
      "description": "Install, list, or uninstall Helm plugins",
      "subcommands": [
        {
          "name": "add",
          "aliases": [
            "install"
          ],
          "description": "Install one or more Helm plugins",
          "options": [
            {
              "names": [
                "--version"
              ],
              "description": "Specify a version constraint. If this is not specified, the latest version is installed",
              "args": {
                "name": "version"
              }
            }
          ]
        },
        {
          "name": "ls",
          "aliases": [
            "list"
          ],
          "description": "List installed Helm plugins"
        },
        {
          "name": "rm",
          "aliases": [
            "remove",
            "uninstall"
          ],
          "description": "Uninstall one or more Helm plugins"
        },
        {
          "name": "up",
          "aliases": [
            "update"
          ],
          "description": "Update one or more Helm plugins"
        }
      ]
    },
    {
      "name": "fetch",
      "aliases": [
        "pull"
      ],
      "description": "Download a chart from a repository and (optionally) unpack it in local directory",
      "options": [
        {
          "names": [
            "--ca-file"
          ],
          "description": "Verify certificates of HTTPS-enabled servers using this CA bundle",
          "args": {
            "name": "ca-file"
          }
        },
        {
          "names": [
            "--cert-file"
          ],
          "description": "Identify HTTPS client using this SSL certificate file",
          "args": {
            "name": "cert-file"
          }
        },
        {
          "names": [
            "--destination",
            "-d"
          ],
          "description": "Location to write the chart. If this and untardir are specified, untardir is appended to this",
          "args": {
            "name": "destination"
          }
        },
        {
          "names": [
            "--devel"
          ],
          "description": "Use development versions, too. Equivalent to version '>0.0.0-0'. If --version is set, this is ignored"
        },
        {
          "names": [
            "--insecure-skip-tls-verify"
          ],
          "description": "Skip tls certificate checks for the chart download"
        },
        {
          "names": [
            "--key-file"
          ],
          "description": "Identify HTTPS client using this SSL key file",
          "args": {
            "name": "key-file"
          }
        },
        {
          "names": [
            "--keyring"
          ],
          "description": "Location of public keys used for verification",
          "args": {
            "name": "keyring"
          }
        },
        {
          "names": [
            "--pass-credentials"
          ],
          "description": "Pass credentials to all domains"
        },
        {
          "names": [
            "--password"
          ],
          "description": "Chart repository password where to locate the requested chart",
          "args": {
            "name": "password"
          }
        },
        {
          "names": [
            "--prov"
          ],
          "description": "Fetch the provenance file, but don't perform verification"
        },
        {
          "names": [
            "--repo"
          ],
          "description": "Chart repository url where to locate the requested chart",
          "args": {
            "name": "repo"
          }
        },
        {
          "names": [
            "--untar"
          ],
          "description": "If set to true, will untar the chart after downloading it"
        },
        {
          "names": [
            "--untardir"
          ],
          "description": "If untar is specified, this flag specifies the name of the directory into which the chart is expanded",
          "args": {
            "name": "untardir"
          }
        },
        {
          "names": [
            "--username"
          ],
          "description": "Chart repository username where to locate the requested chart",
          "args": {
            "name": "username"
          }
        },
        {
          "names": [
            "--verify"
          ],
          "description": "Verify the package before using it"
        },
        {
          "names": [
            "--version"
          ],
          "description": "Specify a version constraint for the chart version to use. This constraint can be a specific tag (e.g. 1.1.1) or it may reference a valid range (e.g. ^2.0.0). If this is not specified, the latest version is used",
          "args": {
            "name": "version"
          }
        }
      ]
    },
    {
      "name": "push",
      "description": "Push a chart to remote"
    },
    {
      "name": "registry",
      "description": "Login to or logout from a registry",
      "subcommands": [
        {
          "name": "login",
          "description": "Login to a registry",
          "options": [
            {
              "names": [
                "--insecure"
              ],
              "description": "Allow connections to TLS registry without certs"
            },
            {
              "names": [
                "--password",
                "-p"
              ],
              "description": "Registry password or identity token",
              "args": {
                "name": "password"
              }
            },
            {
              "names": [
                "--password-stdin"
              ],
              "description": "Read password or identity token from stdin"
            },
            {
              "names": [
                "--username",
                "-u"
              ],
              "description": "Registry username",
              "args": {
                "name": "username"
              }
            }
          ]
        },
        {
          "name": "logout",
          "description": "Logout from a registry"
        }
      ]
    },
    {
      "name": "repo",
      "description": "Add, list, remove, update, and index chart repositories",
      "subcommands": [
        {
          "name": "add",
          "description": "Add a chart repository",
          "options": [
            {
              "names": [
                "--allow-deprecated-repos"
              ],
              "description": "By default, this command will not allow adding official repos that have been permanently deleted. This disables that behavior"
            },
            {
              "names": [
                "--ca-file"
              ],
              "description": "Verify certificates of HTTPS-enabled servers using this CA bundle",
              "args": {
                "name": "ca-file"
              }
            },
            {
              "names": [
                "--cert-file"
              ],
              "description": "Identify HTTPS client using this SSL certificate file",
              "args": {
                "name": "cert-file"
              }
            },
            {
              "names": [
                "--force-update"
              ],
              "description": "Replace (overwrite) the repo if it already exists"
            },
            {
              "names": [
                "--insecure-skip-tls-verify"
              ],
              "description": "Skip tls certificate checks for the repository"
            },
            {
              "names": [
                "--key-file"
              ],
              "description": "Identify HTTPS client using this SSL key file",
              "args": {
                "name": "key-file"
              }
            },
            {
              "names": [
                "--no-update"
              ],
              "description": "Ignored. Formerly, it would disabled forced updates. It is deprecated by force-update"
            },
            {
              "names": [
                "--pass-credentials"
              ],
              "description": "Pass credentials to all domains"
            },
            {
              "names": [
                "--password"
              ],
              "description": "Chart repository password",
              "args": {
                "name": "password"
              }
            },
            {
              "names": [
                "--password-stdin"
              ],
              "description": "Read chart repository password from stdin"
            },
            {
              "names": [
                "--username"
              ],
              "description": "Chart repository username",
              "args": {
                "name": "username"
              }
            }
          ]
        },
        {
          "name": "index",
          "description": "Generate an index file given a directory containing packaged charts",
          "options": [
            {
              "names": [
                "--merge"
              ],
              "description": "Merge the generated index into the given index",
              "args": {
                "name": "merge"
              }
            },
            {
              "names": [
                "--url"
              ],
              "description": "Url of chart repository",
              "args": {
                "name": "url"
              }
            }
          ]
        },
        {
          "name": "ls",
          "aliases": [
            "list"
          ],
          "description": "List chart repositories",
          "options": [
            {
              "names": [
                "--output",
                "-o"
              ],
              "description": "Prints the output in the specified format. Allowed values: table, json, yaml",
              "args": {
                "name": "output"
              }
            }
          ]
        },
        {
          "name": "rm",
          "aliases": [
            "remove"
          ],
          "description": "Remove one or more chart repositories"
        },
        {
          "name": "up",
          "aliases": [
            "update"
          ],
          "description": "Update information of available charts locally from chart repositories",
          "options": [
            {
              "names": [
                "--fail-on-repo-update-fail"
              ],
              "description": "Update fails if any of the repository updates fail"
            }
          ]
        }
      ]
    },
    {
      "name": "rollback",
      "description": "Roll back a release to a previous revision",
      "options": [
        {
          "names": [
            "--cleanup-on-fail"
          ],
          "description": "Allow deletion of new resources created in this rollback when rollback fails"
        },
        {
          "names": [
            "--dry-run"
          ],
          "description": "Simulate a rollback"
        },
        {
          "names": [
            "--force"
          ],
          "description": "Force resource update through delete/recreate if needed"
        },
        {
          "names": [
            "--history-max"
          ],
          "description": "Limit the maximum number of revisions saved per release. Use 0 for no limit",
          "args": {
            "name": "history-max"
          }
        },
        {
          "names": [
            "--no-hooks"
          ],
          "description": "Prevent hooks from running during rollback"
        },
        {
          "names": [
            "--recreate-pods"
          ],
          "description": "Performs pods restart for the resource if applicable"
        },
        {
          "names": [
            "--timeout"
          ],
          "description": "Time to wait for any individual Kubernetes operation (like Jobs for hooks)",
          "args": {
            "name": "timeout"
          }
        },
        {
          "names": [
            "--wait"
          ],
          "description": "If set, will wait until all Pods, PVCs, Services, and minimum number of Pods of a Deployment, StatefulSet, or ReplicaSet are in a ready state before marking the release as successful. It will wait for as long as --timeout"
        },
        {
          "names": [
            "--wait-for-jobs"
          ],
          "description": "If set and --wait enabled, will wait until all Jobs have been completed before marking the release as successful. It will wait for as long as --timeout"
        }
      ]
    },
    {
      "name": "s3",
      "description": "Manage chart repositories on Amazon S3"
    },
    {
      "name": "search",
      "description": "Search for a keyword in charts",
      "subcommands": [
        {
          "name": "hub",
          "description": "Search for charts in the Artifact Hub or your own hub instance",
          "options": [
            {
              "names": [
                "--endpoint"
              ],
              "description": "Hub instance to query for charts",
              "args": {
                "name": "endpoint"
              }
            },
            {
              "names": [
                "--list-repo-url"
              ],
              "description": "Print charts repository URL"
            },
            {
              "names": [
                "--max-col-width"
              ],
              "description": "Maximum column width for output table",
              "args": {
                "name": "max-col-width"
              }
            },
            {
              "names": [
                "--output",
                "-o"
              ],
              "description": "Prints the output in the specified format. Allowed values: table, json, yaml",
              "args": {
                "name": "output"
              }
            }
          ]
        },
        {
          "name": "repo",
          "description": "Search repositories for a keyword in charts",
          "options": [
            {
              "names": [
                "--devel"
              ],
              "description": "Use development versions (alpha, beta, and release candidate releases), too. Equivalent to version '>0.0.0-0'. If --version is set, this is ignored"
            },
            {
              "names": [
                "--max-col-width"
              ],
              "description": "Maximum column width for output table",
              "args": {
                "name": "max-col-width"
              }
            },
            {
              "names": [
                "--output",
                "-o"
              ],
              "description": "Prints the output in the specified format. Allowed values: table, json, yaml",
              "args": {
                "name": "output"
              }
            },
            {
              "names": [
                "--regexp",
                "-r"
              ],
              "description": "Use regular expressions for searching repositories you have added"
            },
            {
              "names": [
                "--version"
              ],
              "description": "Search using semantic versioning constraints on repositories you have added",
              "args": {
                "name": "version"
              }
            },
            {
              "names": [
                "--versions",
                "-l"
              ],
              "description": "Show the long listing, with each version of each chart on its own line, for repositories you have added"
            }
          ]
        }
      ]
    },
    {
      "name": "inspect",
      "aliases": [
        "show"
      ],
      "description": "Show information of a chart",
      "subcommands": [
        {
          "name": "all",
          "description": "Show all information of the chart",
          "options": [
            {
              "names": [
                "--ca-file"
              ],
              "description": "Verify certificates of HTTPS-enabled servers using this CA bundle",
              "args": {
                "name": "ca-file"
              }
            },
            {
              "names": [
                "--cert-file"
              ],
              "description": "Identify HTTPS client using this SSL certificate file",
              "args": {
                "name": "cert-file"
              }
            },
            {
              "names": [
                "--devel"
              ],
              "description": "Use development versions, too. Equivalent to version '>0.0.0-0'. If --version is set, this is ignored"
            },
            {
              "names": [
                "--insecure-skip-tls-verify"
              ],
              "description": "Skip tls certificate checks for the chart download"
            },
            {
              "names": [
                "--key-file"
              ],
              "description": "Identify HTTPS client using this SSL key file",
              "args": {
                "name": "key-file"
              }
            },
            {
              "names": [
                "--keyring"
              ],
              "description": "Location of public keys used for verification",
              "args": {
                "name": "keyring"
              }
            },
            {
              "names": [
                "--pass-credentials"
              ],
              "description": "Pass credentials to all domains"
            },
            {
              "names": [
                "--password"
              ],
              "description": "Chart repository password where to locate the requested chart",
              "args": {
                "name": "password"
              }
            },
            {
              "names": [
                "--repo"
              ],
              "description": "Chart repository url where to locate the requested chart",
              "args": {
                "name": "repo"
              }
            },
            {
              "names": [
                "--username"
              ],
              "description": "Chart repository username where to locate the requested chart",
              "args": {
                "name": "username"
              }
            },
            {
              "names": [
                "--verify"
              ],
              "description": "Verify the package before using it"
            },
            {
              "names": [
                "--version"
              ],
              "description": "Specify a version constraint for the chart version to use. This constraint can be a specific tag (e.g. 1.1.1) or it may reference a valid range (e.g. ^2.0.0). If this is not specified, the latest version is used",
              "args": {
                "name": "version"
              }
            }
          ]
        },
        {
          "name": "chart",
          "description": "Show the chart's definition",
          "options": [
            {
              "names": [
                "--ca-file"
              ],
              "description": "Verify certificates of HTTPS-enabled servers using this CA bundle",
              "args": {
                "name": "ca-file"
              }
            },
            {
              "names": [
                "--cert-file"
              ],
              "description": "Identify HTTPS client using this SSL certificate file",
              "args": {
                "name": "cert-file"
              }
            },
            {
              "names": [
                "--devel"
              ],
              "description": "Use development versions, too. Equivalent to version '>0.0.0-0'. If --version is set, this is ignored"
            },
            {
              "names": [
                "--insecure-skip-tls-verify"
              ],
              "description": "Skip tls certificate checks for the chart download"
            },
            {
              "names": [
                "--key-file"
              ],
              "description": "Identify HTTPS client using this SSL key file",
              "args": {
                "name": "key-file"
              }
            },
            {
              "names": [
                "--keyring"
              ],
              "description": "Location of public keys used for verification",
              "args": {
                "name": "keyring"
              }
            },
            {
              "names": [
                "--pass-credentials"
              ],
              "description": "Pass credentials to all domains"
            },
            {
              "names": [
                "--password"
              ],
              "description": "Chart repository password where to locate the requested chart",
              "args": {
                "name": "password"
              }
            },
            {
              "names": [
                "--repo"
              ],
              "description": "Chart repository url where to locate the requested chart",
              "args": {
                "name": "repo"
              }
            },
            {
              "names": [
                "--username"
              ],
              "description": "Chart repository username where to locate the requested chart",
              "args": {
                "name": "username"
              }
            },
            {
              "names": [
                "--verify"
              ],
              "description": "Verify the package before using it"
            },
            {
              "names": [
                "--version"
              ],
              "description": "Specify a version constraint for the chart version to use. This constraint can be a specific tag (e.g. 1.1.1) or it may reference a valid range (e.g. ^2.0.0). If this is not specified, the latest version is used",
              "args": {
                "name": "version"
              }
            }
          ]
        },
        {
          "name": "crds",
          "description": "Show the chart's CRDs",
          "options": [
            {
              "names": [
                "--ca-file"
              ],
              "description": "Verify certificates of HTTPS-enabled servers using this CA bundle",
              "args": {
                "name": "ca-file"
              }
            },
            {
              "names": [
                "--cert-file"
              ],
              "description": "Identify HTTPS client using this SSL certificate file",
              "args": {
                "name": "cert-file"
              }
            },
            {
              "names": [
                "--devel"
              ],
              "description": "Use development versions, too. Equivalent to version '>0.0.0-0'. If --version is set, this is ignored"
            },
            {
              "names": [
                "--insecure-skip-tls-verify"
              ],
              "description": "Skip tls certificate checks for the chart download"
            },
            {
              "names": [
                "--key-file"
              ],
              "description": "Identify HTTPS client using this SSL key file",
              "args": {
                "name": "key-file"
              }
            },
            {
              "names": [
                "--keyring"
              ],
              "description": "Location of public keys used for verification",
              "args": {
                "name": "keyring"
              }
            },
            {
              "names": [
                "--pass-credentials"
              ],
              "description": "Pass credentials to all domains"
            },
            {
              "names": [
                "--password"
              ],
              "description": "Chart repository password where to locate the requested chart",
              "args": {
                "name": "password"
              }
            },
            {
              "names": [
                "--repo"
              ],
              "description": "Chart repository url where to locate the requested chart",
              "args": {
                "name": "repo"
              }
            },
            {
              "names": [
                "--username"
              ],
              "description": "Chart repository username where to locate the requested chart",
              "args": {
                "name": "username"
              }
            },
            {
              "names": [
                "--verify"
              ],
              "description": "Verify the package before using it"
            },
            {
              "names": [
                "--version"
              ],
              "description": "Specify a version constraint for the chart version to use. This constraint can be a specific tag (e.g. 1.1.1) or it may reference a valid range (e.g. ^2.0.0). If this is not specified, the latest version is used",
              "args": {
                "name": "version"
              }
            }
          ]
        },
        {
          "name": "readme",
          "description": "Show the chart's README",
          "options": [
            {
              "names": [
                "--ca-file"
              ],
              "description": "Verify certificates of HTTPS-enabled servers using this CA bundle",
              "args": {
                "name": "ca-file"
              }
            },
            {
              "names": [
                "--cert-file"
              ],
              "description": "Identify HTTPS client using this SSL certificate file",
              "args": {
                "name": "cert-file"
              }
            },
            {
              "names": [
                "--devel"
              ],
              "description": "Use development versions, too. Equivalent to version '>0.0.0-0'. If --version is set, this is ignored"
            },
            {
              "names": [
                "--insecure-skip-tls-verify"
              ],
              "description": "Skip tls certificate checks for the chart download"
            },
            {
              "names": [
                "--key-file"
              ],
              "description": "Identify HTTPS client using this SSL key file",
              "args": {
                "name": "key-file"
              }
            },
            {
              "names": [
                "--keyring"
              ],
              "description": "Location of public keys used for verification",
              "args": {
                "name": "keyring"
              }
            },
            {
              "names": [
                "--pass-credentials"
              ],
              "description": "Pass credentials to all domains"
            },
            {
              "names": [
                "--password"
              ],
              "description": "Chart repository password where to locate the requested chart",
              "args": {
                "name": "password"
              }
            },
            {
              "names": [
                "--repo"
              ],
              "description": "Chart repository url where to locate the requested chart",
              "args": {
                "name": "repo"
              }
            },
            {
              "names": [
                "--username"
              ],
              "description": "Chart repository username where to locate the requested chart",
              "args": {
                "name": "username"
              }
            },
            {
              "names": [
                "--verify"
              ],
              "description": "Verify the package before using it"
            },
            {
              "names": [
                "--version"
              ],
              "description": "Specify a version constraint for the chart version to use. This constraint can be a specific tag (e.g. 1.1.1) or it may reference a valid range (e.g. ^2.0.0). If this is not specified, the latest version is used",
              "args": {
                "name": "version"
              }
            }
          ]
        },
        {
          "name": "values",
          "description": "Show the chart's values",
          "options": [
            {
              "names": [
                "--ca-file"
              ],
              "description": "Verify certificates of HTTPS-enabled servers using this CA bundle",
              "args": {
                "name": "ca-file"
              }
            },
            {
              "names": [
                "--cert-file"
              ],
              "description": "Identify HTTPS client using this SSL certificate file",
              "args": {
                "name": "cert-file"
              }
            },
            {
              "names": [
                "--devel"
              ],
              "description": "Use development versions, too. Equivalent to version '>0.0.0-0'. If --version is set, this is ignored"
            },
            {
              "names": [
                "--insecure-skip-tls-verify"
              ],
              "description": "Skip tls certificate checks for the chart download"
            },
            {
              "names": [
                "--jsonpath"
              ],
              "description": "Supply a JSONPath expression to filter the output",
              "args": {
                "name": "jsonpath"
              }
            },
            {
              "names": [
                "--key-file"
              ],
              "description": "Identify HTTPS client using this SSL key file",
              "args": {
                "name": "key-file"
              }
            },
            {
              "names": [
                "--keyring"
              ],
              "description": "Location of public keys used for verification",
              "args": {
                "name": "keyring"
              }
            },
            {
              "names": [
                "--pass-credentials"
              ],
              "description": "Pass credentials to all domains"
            },
            {
              "names": [
                "--password"
              ],
              "description": "Chart repository password where to locate the requested chart",
              "args": {
                "name": "password"
              }
            },
            {
              "names": [
                "--repo"
              ],
              "description": "Chart repository url where to locate the requested chart",
              "args": {
                "name": "repo"
              }
            },
            {
              "names": [
                "--username"
              ],
              "description": "Chart repository username where to locate the requested chart",
              "args": {
                "name": "username"
              }
            },
            {
              "names": [
                "--verify"
              ],
              "description": "Verify the package before using it"
            },
            {
              "names": [
                "--version"
              ],
              "description": "Specify a version constraint for the chart version to use. This constraint can be a specific tag (e.g. 1.1.1) or it may reference a valid range (e.g. ^2.0.0). If this is not specified, the latest version is used",
              "args": {
                "name": "version"
              }
            }
          ]
        }
      ]
    },
    {
      "name": "status",
      "description": "Display the status of the named release",
      "options": [
        {
          "names": [
            "--output",
            "-o"
          ],
          "description": "Prints the output in the specified format. Allowed values: table, json, yaml",
          "args": {
            "name": "output"
          }
        },
        {
          "names": [
            "--revision"
          ],
          "description": "If set, display the status of the named release with revision",
          "args": {
            "name": "revision"
          }
        },
        {
          "names": [
            "--show-desc"
          ],
          "description": "If set, display the description message of the named release"
        }
      ]
    },
    {
      "name": "template",
      "description": "Locally render templates",
      "options": [
        {
          "names": [
            "--api-versions",
            "-a"
          ],
          "description": "Kubernetes api versions used for Capabilities.APIVersions",
          "args": {
            "name": "api-versions"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--atomic"
          ],
          "description": "If set, the installation process deletes the installation on failure. The --wait flag will be set automatically if --atomic is used"
        },
        {
          "names": [
            "--ca-file"
          ],
          "description": "Verify certificates of HTTPS-enabled servers using this CA bundle",
          "args": {
            "name": "ca-file"
          }
        },
        {
          "names": [
            "--cert-file"
          ],
          "description": "Identify HTTPS client using this SSL certificate file",
          "args": {
            "name": "cert-file"
          }
        },
        {
          "names": [
            "--create-namespace"
          ],
          "description": "Create the release namespace if not present"
        },
        {
          "names": [
            "--dependency-update"
          ],
          "description": "Update dependencies if they are missing before installing the chart"
        },
        {
          "names": [
            "--description"
          ],
          "description": "Add a custom description",
          "args": {
            "name": "description"
          }
        },
        {
          "names": [
            "--devel"
          ],
          "description": "Use development versions, too. Equivalent to version '>0.0.0-0'. If --version is set, this is ignored"
        },
        {
          "names": [
            "--disable-openapi-validation"
          ],
          "description": "If set, the installation process will not validate rendered templates against the Kubernetes OpenAPI Schema"
        },
        {
          "names": [
            "--dry-run"
          ],
          "description": "Simulate an install"
        },
        {
          "names": [
            "--generate-name",
            "-g"
          ],
          "description": "Generate the name (and omit the NAME parameter)"
        },
        {
          "names": [
            "--include-crds"
          ],
          "description": "Include CRDs in the templated output"
        },
        {
          "names": [
            "--insecure-skip-tls-verify"
          ],
          "description": "Skip tls certificate checks for the chart download"
        },
        {
          "names": [
            "--is-upgrade"
          ],
          "description": "Set .Release.IsUpgrade instead of .Release.IsInstall"
        },
        {
          "names": [
            "--key-file"
          ],
          "description": "Identify HTTPS client using this SSL key file",
          "args": {
            "name": "key-file"
          }
        },
        {
          "names": [
            "--keyring"
          ],
          "description": "Location of public keys used for verification",
          "args": {
            "name": "keyring"
          }
        },
        {
          "names": [
            "--kube-version"
          ],
          "description": "Kubernetes version used for Capabilities.KubeVersion",
          "args": {
            "name": "kube-version"
          }
        },
        {
          "names": [
            "--name-template"
          ],
          "description": "Specify template used to name the release",
          "args": {
            "name": "name-template"
          }
        },
        {
          "names": [
            "--no-hooks"
          ],
          "description": "Prevent hooks from running during install"
        },
        {
          "names": [
            "--output-dir"
          ],
          "description": "Writes the executed templates to files in output-dir instead of stdout",
          "args": {
            "name": "output-dir"
          }
        },
        {
          "names": [
            "--pass-credentials"
          ],
          "description": "Pass credentials to all domains"
        },
        {
          "names": [
            "--password"
          ],
          "description": "Chart repository password where to locate the requested chart",
          "args": {
            "name": "password"
          }
        },
        {
          "names": [
            "--post-renderer"
          ],
          "description": "The path to an executable to be used for post rendering. If it exists in $PATH, the binary will be used, otherwise it will try to look for the executable at the given path",
          "args": {
            "name": "post-renderer"
          }
        },
        {
          "names": [
            "--post-renderer-args"
          ],
          "description": "An argument to the post-renderer (can specify multiple)",
          "args": {
            "name": "post-renderer-args"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--release-name"
          ],
          "description": "Use release name in the output-dir path"
        },
        {
          "names": [
            "--render-subchart-notes"
          ],
          "description": "If set, render subchart notes along with the parent"
        },
        {
          "names": [
            "--replace"
          ],
          "description": "Re-use the given name, only if that name is a deleted release which remains in the history. This is unsafe in production"
        },
        {
          "names": [
            "--repo"
          ],
          "description": "Chart repository url where to locate the requested chart",
          "args": {
            "name": "repo"
          }
        },
        {
          "names": [
            "--set"
          ],
          "description": "Set values on the command line (can specify multiple or separate values with commas: key1=val1,key2=val2)",
          "args": {
            "name": "set"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--set-file"
          ],
          "description": "Set values from respective files specified via the command line (can specify multiple or separate values with commas: key1=path1,key2=path2)",
          "args": {
            "name": "set-file"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--set-string"
          ],
          "description": "Set STRING values on the command line (can specify multiple or separate values with commas: key1=val1,key2=val2)",
          "args": {
            "name": "set-string"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--show-only",
            "-s"
          ],
          "description": "Only show manifests rendered from the given templates",
          "args": {
            "name": "show-only"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--skip-crds"
          ],
          "description": "If set, no CRDs will be installed. By default, CRDs are installed if not already present"
        },
        {
          "names": [
            "--skip-tests"
          ],
          "description": "Skip tests from templated output"
        },
        {
          "names": [
            "--timeout"
          ],
          "description": "Time to wait for any individual Kubernetes operation (like Jobs for hooks)",
          "args": {
            "name": "timeout"
          }
        },
        {
          "names": [
            "--username"
          ],
          "description": "Chart repository username where to locate the requested chart",
          "args": {
            "name": "username"
          }
        },
        {
          "names": [
            "--validate"
          ],
          "description": "Validate your manifests against the Kubernetes cluster you are currently pointing at. This is the same validation performed on an install"
        },
        {
          "names": [
            "--values",
            "-f"
          ],
          "description": "Specify values in a YAML file or a URL (can specify multiple)",
          "args": {
            "name": "values"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--verify"
          ],
          "description": "Verify the package before using it"
        },
        {
          "names": [
            "--version"
          ],
          "description": "Specify a version constraint for the chart version to use. This constraint can be a specific tag (e.g. 1.1.1) or it may reference a valid range (e.g. ^2.0.0). If this is not specified, the latest version is used",
          "args": {
            "name": "version"
          }
        },
        {
          "names": [
            "--wait"
          ],
          "description": "If set, will wait until all Pods, PVCs, Services, and minimum number of Pods of a Deployment, StatefulSet, or ReplicaSet are in a ready state before marking the release as successful. It will wait for as long as --timeout"
        },
        {
          "names": [
            "--wait-for-jobs"
          ],
          "description": "If set and --wait enabled, will wait until all Jobs have been completed before marking the release as successful. It will wait for as long as --timeout"
        }
      ]
    },
    {
      "name": "test",
      "description": "Run tests for a release",
      "options": [
        {
          "names": [
            "--filter"
          ],
          "description": "Specify tests by attribute (currently \"name\") using attribute=value syntax or '!attribute=value' to exclude a test (can specify multiple or separate values with commas: name=test1,name=test2)",
          "args": {
            "name": "filter"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--logs"
          ],
          "description": "Dump the logs from test pods (this runs after all tests are complete, but before any cleanup)"
        },
        {
          "names": [
            "--timeout"
          ],
          "description": "Time to wait for any individual Kubernetes operation (like Jobs for hooks)",
          "args": {
            "name": "timeout"
          }
        }
      ]
    },
    {
      "name": "del",
      "aliases": [
        "delete",
        "un",
        "uninstall"
      ],
      "description": "Uninstall a release",
      "options": [
        {
          "names": [
            "--description"
          ],
          "description": "Add a custom description",
          "args": {
            "name": "description"
          }
        },
        {
          "names": [
            "--dry-run"
          ],
          "description": "Simulate a uninstall"
        },
        {
          "names": [
            "--keep-history"
          ],
          "description": "Remove all associated resources and mark the release as deleted, but retain the release history"
        },
        {
          "names": [
            "--no-hooks"
          ],
          "description": "Prevent hooks from running during uninstallation"
        },
        {
          "names": [
            "--timeout"
          ],
          "description": "Time to wait for any individual Kubernetes operation (like Jobs for hooks)",
          "args": {
            "name": "timeout"
          }
        },
        {
          "names": [
            "--wait"
          ],
          "description": "If set, will wait until all the resources are deleted before returning. It will wait for as long as --timeout"
        }
      ]
    },
    {
      "name": "unittest",
      "description": "Unittest for helm charts"
    },
    {
      "name": "upgrade",
      "description": "Upgrade a release",
      "options": [
        {
          "names": [
            "--atomic"
          ],
          "description": "If set, upgrade process rolls back changes made in case of failed upgrade. The --wait flag will be set automatically if --atomic is used"
        },
        {
          "names": [
            "--ca-file"
          ],
          "description": "Verify certificates of HTTPS-enabled servers using this CA bundle",
          "args": {
            "name": "ca-file"
          }
        },
        {
          "names": [
            "--cert-file"
          ],
          "description": "Identify HTTPS client using this SSL certificate file",
          "args": {
            "name": "cert-file"
          }
        },
        {
          "names": [
            "--cleanup-on-fail"
          ],
          "description": "Allow deletion of new resources created in this upgrade when upgrade fails"
        },
        {
          "names": [
            "--create-namespace"
          ],
          "description": "If --install is set, create the release namespace if not present"
        },
        {
          "names": [
            "--dependency-update"
          ],
          "description": "Update dependencies if they are missing before installing the chart"
        },
        {
          "names": [
            "--description"
          ],
          "description": "Add a custom description",
          "args": {
            "name": "description"
          }
        },
        {
          "names": [
            "--devel"
          ],
          "description": "Use development versions, too. Equivalent to version '>0.0.0-0'. If --version is set, this is ignored"
        },
        {
          "names": [
            "--disable-openapi-validation"
          ],
          "description": "If set, the upgrade process will not validate rendered templates against the Kubernetes OpenAPI Schema"
        },
        {
          "names": [
            "--dry-run"
          ],
          "description": "Simulate an upgrade"
        },
        {
          "names": [
            "--force"
          ],
          "description": "Force resource updates through a replacement strategy"
        },
        {
          "names": [
            "--history-max"
          ],
          "description": "Limit the maximum number of revisions saved per release. Use 0 for no limit",
          "args": {
            "name": "history-max"
          }
        },
        {
          "names": [
            "--insecure-skip-tls-verify"
          ],
          "description": "Skip tls certificate checks for the chart download"
        },
        {
          "names": [
            "--install",
            "-i"
          ],
          "description": "If a release by this name doesn't already exist, run an install"
        },
        {
          "names": [
            "--key-file"
          ],
          "description": "Identify HTTPS client using this SSL key file",
          "args": {
            "name": "key-file"
          }
        },
        {
          "names": [
            "--keyring"
          ],
          "description": "Location of public keys used for verification",
          "args": {
            "name": "keyring"
          }
        },
        {
          "names": [
            "--no-hooks"
          ],
          "description": "Disable pre/post upgrade hooks"
        },
        {
          "names": [
            "--output",
            "-o"
          ],
          "description": "Prints the output in the specified format. Allowed values: table, json, yaml",
          "args": {
            "name": "output"
          }
        },
        {
          "names": [
            "--pass-credentials"
          ],
          "description": "Pass credentials to all domains"
        },
        {
          "names": [
            "--password"
          ],
          "description": "Chart repository password where to locate the requested chart",
          "args": {
            "name": "password"
          }
        },
        {
          "names": [
            "--post-renderer"
          ],
          "description": "The path to an executable to be used for post rendering. If it exists in $PATH, the binary will be used, otherwise it will try to look for the executable at the given path",
          "args": {
            "name": "post-renderer"
          }
        },
        {
          "names": [
            "--post-renderer-args"
          ],
          "description": "An argument to the post-renderer (can specify multiple)",
          "args": {
            "name": "post-renderer-args"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--recreate-pods"
          ],
          "description": "Performs pods restart for the resource if applicable"
        },
        {
          "names": [
            "--render-subchart-notes"
          ],
          "description": "If set, render subchart notes along with the parent"
        },
        {
          "names": [
            "--repo"
          ],
          "description": "Chart repository url where to locate the requested chart",
          "args": {
            "name": "repo"
          }
        },
        {
          "names": [
            "--reset-values"
          ],
          "description": "When upgrading, reset the values to the ones built into the chart"
        },
        {
          "names": [
            "--reuse-values"
          ],
          "description": "When upgrading, reuse the last release's values and merge in any overrides from the command line via --set and -f. If '--reset-values' is specified, this is ignored"
        },
        {
          "names": [
            "--set"
          ],
          "description": "Set values on the command line (can specify multiple or separate values with commas: key1=val1,key2=val2)",
          "args": {
            "name": "set"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--set-file"
          ],
          "description": "Set values from respective files specified via the command line (can specify multiple or separate values with commas: key1=path1,key2=path2)",
          "args": {
            "name": "set-file"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--set-string"
          ],
          "description": "Set STRING values on the command line (can specify multiple or separate values with commas: key1=val1,key2=val2)",
          "args": {
            "name": "set-string"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--skip-crds"
          ],
          "description": "If set, no CRDs will be installed when an upgrade is performed with install flag enabled. By default, CRDs are installed if not already present, when an upgrade is performed with install flag enabled"
        },
        {
          "names": [
            "--timeout"
          ],
          "description": "Time to wait for any individual Kubernetes operation (like Jobs for hooks)",
          "args": {
            "name": "timeout"
          }
        },
        {
          "names": [
            "--username"
          ],
          "description": "Chart repository username where to locate the requested chart",
          "args": {
            "name": "username"
          }
        },
        {
          "names": [
            "--values",
            "-f"
          ],
          "description": "Specify values in a YAML file or a URL (can specify multiple)",
          "args": {
            "name": "values"
          },
          "isRepeatable": true
        },
        {
          "names": [
            "--verify"
          ],
          "description": "Verify the package before using it"
        },
        {
          "names": [
            "--version"
          ],
          "description": "Specify a version constraint for the chart version to use. This constraint can be a specific tag (e.g. 1.1.1) or it may reference a valid range (e.g. ^2.0.0). If this is not specified, the latest version is used",
          "args": {
            "name": "version"
          }
        },
        {
          "names": [
            "--wait"
          ],
          "description": "If set, will wait until all Pods, PVCs, Services, and minimum number of Pods of a Deployment, StatefulSet, or ReplicaSet are in a ready state before marking the release as successful. It will wait for as long as --timeout"
        },
        {
          "names": [
            "--wait-for-jobs"
          ],
          "description": "If set and --wait enabled, will wait until all Jobs have been completed before marking the release as successful. It will wait for as long as --timeout"
        }
      ]
    },
    {
      "name": "verify",
      "description": "Verify that a chart at the given path has been signed and is valid",
      "options": [
        {
          "names": [
            "--keyring"
          ],
          "description": "Keyring containing public keys",
          "args": {
            "name": "keyring"
          }
        }
      ]
    },
    {
      "name": "version",
      "description": "Print the client version information",
      "options": [
        {
          "names": [
            "--client",
            "-c"
          ],
          "description": "Display client version information"
        },
        {
          "names": [
            "--short"
          ],
          "description": "Print the version number"
        },
        {
          "names": [
            "--template"
          ],
          "description": "Template for version string format",
          "args": {
            "name": "template"
          }
        }
      ]
    },
    {
      "name": "help",
      "description": "Help about any command",
      "subcommands": [
        {
          "name": "completion",
          "description": "Generate autocompletion scripts for the specified shell",
          "subcommands": [
            {
              "name": "bash",
              "description": "Generate autocompletion script for bash"
            },
            {
              "name": "fish",
              "description": "Generate autocompletion script for fish"
            },
            {
              "name": "powershell",
              "description": "Generate autocompletion script for powershell"
            },
            {
              "name": "zsh",
              "description": "Generate autocompletion script for zsh"
            }
          ]
        },
        {
          "name": "create",
          "description": "Create a new chart with the given name"
        },
        {
          "name": "dep",
          "aliases": [
            "dependencies",
            "dependency"
          ],
          "description": "Manage a chart's dependencies",
          "subcommands": [
            {
              "name": "build",
              "description": "Rebuild the charts/ directory based on the Chart.lock file"
            },
            {
              "name": "ls",
              "aliases": [
                "list"
              ],
              "description": "List the dependencies for the given chart"
            },
            {
              "name": "up",
              "aliases": [
                "update"
              ],
              "description": "Update charts/ based on the contents of Chart.yaml"
            }
          ]
        },
        {
          "name": "env",
          "description": "Helm client environment information"
        },
        {
          "name": "get",
          "description": "Download extended information of a named release",
          "subcommands": [
            {
              "name": "all",
              "description": "Download all information for a named release"
            },
            {
              "name": "hooks",
              "description": "Download all hooks for a named release"
            },
            {
              "name": "manifest",
              "description": "Download the manifest for a named release"
            },
            {
              "name": "notes",
              "description": "Download the notes for a named release"
            },
            {
              "name": "values",
              "description": "Download the values file for a named release"
            }
          ]
        },
        {
          "name": "hist",
          "aliases": [
            "history"
          ],
          "description": "Fetch release history"
        },
        {
          "name": "install",
          "description": "Install a chart"
        },
        {
          "name": "lint",
          "description": "Examine a chart for possible issues"
        },
        {
          "name": "ls",
          "aliases": [
            "list"
          ],
          "description": "List releases"
        },
        {
          "name": "package",
          "description": "Package a chart directory into a chart archive"
        },
        {
          "name": "plugin",
          "description": "Install, list, or uninstall Helm plugins",
          "subcommands": [
            {
              "name": "add",
              "aliases": [
                "install"
              ],
              "description": "Install one or more Helm plugins"
            },
            {
              "name": "ls",
              "aliases": [
                "list"
              ],
              "description": "List installed Helm plugins"
            },
            {
              "name": "rm",
              "aliases": [
                "remove",
                "uninstall"
              ],
              "description": "Uninstall one or more Helm plugins"
            },
            {
              "name": "up",
              "aliases": [
                "update"
              ],
              "description": "Update one or more Helm plugins"
            }
          ]
        },
        {
          "name": "fetch",
          "aliases": [
            "pull"
          ],
          "description": "Download a chart from a repository and (optionally) unpack it in local directory"
        },
        {
          "name": "push",
          "description": "Push a chart to remote"
        },
        {
          "name": "registry",
          "description": "Login to or logout from a registry",
          "subcommands": [
            {
              "name": "login",
              "description": "Login to a registry"
            },
            {
              "name": "logout",
              "description": "Logout from a registry"
            }
          ]
        },
        {
          "name": "repo",
          "description": "Add, list, remove, update, and index chart repositories",
          "subcommands": [
            {
              "name": "add",
              "description": "Add a chart repository"
            },
            {
              "name": "index",
              "description": "Generate an index file given a directory containing packaged charts"
            },
            {
              "name": "ls",
              "aliases": [
                "list"
              ],
              "description": "List chart repositories"
            },
            {
              "name": "rm",
              "aliases": [
                "remove"
              ],
              "description": "Remove one or more chart repositories"
            },
            {
              "name": "up",
              "aliases": [
                "update"
              ],
              "description": "Update information of available charts locally from chart repositories"
            }
          ]
        },
        {
          "name": "rollback",
          "description": "Roll back a release to a previous revision"
        },
        {
          "name": "s3",
          "description": "Manage chart repositories on Amazon S3"
        },
        {
          "name": "search",
          "description": "Search for a keyword in charts",
          "subcommands": [
            {
              "name": "hub",
              "description": "Search for charts in the Artifact Hub or your own hub instance"
            },
            {
              "name": "repo",
              "description": "Search repositories for a keyword in charts"
            }
          ]
        },
        {
          "name": "inspect",
          "aliases": [
            "show"
          ],
          "description": "Show information of a chart",
          "subcommands": [
            {
              "name": "all",
              "description": "Show all information of the chart"
            },
            {
              "name": "chart",
              "description": "Show the chart's definition"
            },
            {
              "name": "crds",
              "description": "Show the chart's CRDs"
            },
            {
              "name": "readme",
              "description": "Show the chart's README"
            },
            {
              "name": "values",
              "description": "Show the chart's values"
            }
          ]
        },
        {
          "name": "status",
          "description": "Display the status of the named release"
        },
        {
          "name": "template",
          "description": "Locally render templates"
        },
        {
          "name": "test",
          "description": "Run tests for a release"
        },
        {
          "name": "del",
          "aliases": [
            "delete",
            "un",
            "uninstall"
          ],
          "description": "Uninstall a release"
        },
        {
          "name": "unittest",
          "description": "Unittest for helm charts"
        },
        {
          "name": "upgrade",
          "description": "Upgrade a release"
        },
        {
          "name": "verify",
          "description": "Verify that a chart at the given path has been signed and is valid"
        },
        {
          "name": "version",
          "description": "Print the client version information"
        }
      ]
    }
  ],
  "options": [
    {
      "names": [
        "--add-dir-header"
      ],
      "description": "If true, adds the file directory to the header of the log messages",
      "isPersistent": true
    },
    {
      "names": [
        "--alsologtostderr"
      ],
      "description": "Log to standard error as well as files",
      "isPersistent": true
    },
    {
      "names": [
        "--burst-limit"
      ],
      "description": "Client-side default throttling limit",
      "args": {
        "name": "burst-limit"
      },
      "isPersistent": true
    },
    {
      "names": [
        "--debug"
      ],
      "description": "Enable verbose output",
      "isPersistent": true
    },
    {
      "names": [
        "--kube-apiserver"
      ],
      "description": "The address and the port for the Kubernetes API server",
      "args": {
        "name": "kube-apiserver"
      },
      "isPersistent": true
    },
    {
      "names": [
        "--kube-as-group"
      ],
      "description": "Group to impersonate for the operation, this flag can be repeated to specify multiple groups",
      "args": {
        "name": "kube-as-group"
      },
      "isRepeatable": true,
      "isPersistent": true
    },
    {
      "names": [
        "--kube-as-user"
      ],
      "description": "Username to impersonate for the operation",
      "args": {
        "name": "kube-as-user"
      },
      "isPersistent": true
    },
    {
      "names": [
        "--kube-ca-file"
      ],
      "description": "The certificate authority file for the Kubernetes API server connection",
      "args": {
        "name": "kube-ca-file"
      },
      "isPersistent": true
    },
    {
      "names": [
        "--kube-context"
      ],
      "description": "Name of the kubeconfig context to use",
      "args": {
        "name": "kube-context"
      },
      "isPersistent": true
    },
    {
      "names": [
        "--kube-insecure-skip-tls-verify"
      ],
      "description": "If true, the Kubernetes API server's certificate will not be checked for validity. This will make your HTTPS connections insecure",
      "isPersistent": true
    },
    {
      "names": [
        "--kube-tls-server-name"
      ],
      "description": "Server name to use for Kubernetes API server certificate validation. If it is not provided, the hostname used to contact the server is used",
      "args": {
        "name": "kube-tls-server-name"
      },
      "isPersistent": true
    },
    {
      "names": [
        "--kube-token"
      ],
      "description": "Bearer token used for authentication",
      "args": {
        "name": "kube-token"
      },
      "isPersistent": true
    },
    {
      "names": [
        "--kubeconfig"
      ],
      "description": "Path to the kubeconfig file",
      "args": {
        "name": "kubeconfig"
      },
      "isPersistent": true
    },
    {
      "names": [
        "--log-backtrace-at"
      ],
      "description": "When logging hits line file:N, emit a stack trace",
      "args": {
        "name": "log-backtrace-at"
      },
      "isPersistent": true
    },
    {
      "names": [
        "--log-dir"
      ],
      "description": "If non-empty, write log files in this directory",
      "args": {
        "name": "log-dir"
      },
      "isPersistent": true
    },
    {
      "names": [
        "--log-file"
      ],
      "description": "If non-empty, use this log file",
      "args": {
        "name": "log-file"
      },
      "isPersistent": true
    },
    {
      "names": [
        "--log-file-max-size"
      ],
      "description": "Defines the maximum size a log file can grow to. Unit is megabytes. If the value is 0, the maximum file size is unlimited",
      "args": {
        "name": "log-file-max-size"
      },
      "isPersistent": true
    },
    {
      "names": [
        "--logtostderr"
      ],
      "description": "Log to standard error instead of files",
      "isPersistent": true
    },
    {
      "names": [
        "--namespace",
        "-n"
      ],
      "description": "Namespace scope for this request",
      "args": {
        "name": "namespace"
      },
      "isPersistent": true
    },
    {
      "names": [
        "--one-output"
      ],
      "description": "If true, only write logs to their native severity level (vs also writing to each lower severity level)",
      "isPersistent": true
    },
    {
      "names": [
        "--registry-config"
      ],
      "description": "Path to the registry config file",
      "args": {
        "name": "registry-config"
      },
      "isPersistent": true
    },
    {
      "names": [
        "--repository-cache"
      ],
      "description": "Path to the file containing cached repository indexes",
      "args": {
        "name": "repository-cache"
      },
      "isPersistent": true
    },
    {
      "names": [
        "--repository-config"
      ],
      "description": "Path to the file containing repository names and URLs",
      "args": {
        "name": "repository-config"
      },
      "isPersistent": true
    },
    {
      "names": [
        "--skip-headers"
      ],
      "description": "If true, avoid header prefixes in the log messages",
      "isPersistent": true
    },
    {
      "names": [
        "--skip-log-headers"
      ],
      "description": "If true, avoid headers when opening log files",
      "isPersistent": true
    },
    {
      "names": [
        "--stderrthreshold"
      ],
      "description": "Logs at or above this threshold go to stderr",
      "args": {
        "name": "stderrthreshold"
      },
      "isPersistent": true
    },
    {
      "names": [
        "--v",
        "-v"
      ],
      "description": "Number for the log level verbosity",
      "args": {
        "name": "v"
      },
      "isPersistent": true
    },
    {
      "names": [
        "--vmodule"
      ],
      "description": "Comma-separated list of pattern=N settings for file-filtered logging",
      "args": {
        "name": "vmodule"
      },
      "isPersistent": true
    },
    {
      "names": [
        "--help",
        "-h"
      ],
      "description": "Display help",
      "isPersistent": true
    }
  ]
};
