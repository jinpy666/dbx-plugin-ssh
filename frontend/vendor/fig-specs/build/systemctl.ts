// 由 scripts/sync_fig_specs.mjs 生成（withfig/autocomplete @ aef52acff84c45edde61ae610cc2c964802b9a38）——纯数据，勿手改。
// 归一化形态见 src/lib/completion/fig/types.ts；重生成：pnpm fig:sync
import type { FigSpecRoot } from "../../../src/lib/completion/fig/types";

export const spec: FigSpecRoot = {
  "name": "systemctl",
  "subcommands": [
    {
      "name": "list-units",
      "description": "List units currently in memory",
      "args": [
        {
          "name": "PATTERN",
          "isVariadic": true,
          "isOptional": true
        }
      ]
    },
    {
      "name": "list-sockets",
      "description": "List socket units currently in memory ordered by address",
      "args": [
        {
          "name": "PATTERN",
          "isVariadic": true,
          "isOptional": true
        }
      ]
    },
    {
      "name": "list-timers",
      "description": "List timer units currently in memory ordered by next elapse",
      "args": [
        {
          "name": "PATTERN",
          "isVariadic": true,
          "isOptional": true
        }
      ]
    },
    {
      "name": "is-active",
      "description": "Check whether units are active",
      "args": [
        {
          "name": "PATTERN",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "is-failed",
      "description": "Check whether units are failed",
      "args": [
        {
          "name": "PATTERN",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "status",
      "description": "Show runtime status of one or more units",
      "args": [
        {
          "name": "PATTERN or PID",
          "isVariadic": true,
          "isOptional": true
        }
      ]
    },
    {
      "name": "show",
      "description": "Show properties of one or more",
      "args": [
        {
          "name": "PATTERN or JOB",
          "isVariadic": true,
          "isOptional": true
        }
      ]
    },
    {
      "name": "cat",
      "description": "Show files and drop-ins of specified units",
      "args": [
        {
          "name": "PATTERN",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "help",
      "description": "Show manual for one or more units",
      "args": [
        {
          "name": "PATTERN or PID",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "list-dependencies",
      "description": "Recursively show units which are required or wanted by the units or by which those",
      "args": [
        {
          "name": "PATTERN",
          "isVariadic": true,
          "isOptional": true
        }
      ]
    },
    {
      "name": "start",
      "description": "Start (activate) one or more units",
      "args": [
        {
          "name": "UNIT",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "stop",
      "description": "Stop (deactivate) one or more units",
      "args": [
        {
          "name": "UNIT",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "reload",
      "description": "Reload one or more units",
      "args": [
        {
          "name": "UNIT",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "restart",
      "description": "Start or restart one or more units",
      "args": [
        {
          "name": "UNIT",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "try-restart",
      "description": "Restart one or more units if active",
      "args": [
        {
          "name": "UNIT",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "reload-or-restart",
      "description": "Reload one or more units if possible, otherwise start or restart",
      "args": [
        {
          "name": "UNIT",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "try-reload-or-restart",
      "description": "If active, reload one or more units, if supported, otherwise restart",
      "args": [
        {
          "name": "UNIT",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "isolate",
      "description": "Start one unit and stop all others",
      "args": [
        {
          "name": "UNIT"
        }
      ]
    },
    {
      "name": "kill",
      "description": "Send signal to processes of a unit",
      "args": [
        {
          "name": "UNIT",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "clean",
      "description": "Clean runtime, cache, state, logs or configuration of unit",
      "args": [
        {
          "name": "UNIT",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "freeze",
      "description": "Freeze execution of unit processes",
      "args": [
        {
          "name": "PATTERN",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "thaw",
      "description": "Resume execution of a frozen unit",
      "args": [
        {
          "name": "PATTERN",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "set-property",
      "description": "Sets one or more properties of a unit",
      "args": [
        {
          "name": "UNIT"
        },
        {
          "name": "PROPERTY=VALUE"
        }
      ]
    },
    {
      "name": "bind",
      "description": "Bind-mount a path from the host into a unit's namespace",
      "args": [
        {
          "name": "UNIT"
        },
        {
          "name": "PATH"
        },
        {
          "name": "PATH",
          "isOptional": true
        }
      ]
    },
    {
      "name": "mount-image",
      "description": "Mount an image from the host into a unit's namespace",
      "args": [
        {
          "name": "UNIT"
        },
        {
          "name": "PATH"
        },
        {
          "name": "PATH",
          "isOptional": true
        },
        {
          "name": "OPTS",
          "isOptional": true
        }
      ]
    },
    {
      "name": "service-log-level",
      "description": "Get/set logging threshold for service",
      "args": [
        {
          "name": "SERVICE"
        },
        {
          "name": "LEVEL",
          "isOptional": true
        }
      ]
    },
    {
      "name": "service-log-target",
      "description": "Get/set logging target for service",
      "args": [
        {
          "name": "SERVICE"
        },
        {
          "name": "TARGET",
          "isOptional": true
        }
      ]
    },
    {
      "name": "reset-failed",
      "description": "Reset failed state for all, one, or more units",
      "args": [
        {
          "name": "PATTERN",
          "isVariadic": true,
          "isOptional": true
        }
      ]
    },
    {
      "name": "list-unit-files",
      "description": "List installed unit files",
      "args": [
        {
          "name": "PATTERN",
          "isVariadic": true,
          "isOptional": true
        }
      ]
    },
    {
      "name": "enable",
      "description": "Enable one or more unit files",
      "args": [
        {
          "name": "UNIT|PATH",
          "isVariadic": true,
          "isOptional": true
        }
      ]
    },
    {
      "name": "disable",
      "description": "Disable one or more unit files",
      "args": [
        {
          "name": "UNIT|PATH",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "reenable",
      "description": "Reenable one or more unit files",
      "args": [
        {
          "name": "UNIT",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "preset",
      "description": "Enable/disable one or more unit files based on preset configuration",
      "args": [
        {
          "name": "UNIT",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "preset-all",
      "description": "Enable/disable all unit files based on preset configuration",
      "args": [
        {
          "name": "UNIT",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "mask",
      "description": "Mask one or more unit files",
      "args": [
        {
          "name": "UNIT",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "unmask",
      "description": "Unmask one or more unit files",
      "args": [
        {
          "name": "UNIT",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "link",
      "description": "Link one or more units files into the search path",
      "args": [
        {
          "name": "PATH",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "revert",
      "description": "Revert one or more unit files to vendor version",
      "args": [
        {
          "name": "UNIT",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "add-wants",
      "description": "Add 'Wants' dependency for the target on specified one or more units",
      "args": [
        {
          "name": "TARGET"
        },
        {
          "name": "UNIT",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "add-requires",
      "description": "Add 'Requires' dependency for the target on specified one or more units",
      "args": [
        {
          "name": "TARGET"
        },
        {
          "name": "UNIT",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "edit",
      "description": "Edit one or more unit files",
      "args": [
        {
          "name": "UNIT",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "get-default",
      "description": "Get the name of the default target"
    },
    {
      "name": "set-default",
      "description": "Set the default target",
      "args": [
        {
          "name": "TARGET"
        }
      ]
    },
    {
      "name": "list-jobs",
      "description": "List jobs",
      "args": [
        {
          "name": "PATTERN",
          "isVariadic": true,
          "isOptional": true
        }
      ]
    },
    {
      "name": "cancel",
      "description": "Cancel all, one, or more jobs",
      "args": [
        {
          "name": "JOB",
          "isVariadic": true,
          "isOptional": true
        }
      ]
    },
    {
      "name": "show-environment",
      "description": "Dump environment"
    },
    {
      "name": "set-environment",
      "description": "Set one or more environment variables",
      "args": [
        {
          "name": "VARIABLE=VALUE",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "unset-environment",
      "description": "Unset one or more environment variables",
      "args": [
        {
          "name": "VARIABLE",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "import-environment",
      "description": "Import all or some environment variables",
      "args": [
        {
          "name": "VARIABLE",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "daemon-reload",
      "description": "Reload systemd manager configuration"
    },
    {
      "name": "daemon-reexec",
      "description": "Reexecute systemd manager"
    },
    {
      "name": "log-level",
      "description": "Get/set logging threshold for manager",
      "args": [
        {
          "name": "LEVEL",
          "isOptional": true
        }
      ]
    },
    {
      "name": "log-target",
      "description": "Get/set logging target for manager",
      "args": [
        {
          "name": "TARGET",
          "isOptional": true
        }
      ]
    },
    {
      "name": "service-watchdogs",
      "description": "Get/set service watchdog state",
      "args": [
        {
          "name": "BOOL",
          "isOptional": true,
          "suggestions": [
            "true",
            "false"
          ]
        }
      ]
    },
    {
      "name": "is-system-running",
      "description": "Check whether system is fully running"
    },
    {
      "name": "default",
      "description": "Enter system default mode"
    },
    {
      "name": "rescue",
      "description": "Enter system rescue mode"
    },
    {
      "name": "emergency",
      "description": "Enter system emergency mode"
    },
    {
      "name": "halt",
      "description": "Shut down and halt the system"
    },
    {
      "name": "poweroff",
      "description": "Shut down and power-off the system"
    },
    {
      "name": "reboot",
      "description": "Shut down and reboot the system"
    },
    {
      "name": "kexec",
      "description": "Shut down and reboot the system with kexec"
    },
    {
      "name": "exit",
      "description": "Request user instance or container exit",
      "args": [
        {
          "name": "EXIT_CODE",
          "isOptional": true
        }
      ]
    },
    {
      "name": "switch-root",
      "description": "Change to a different root file system",
      "args": [
        {
          "name": "ROOT"
        },
        {
          "name": "INIT"
        }
      ]
    },
    {
      "name": "suspend",
      "description": "Suspend the system"
    },
    {
      "name": "hibernate",
      "description": "Hibernate the system"
    },
    {
      "name": "hybrid-sleep",
      "description": "Hibernate and suspend the system"
    },
    {
      "name": "suspend-then-hibernate",
      "description": "Suspend the system, wake after a period of time, and hibernate"
    }
  ],
  "options": [
    {
      "names": [
        "-h",
        "--help"
      ],
      "description": "Show this help"
    },
    {
      "names": [
        "--version"
      ],
      "description": "Show package version"
    },
    {
      "names": [
        "--system"
      ],
      "description": "Connect to system manager"
    },
    {
      "names": [
        "--user"
      ],
      "description": "Connect to user service manager"
    },
    {
      "names": [
        "-H",
        "--host"
      ],
      "description": "Operate on remote host",
      "args": {
        "name": "[USER@]HOST"
      }
    },
    {
      "names": [
        "-M",
        "--machine"
      ],
      "description": "Operate on a local container",
      "args": {
        "name": "CONTAINER"
      }
    },
    {
      "names": [
        "-t",
        "--type"
      ],
      "description": "List units of a particular type",
      "args": {
        "name": "TYPE"
      }
    },
    {
      "names": [
        "--state"
      ],
      "description": "List units with particular LOAD or SUB or ACTIVE state",
      "args": {
        "name": "STATE"
      }
    },
    {
      "names": [
        "--failed"
      ],
      "description": "Shortcut for --state=failed"
    },
    {
      "names": [
        "-p",
        "--property"
      ],
      "description": "Show only properties by this name",
      "args": {
        "name": "NAME"
      }
    },
    {
      "names": [
        "-P"
      ],
      "description": "Equivalent to --value --property=NAME"
    },
    {
      "names": [
        "-a",
        "--all"
      ],
      "description": "Show all properties/all units currently in memory, including dead/empty ones. To list all units installed on the system, use 'list-unit-files' instead"
    },
    {
      "names": [
        "-l",
        "--full"
      ],
      "description": "Don't ellipsize unit names on output"
    },
    {
      "names": [
        "-r",
        "--recursive"
      ],
      "description": "Show unit list of host and local containers"
    },
    {
      "names": [
        "--reverse"
      ],
      "description": "Show reverse dependencies with 'list-dependencies'"
    },
    {
      "names": [
        "--with-dependencies"
      ],
      "description": "Show unit dependencies with 'status', 'cat', 'list-units', and 'list-unit-files'"
    },
    {
      "names": [
        "--job-mode"
      ],
      "description": "Specify how to deal with already queued jobs, when queueing a new job",
      "args": {
        "name": "MODE"
      }
    },
    {
      "names": [
        "-T",
        "--show-transaction"
      ],
      "description": "When enqueuing a unit job, show full transaction"
    },
    {
      "names": [
        "--show-types"
      ],
      "description": "When showing sockets, explicitly show their type"
    },
    {
      "names": [
        "--value"
      ],
      "description": "When showing properties, only print the value"
    },
    {
      "names": [
        "--check-inhibitors"
      ],
      "description": "Specify if checking inhibitors before shutting down sleeping or hibernating",
      "args": {
        "name": "MODE"
      }
    },
    {
      "names": [
        "-i"
      ],
      "description": "Shortcut for --check-inhibitors=no"
    },
    {
      "names": [
        "--kill-who"
      ],
      "description": "Whom to send signal to",
      "args": {
        "name": "WHO"
      }
    },
    {
      "names": [
        "-s",
        "--signal"
      ],
      "description": "Which signal to send",
      "args": {
        "name": "SIGNAL"
      }
    },
    {
      "names": [
        "--what"
      ],
      "description": "Which types of resources to remove",
      "args": {
        "name": "RESOURCES"
      }
    },
    {
      "names": [
        "--now"
      ],
      "description": "Start or stop unit after enabling or disabling it"
    },
    {
      "names": [
        "--dry-run"
      ],
      "description": "Only print what would be done"
    },
    {
      "names": [
        "-q",
        "--quiet"
      ],
      "description": "Supress output"
    },
    {
      "names": [
        "--wait"
      ],
      "description": "For (re)start, wait until service stopped again. For is-system-running, wait until startup is completed"
    },
    {
      "names": [
        "--no-block"
      ],
      "description": "Do not wait until operation finished"
    },
    {
      "names": [
        "--no-wall"
      ],
      "description": "Don't send wall message before halt/power-off/reboot"
    },
    {
      "names": [
        "--no-reload"
      ],
      "description": "Don't reload daemon after en-/dis-abling unit files"
    },
    {
      "names": [
        "--legend"
      ],
      "description": "Enable/disable the legend (column headers and hints)",
      "args": {
        "name": "BOOL",
        "suggestions": [
          "true",
          "false"
        ]
      }
    },
    {
      "names": [
        "--no-pager"
      ],
      "description": "Do not pipe output into a pager"
    },
    {
      "names": [
        "--no-ask-password"
      ],
      "description": "Do not ask for system passwords"
    },
    {
      "names": [
        "--global"
      ],
      "description": "Edit/enable/disable/mask default user unit files globally"
    },
    {
      "names": [
        "--runtime"
      ],
      "description": "Edit/enable/disable/mask unit files temporarily until next reboot"
    },
    {
      "names": [
        "-f",
        "--force"
      ],
      "description": "When enabling unit files, override existing symlinks. When shutting down, execute action immediately"
    },
    {
      "names": [
        "--preset-mode"
      ],
      "description": "Apply only enable, only disable, or all presets",
      "args": {
        "name": "MODE"
      }
    },
    {
      "names": [
        "--root"
      ],
      "description": "Edit/enable/disable/mask unit files in the specified root directory",
      "args": {
        "name": "PATH"
      }
    },
    {
      "names": [
        "-n",
        "--lines"
      ],
      "description": "Number of journal entries to show",
      "args": {
        "name": "N"
      }
    },
    {
      "names": [
        "-o",
        "--output"
      ],
      "description": "Change journal output mode",
      "args": {
        "name": "MODE",
        "suggestions": [
          "short",
          "short-precise",
          "short-iso",
          "short-iso-precise",
          "short-full",
          "short-monotonic",
          "short-unix",
          "verbose",
          "export",
          "json",
          "json-pretty",
          "json-sse",
          "cat"
        ]
      }
    },
    {
      "names": [
        "--firmware-setup"
      ],
      "description": "Tell the firmware to show the setup menu on next boot"
    },
    {
      "names": [
        "--boot-loader-menu"
      ],
      "description": "Boot into boot loader menu on next boot",
      "args": {
        "name": "TIME"
      }
    },
    {
      "names": [
        "--boot-loader-entry"
      ],
      "description": "Boot into a specific boot loader entry on next boot",
      "args": {
        "name": "NAME"
      }
    },
    {
      "names": [
        "--plain"
      ],
      "description": "Print unit dependencies as a list instead of a tree"
    },
    {
      "names": [
        "--timestamp"
      ],
      "description": "Change format of printed timestamps",
      "args": {
        "name": "FORMAT",
        "suggestions": [
          "pretty",
          "unix",
          "us",
          "utc",
          "us+utc"
        ]
      }
    },
    {
      "names": [
        "--read-only"
      ],
      "description": "Create read-only bind mount"
    },
    {
      "names": [
        "--mkdir"
      ],
      "description": "Create directory before mounting, if missing"
    },
    {
      "names": [
        "--marked"
      ],
      "description": "Restart/reload previously marked units"
    }
  ]
};
