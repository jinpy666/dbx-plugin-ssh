// 由 scripts/sync_fig_specs.mjs 生成（withfig/autocomplete @ aef52acff84c45edde61ae610cc2c964802b9a38）——纯数据，勿手改。
// 归一化形态见 src/lib/completion/fig/types.ts；重生成：pnpm fig:sync
import type { FigSpecRoot } from "../../../src/lib/completion/fig/types";

export const spec: FigSpecRoot = {
  "name": "docker",
  "description": "A self-sufficient runtime for containers",
  "subcommands": [
    {
      "name": "attach",
      "description": "Attach local standard input, output, and error streams to a running container,",
      "options": [
        {
          "names": [
            "--detach-keys"
          ],
          "description": "Override the key sequence for detaching a container",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--no-stdin"
          ],
          "description": "Do not attach STDIN"
        },
        {
          "names": [
            "--sig-proxy"
          ],
          "description": "Proxy all received signals to the process (default true)"
        }
      ]
    },
    {
      "name": "build",
      "description": "Build an image from a Dockerfile",
      "options": [
        {
          "names": [
            "--add-host"
          ],
          "args": {
            "name": "list",
            "description": "Add a custom host-to-IP mapping (host:ip)"
          }
        },
        {
          "names": [
            "--build-arg"
          ],
          "args": {
            "name": "list",
            "description": "Set build-time variables"
          }
        },
        {
          "names": [
            "--cache-from"
          ],
          "args": {
            "name": "strings",
            "description": "Images to consider as cache sources"
          }
        },
        {
          "names": [
            "--disable-content-trust"
          ],
          "description": "Skip image verification (default true)"
        },
        {
          "names": [
            "-f",
            "--file"
          ],
          "description": "Name of the Dockerfile (Default is 'PATH/Dockerfile')",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--iidfile"
          ],
          "description": "Write the image ID to the file",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--isolation"
          ],
          "description": "Container isolation technology",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--label"
          ],
          "description": "Set metadata for an image",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--network"
          ],
          "description": "Set the networking mode for the RUN instructions during build (default \"default\")",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--no-cache"
          ],
          "description": "Do not use cache when building the image"
        },
        {
          "names": [
            "-o",
            "--output"
          ],
          "description": "Output destination (format: type=local,dest=path)",
          "args": {
            "name": "stringArray"
          }
        },
        {
          "names": [
            "--platform"
          ],
          "description": "Set platform if server is multi-platform capable",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--progress"
          ],
          "description": "Set type of progress output (auto, plain, tty). Use plain to show container output",
          "args": {
            "name": "string",
            "suggestions": [
              "auto",
              "plain",
              "tty"
            ]
          }
        },
        {
          "names": [
            "--pull"
          ],
          "description": "Always attempt to pull a newer version of the image"
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Suppress the build output and print image ID on success"
        },
        {
          "names": [
            "--secret"
          ],
          "description": "Secret file to expose to the build (only if BuildKit enabled): id=mysecret,src=/local/secret",
          "args": {
            "name": "stringArray"
          }
        },
        {
          "names": [
            "--squash"
          ],
          "description": "Squash newly built layers into a single new layer"
        },
        {
          "names": [
            "--ssh"
          ],
          "description": "SSH agent socket or keys to expose to the build (only if BuildKit enabled) (format: default|<id>[=<socket>|<key>[,<key>]])",
          "args": {
            "name": "stringArray"
          }
        },
        {
          "names": [
            "-t",
            "--tag"
          ],
          "description": "Name and optionally a tag in the 'name:tag' format"
        },
        {
          "names": [
            "--target"
          ],
          "description": "Set the target build stage to build",
          "args": {
            "name": "target build stage"
          }
        }
      ],
      "args": [
        {
          "name": "path"
        }
      ]
    },
    {
      "name": "commit",
      "description": "Create a new image from a container's changes",
      "options": [
        {
          "names": [
            "-a",
            "--author"
          ],
          "description": "Author (e.g., \"John Hannibal Smith <hannibal@a-team.com>\")",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "-c",
            "--change"
          ],
          "description": "Apply Dockerfile instruction to the created image",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "-m",
            "--message"
          ],
          "description": "Commit message",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "-p",
            "--pause"
          ],
          "description": "Pause container during commit (default true)"
        }
      ],
      "args": [
        {
          "name": "container",
          "generators": [
            {
              "kind": "script",
              "script": [
                "docker",
                "ps",
                "--format",
                "{{ json . }}"
              ]
            }
          ]
        },
        {
          "name": "[REPOSITORY[:TAG]]"
        }
      ]
    },
    {
      "name": "cp",
      "description": "Copy files/folders between a container and the local filesystem",
      "options": [
        {
          "names": [
            "-a",
            "--archive"
          ],
          "description": "Archive mode (copy all uid/gid information)"
        },
        {
          "names": [
            "-L",
            "--follow-link"
          ],
          "description": "Always follow symbol link in SRC_PATH"
        }
      ],
      "args": [
        {
          "name": "CONTAINER:SRC_PATH DEST_PATH|- OR SRC_PATH|- CONTAINER:DEST_PATH"
        }
      ]
    },
    {
      "name": "create",
      "description": "Create a new container",
      "options": [
        {
          "names": [
            "--add-host"
          ],
          "description": "Add a custom host-to-IP mapping (host:ip)",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "-a",
            "--attach"
          ],
          "description": "Attach to STDIN, STDOUT or STDERR",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--blkio-weight"
          ],
          "description": "Block IO (relative weight), between 10 and 1000, or 0 to disable (default 0)",
          "args": {
            "name": "uint16"
          }
        },
        {
          "names": [
            "--blkio-weight-device"
          ],
          "description": "Block IO weight (relative device weight) (default [])",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--cap-add"
          ],
          "description": "Add Linux capabilities",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--cap-drop"
          ],
          "description": "Drop Linux capabilities",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--cgroup-parent"
          ],
          "description": "Optional parent cgroup for the container",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--cgroupns"
          ],
          "description": "Cgroup namespace to use (host|private)",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--cidfile"
          ],
          "description": "Write the container ID to the file",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--cpu-period"
          ],
          "description": "Limit CPU CFS (Completely Fair Scheduler) period",
          "args": {
            "name": "int"
          }
        },
        {
          "names": [
            "--cpu-quota"
          ],
          "description": "Limit CPU CFS (Completely Fair Scheduler) quota",
          "args": {
            "name": "int"
          }
        },
        {
          "names": [
            "--cpu-rt-period"
          ],
          "description": "Limit CPU real-time period in microseconds",
          "args": {
            "name": "int"
          }
        },
        {
          "names": [
            "--cpu-rt-runtime"
          ],
          "description": "Limit CPU real-time runtime in microseconds",
          "args": {
            "name": "int"
          }
        },
        {
          "names": [
            "-c",
            "--cpu-shares"
          ],
          "description": "CPU shares (relative weight)",
          "args": {
            "name": "int"
          }
        },
        {
          "names": [
            "--cpus"
          ],
          "description": "Number of CPUs",
          "args": {
            "name": "decimal"
          }
        },
        {
          "names": [
            "--cpuset-cpus"
          ],
          "description": "CPUs in which to allow execution (0-3, 0,1)",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--cpuset-mems"
          ],
          "description": "MEMs in which to allow execution (0-3, 0,1)",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--device"
          ],
          "description": "Add a host device to the container",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--device-cgroup-rule"
          ],
          "description": "Add a rule to the cgroup allowed devices list",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--device-read-bps"
          ],
          "description": "Limit read rate (bytes per second) from a device (default [])",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--device-read-iops"
          ],
          "description": "Limit read rate (IO per second) from a device (default [])",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--device-write-bps"
          ],
          "description": "Limit write rate (bytes per second) to a device (default [])",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--device-write-iops"
          ],
          "description": "Limit write rate (IO per second) to a device (default [])",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--disable-content-trust"
          ],
          "description": "Skip image verification (default true)"
        },
        {
          "names": [
            "--dns"
          ],
          "description": "Set custom DNS servers",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--dns-option"
          ],
          "description": "Set DNS options",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--dns-search"
          ],
          "description": "Set custom DNS search domains",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--domainname"
          ],
          "description": "Container NIS domain name",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--entrypoint"
          ],
          "description": "Overwrite the default ENTRYPOINT of the image",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "-e",
            "--env"
          ],
          "description": "Set environment variables",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--env-file"
          ],
          "description": "Read in a file of environment variables",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--expose"
          ],
          "description": "Expose a port or a range of ports",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--gpus"
          ],
          "description": "GPU devices to add to the container ('all' to pass all GPUs)",
          "args": {
            "name": "gpu-request"
          }
        },
        {
          "names": [
            "--group-add"
          ],
          "description": "Add additional groups to join",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--health-cmd"
          ],
          "description": "Command to run to check health",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--health-interval"
          ],
          "description": "Time between running the check (ms|s|m|h) (default 0s)",
          "args": {
            "name": "duration"
          }
        },
        {
          "names": [
            "--health-retries"
          ],
          "description": "Consecutive failures needed to report unhealthy",
          "args": {
            "name": "int"
          }
        },
        {
          "names": [
            "--health-start-period"
          ],
          "description": "Start period for the container to initialize before starting health-retries countdown (ms|s|m|h) (default 0s)",
          "args": {
            "name": "duration"
          }
        },
        {
          "names": [
            "--health-timeout"
          ],
          "description": "Maximum time to allow one check to run (ms|s|m|h) (default 0s)",
          "args": {
            "name": "duration"
          }
        },
        {
          "names": [
            "--help"
          ],
          "description": "Print usage"
        },
        {
          "names": [
            "-h",
            "--hostname"
          ],
          "description": "Container host name",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--init"
          ],
          "description": "Run an init inside the container that forwards signals and reaps processes"
        },
        {
          "names": [
            "-i",
            "--interactive"
          ],
          "description": "Keep STDIN open even if not attached"
        },
        {
          "names": [
            "--ip"
          ],
          "description": "IPv4 address (e.g., 172.30.100.104)",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--ip6"
          ],
          "description": "IPv6 address (e.g., 2001:db8::33)",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--ipc"
          ],
          "description": "IPC mode to use",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--isolation"
          ],
          "description": "Container isolation technology",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--kernel-memory"
          ],
          "description": "Kernel memory limit",
          "args": {
            "name": "bytes"
          }
        },
        {
          "names": [
            "-l",
            "--label"
          ],
          "description": "Set meta data on a container",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--label-file"
          ],
          "description": "Read in a line delimited file of labels",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--link"
          ],
          "description": "Add link to another container",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--link-local-ip"
          ],
          "description": "Container IPv4/IPv6 link-local addresses",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--log-driver"
          ],
          "description": "Logging driver for the container",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--log-opt"
          ],
          "description": "Log driver options",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--mac-address"
          ],
          "description": "Container MAC address (e.g., 92:d0:c6:0a:29:33)",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "-m",
            "--memory"
          ],
          "description": "Memory limit",
          "args": {
            "name": "bytes"
          }
        },
        {
          "names": [
            "--memory-reservation"
          ],
          "description": "Memory soft limit",
          "args": {
            "name": "bytes"
          }
        },
        {
          "names": [
            "--memory-swap"
          ],
          "description": "Swap limit equal to memory plus swap: '-1' to enable unlimited swap",
          "args": {
            "name": "bytes"
          }
        },
        {
          "names": [
            "--memory-swappiness"
          ],
          "description": "Tune container memory swappiness (0 to 100) (default -1)",
          "args": {
            "name": "int"
          }
        },
        {
          "names": [
            "--mount"
          ],
          "description": "Attach a filesystem mount to the container",
          "args": {
            "name": "mount"
          }
        },
        {
          "names": [
            "--name"
          ],
          "description": "Assign a name to the container",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--network"
          ],
          "description": "Connect a container to a network",
          "args": {
            "name": "network"
          }
        },
        {
          "names": [
            "--network-alias"
          ],
          "description": "Add network-scoped alias for the container",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--no-healthcheck"
          ],
          "description": "Disable any container-specified HEALTHCHECK"
        },
        {
          "names": [
            "--oom-kill-disable"
          ],
          "description": "Disable OOM Killer"
        },
        {
          "names": [
            "--oom-score-adj"
          ],
          "description": "Tune host's OOM preferences (-1000 to 1000)",
          "args": {
            "name": "int"
          }
        },
        {
          "names": [
            "--pid"
          ],
          "description": "PID namespace to use",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--pids-limit"
          ],
          "description": "Tune container pids limit (set -1 for unlimited)",
          "args": {
            "name": "int"
          }
        },
        {
          "names": [
            "--platform"
          ],
          "description": "Set platform if server is multi-platform capable",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--privileged"
          ],
          "description": "Give extended privileges to this container"
        },
        {
          "names": [
            "-p",
            "--publish"
          ],
          "description": "Publish a container's port(s) to the host",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "-P",
            "--publish-all"
          ],
          "description": "Publish all exposed ports to random ports"
        },
        {
          "names": [
            "--pull"
          ],
          "description": "Pull image before creating (\"always\"|\"missing\"|\"never\") (default \"missing\")",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--read-only"
          ],
          "description": "Mount the container's root filesystem as read only"
        },
        {
          "names": [
            "--restart"
          ],
          "description": "Restart policy to apply when a container exits (default \"no\")",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--rm"
          ],
          "description": "Automatically remove the container when it exits"
        },
        {
          "names": [
            "--runtime"
          ],
          "description": "Runtime to use for this container",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--security-opt"
          ],
          "description": "Security Options",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--shm-size"
          ],
          "description": "Size of /dev/shm",
          "args": {
            "name": "bytes"
          }
        },
        {
          "names": [
            "--stop-signal"
          ],
          "description": "Signal to stop a container (default \"SIGTERM\")",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--stop-timeout"
          ],
          "description": "Timeout (in seconds) to stop a container",
          "args": {
            "name": "int"
          }
        },
        {
          "names": [
            "--storage-opt"
          ],
          "description": "Storage driver options for the container",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--sysctl"
          ],
          "description": "Sysctl options (default map[])",
          "args": {
            "name": "map"
          }
        },
        {
          "names": [
            "--tmpfs"
          ],
          "description": "Mount a tmpfs directory",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "-t",
            "--tty"
          ],
          "description": "Allocate a pseudo-TTY"
        },
        {
          "names": [
            "--ulimit"
          ],
          "description": "Ulimit options (default [])",
          "args": {
            "name": "ulimit"
          }
        },
        {
          "names": [
            "-u",
            "--user"
          ],
          "description": "Username or UID (format: <name|uid>[:<group|gid>])",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--userns"
          ],
          "description": "User namespace to use",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--uts"
          ],
          "description": "UTS namespace to use",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "-v",
            "--volume"
          ],
          "description": "Bind mount a volume",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--volume-driver"
          ],
          "description": "Optional volume driver for the container",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--volumes-from"
          ],
          "description": "Mount volumes from the specified container(s)",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "-w",
            "--workdir"
          ],
          "description": "Working directory inside the container",
          "args": {
            "name": "string"
          }
        }
      ],
      "args": [
        {
          "name": "container",
          "generators": [
            {
              "kind": "script",
              "script": [
                "docker",
                "image",
                "ls",
                "--format",
                "{{ json . }}"
              ]
            }
          ]
        },
        {
          "name": "command"
        }
      ]
    },
    {
      "name": "diff",
      "description": "Inspect changes to files or directories on a container's filesystem",
      "args": [
        {
          "name": "container",
          "generators": [
            {
              "kind": "script",
              "script": [
                "docker",
                "ps",
                "--format",
                "{{ json . }}"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "events",
      "description": "Get real time events from the server",
      "options": [
        {
          "names": [
            "-f",
            "--filter"
          ],
          "description": "Filter output based on conditions provided",
          "args": {
            "name": "filter"
          }
        },
        {
          "names": [
            "--format"
          ],
          "description": "Format the output using the given Go template",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--since"
          ],
          "description": "Show all events created since timestamp",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--until"
          ],
          "description": "Stream events until this timestamp",
          "args": {
            "name": "string"
          }
        }
      ]
    },
    {
      "name": "exec",
      "description": "Run a command in a running container",
      "options": [
        {
          "names": [
            "-it"
          ],
          "description": "Launch an interactive session"
        },
        {
          "names": [
            "-d",
            "--detach"
          ],
          "description": "Detached mode: run command in the background"
        },
        {
          "names": [
            "--detach-keys"
          ],
          "description": "Override the key sequence for detaching a container",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "-e",
            "--env"
          ],
          "description": "Set environment variables",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--env-file"
          ],
          "description": "Read in a file of environment variables",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "-i",
            "--interactive"
          ],
          "description": "Keep STDIN open even if not attached"
        },
        {
          "names": [
            "--privileged"
          ],
          "description": "Give extended privileges to the command"
        },
        {
          "names": [
            "-t",
            "--tty"
          ],
          "description": "Allocate a pseudo-TTY"
        },
        {
          "names": [
            "-u",
            "--user"
          ],
          "description": "Username or UID (format: <name|uid>[:<group|gid>])",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "-w",
            "--workdir"
          ],
          "description": "Working directory inside the container",
          "args": {
            "name": "string"
          }
        }
      ],
      "args": [
        {
          "name": "container",
          "generators": [
            {
              "kind": "script",
              "script": [
                "docker",
                "ps",
                "--format",
                "{{ json . }}"
              ]
            }
          ]
        },
        {
          "name": "command"
        }
      ]
    },
    {
      "name": "export",
      "description": "Export a container's filesystem as a tar archive",
      "options": [
        {
          "names": [
            "-o",
            "--output"
          ],
          "description": "Write to a file, instead of STDOUT",
          "args": {
            "name": "string"
          }
        }
      ],
      "args": [
        {
          "name": "container",
          "generators": [
            {
              "kind": "script",
              "script": [
                "docker",
                "ps",
                "--format",
                "{{ json . }}"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "history",
      "description": "Show the history of an image",
      "options": [
        {
          "names": [
            "--format"
          ],
          "description": "Pretty-print images using a Go template",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "-H",
            "--human"
          ],
          "description": "Print sizes and dates in human readable format (default true)"
        },
        {
          "names": [
            "--no-trunc"
          ],
          "description": "Don't truncate output"
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Only show image IDs"
        }
      ],
      "args": [
        {
          "name": "image",
          "generators": [
            {
              "kind": "script",
              "script": [
                "docker",
                "image",
                "ls",
                "--format",
                "{{ json . }}"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "images",
      "description": "List images",
      "options": [
        {
          "names": [
            "-a",
            "--all"
          ],
          "description": "Show all images (default hides intermediate images)"
        },
        {
          "names": [
            "--digests"
          ],
          "description": "Show digests"
        },
        {
          "names": [
            "-f",
            "--filter"
          ],
          "description": "Filter output based on conditions provided",
          "args": {
            "name": "filter"
          }
        },
        {
          "names": [
            "--format"
          ],
          "description": "Pretty-print images using a Go template",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--no-trunc"
          ],
          "description": "Don't truncate output"
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Only show image IDs"
        }
      ],
      "args": [
        {
          "name": "[REPOSITORY[:TAG]]"
        }
      ]
    },
    {
      "name": "import",
      "description": "Import the contents from a tarball to create a filesystem image",
      "options": [
        {
          "names": [
            "-c",
            "--change"
          ],
          "description": "Apply Dockerfile instruction to the created image",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "-m",
            "--message"
          ],
          "description": "Set commit message for imported image",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--platform"
          ],
          "description": "Set platform if server is multi-platform capable",
          "args": {
            "name": "string"
          }
        }
      ],
      "args": [
        {
          "name": "file|URL|- [REPOSITORY[:TAG]]"
        }
      ]
    },
    {
      "name": "info",
      "description": "Display system-wide information",
      "options": [
        {
          "names": [
            "-f",
            "--format"
          ],
          "description": "Format the output using the given Go template",
          "args": {
            "name": "string"
          }
        }
      ]
    },
    {
      "name": "inspect",
      "description": "Return low-level information on Docker objects",
      "options": [
        {
          "names": [
            "-f",
            "--format"
          ],
          "description": "Format the output using the given Go template",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "-s",
            "--size"
          ],
          "description": "Display total file sizes if the type is container"
        },
        {
          "names": [
            "--type"
          ],
          "description": "Return JSON for specified type",
          "args": {
            "name": "string"
          }
        }
      ],
      "args": [
        {
          "name": "Name or ID",
          "generators": [
            {
              "kind": "script",
              "script": [
                "docker",
                "ps",
                "-a",
                "--format",
                "{{ json . }}"
              ]
            },
            {
              "kind": "script",
              "script": [
                "docker",
                "images",
                "-a",
                "--format",
                "{{ json . }}"
              ]
            },
            {
              "kind": "script",
              "script": [
                "docker",
                "volume",
                "ls",
                "--format",
                "{{ json . }}"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "kill",
      "description": "Kill one or more running containers",
      "options": [
        {
          "names": [
            "-s",
            "--signal"
          ],
          "description": "Signal to send to the container (default \"KILL\")",
          "args": {
            "name": "string"
          }
        }
      ],
      "args": [
        {
          "name": "container",
          "isVariadic": true,
          "generators": [
            {
              "kind": "script",
              "script": [
                "docker",
                "ps",
                "--format",
                "{{ json . }}"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "load",
      "description": "Load an image from a tar archive or STDIN",
      "options": [
        {
          "names": [
            "-i"
          ],
          "description": "Read from tar archive file, instead of STDIN",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Suppress the load output"
        }
      ]
    },
    {
      "name": "login",
      "description": "Log in to a Docker registry",
      "options": [
        {
          "names": [
            "-p",
            "--password"
          ],
          "description": "Password",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--password-stdin"
          ],
          "description": "Take the password from stdin"
        },
        {
          "names": [
            "-u",
            "--username"
          ],
          "description": "Username",
          "args": {
            "name": "string"
          }
        }
      ],
      "args": [
        {
          "name": "server"
        }
      ]
    },
    {
      "name": "logout",
      "description": "Log out from a Docker registry",
      "args": [
        {
          "name": "server"
        }
      ]
    },
    {
      "name": "logs",
      "description": "Fetch the logs of a container",
      "options": [
        {
          "names": [
            "--details"
          ],
          "description": "Show extra details provided to logs"
        },
        {
          "names": [
            "-f",
            "--follow"
          ],
          "description": "Follow log output"
        },
        {
          "names": [
            "--since"
          ],
          "description": "Show logs since timestamp (e.g. 2013-01-02T13:23:37Z) or relative (e.g. 42m for 42 minutes)",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "-n",
            "--tail"
          ],
          "description": "Number of lines to show from the end of the logs (default \"all\")",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "-t",
            "--timestamps"
          ],
          "description": "Show timestamps"
        },
        {
          "names": [
            "--until"
          ],
          "description": "Show logs before a timestamp (e.g. 2013-01-02T13:23:37Z) or relative (e.g. 42m for 42 minutes)",
          "args": {
            "name": "string"
          }
        }
      ],
      "args": [
        {
          "name": "container",
          "generators": [
            {
              "kind": "script",
              "script": [
                "docker",
                "ps",
                "--format",
                "{{ json . }}"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "pause",
      "description": "Pause all processes within one or more containers",
      "args": [
        {
          "name": "container",
          "generators": [
            {
              "kind": "script",
              "script": [
                "docker",
                "ps",
                "--format",
                "{{ json . }}"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "port",
      "description": "List port mappings or a specific mapping for the container",
      "args": [
        {
          "name": "container",
          "generators": [
            {
              "kind": "script",
              "script": [
                "docker",
                "ps",
                "--format",
                "{{ json . }}"
              ]
            }
          ]
        },
        {
          "name": "[PRIVATE_PORT[/PROTO]]"
        }
      ]
    },
    {
      "name": "ps",
      "description": "List containers",
      "options": [
        {
          "names": [
            "-a",
            "--all"
          ],
          "description": "Show all containers (default shows just running)"
        },
        {
          "names": [
            "-f",
            "--filter"
          ],
          "description": "Filter output based on conditions provided",
          "args": {
            "name": "filter"
          }
        },
        {
          "names": [
            "--format"
          ],
          "description": "Pretty-print containers using a Go template",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "-n",
            "--last"
          ],
          "description": "Show n last created containers (includes all states) (default -1)",
          "args": {
            "name": "int"
          }
        },
        {
          "names": [
            "-l",
            "--latest"
          ],
          "description": "Show the latest created container (includes all states)"
        },
        {
          "names": [
            "--no-trunc"
          ],
          "description": "Don't truncate output"
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Only display container IDs"
        },
        {
          "names": [
            "-s",
            "--size"
          ],
          "description": "Display total file sizes"
        }
      ]
    },
    {
      "name": "pull",
      "description": "Pull an image or a repository from a registry",
      "options": [
        {
          "names": [
            "-a",
            "--all-tags"
          ],
          "description": "Download all tagged images in the repository"
        },
        {
          "names": [
            "--disable-content-trust"
          ],
          "description": "Skip image verification (default true)"
        },
        {
          "names": [
            "--platform"
          ],
          "description": "Set platform if server is multi-platform capable",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Suppress verbose output"
        }
      ],
      "args": [
        {
          "name": "NAME[:TAG|@DIGEST]"
        }
      ]
    },
    {
      "name": "push",
      "description": "Push an image or a repository to a registry",
      "options": [
        {
          "names": [
            "-a",
            "--all-tags"
          ],
          "description": "Push all tagged images in the repository"
        },
        {
          "names": [
            "--disable-content-trust"
          ],
          "description": "Skip image signing (default true)"
        },
        {
          "names": [
            "-q",
            "--quiet"
          ],
          "description": "Suppress verbose output"
        }
      ],
      "args": [
        {
          "name": "NAME[:TAG]"
        }
      ]
    },
    {
      "name": "rename",
      "description": "Rename a container",
      "args": [
        {
          "name": "container",
          "generators": [
            {
              "kind": "script",
              "script": [
                "docker",
                "ps",
                "--format",
                "{{ json . }}"
              ]
            }
          ]
        },
        {
          "name": "NEW_NAME"
        }
      ]
    },
    {
      "name": "restart",
      "description": "Restart one or more containers",
      "options": [
        {
          "names": [
            "-t",
            "--time"
          ],
          "description": "Seconds to wait for stop before killing the container (default 10)",
          "args": {
            "name": "int"
          }
        }
      ],
      "args": [
        {
          "name": "container",
          "generators": [
            {
              "kind": "script",
              "script": [
                "docker",
                "ps",
                "--format",
                "{{ json . }}"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "rm",
      "description": "Remove one or more containers",
      "options": [
        {
          "names": [
            "-f",
            "--force"
          ],
          "description": "Force the removal of a running container (uses SIGKILL)"
        },
        {
          "names": [
            "-l",
            "--link"
          ],
          "description": "Remove the specified link"
        },
        {
          "names": [
            "-v",
            "--volumes"
          ],
          "description": "Remove the anonymous volumes associated with the container"
        }
      ],
      "args": [
        {
          "name": "containers",
          "isVariadic": true,
          "generators": [
            {
              "kind": "script",
              "script": [
                "docker",
                "ps",
                "-a",
                "--format",
                "{{ json . }}"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "rmi",
      "description": "Remove one or more images",
      "options": [
        {
          "names": [
            "-f",
            "--force"
          ],
          "description": "Force removal of the image"
        },
        {
          "names": [
            "--no-prune"
          ],
          "description": "Do not delete untagged parents"
        }
      ],
      "args": [
        {
          "name": "image",
          "isVariadic": true,
          "generators": [
            {
              "kind": "script",
              "script": [
                "docker",
                "image",
                "ls",
                "--format",
                "{{ json . }}"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "run",
      "description": "Run a command in a new container",
      "options": [
        {
          "names": [
            "-it"
          ],
          "description": "Launch an interactive session"
        },
        {
          "names": [
            "--add-host"
          ],
          "description": "Add a custom host-to-IP mapping (host:ip)",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "-a",
            "--attach"
          ],
          "description": "Attach to STDIN, STDOUT or STDERR",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--blkio-weight"
          ],
          "description": "Block IO (relative weight), between 10 and 1000, or 0 to disable (default 0)",
          "args": {
            "name": "uint16"
          }
        },
        {
          "names": [
            "--blkio-weight-device"
          ],
          "description": "Block IO weight (relative device weight) (default [])",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--cap-add"
          ],
          "description": "Add Linux capabilities",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--cap-drop"
          ],
          "description": "Drop Linux capabilities",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--cgroup-parent"
          ],
          "description": "Optional parent cgroup for the container",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--cgroupns"
          ],
          "description": "Cgroup namespace to use (host|private)\n'host':    Run the container in the Docker host's cgroup namespace\n'private': Run the container in its own private cgroup namespace\n'':        Use the cgroup namespace as configured by the\ndefault-cgroupns-mode option on the daemon (default)",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--cidfile"
          ],
          "description": "Write the container ID to the file",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--cpu-period"
          ],
          "description": "Limit CPU CFS (Completely Fair Scheduler) period",
          "args": {
            "name": "int"
          }
        },
        {
          "names": [
            "--cpu-quota"
          ],
          "description": "Limit CPU CFS (Completely Fair Scheduler) quota",
          "args": {
            "name": "int"
          }
        },
        {
          "names": [
            "--cpu-rt-period"
          ],
          "description": "Limit CPU real-time period in microseconds",
          "args": {
            "name": "int"
          }
        },
        {
          "names": [
            "--cpu-rt-runtime"
          ],
          "description": "Limit CPU real-time runtime in microseconds",
          "args": {
            "name": "int"
          }
        },
        {
          "names": [
            "-c",
            "--cpu-shares"
          ],
          "description": "CPU shares (relative weight)",
          "args": {
            "name": "int"
          }
        },
        {
          "names": [
            "--cpus"
          ],
          "description": "Number of CPUs",
          "args": {
            "name": "decimal"
          }
        },
        {
          "names": [
            "--cpuset-cpus"
          ],
          "description": "CPUs in which to allow execution (0-3, 0,1)",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--cpuset-mems"
          ],
          "description": "MEMs in which to allow execution (0-3, 0,1)",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "-d",
            "--detach"
          ],
          "description": "Run container in background and print container ID"
        },
        {
          "names": [
            "--detach-keys"
          ],
          "description": "Override the key sequence for detaching a container",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--device"
          ],
          "description": "Add a host device to the container",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--device-cgroup-rule"
          ],
          "description": "Add a rule to the cgroup allowed devices list",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--device-read-bps"
          ],
          "description": "Limit read rate (bytes per second) from a device (default [])",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--device-read-iops"
          ],
          "description": "Limit read rate (IO per second) from a device (default [])",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--device-write-bps"
          ],
          "description": "Limit write rate (bytes per second) to a device (default [])",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--device-write-iops"
          ],
          "description": "Limit write rate (IO per second) to a device (default [])",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--disable-content-trust"
          ],
          "description": "Skip image verification (default true)"
        },
        {
          "names": [
            "--dns"
          ],
          "description": "Set custom DNS servers",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--dns-option"
          ],
          "description": "Set DNS options",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--dns-search"
          ],
          "description": "Set custom DNS search domains",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--domainname"
          ],
          "description": "Container NIS domain name",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--entrypoint"
          ],
          "description": "Overwrite the default ENTRYPOINT of the image",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "-e",
            "--env"
          ],
          "description": "Set environment variables",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--env-file"
          ],
          "description": "Read in a file of environment variables",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--expose"
          ],
          "description": "Expose a port or a range of ports",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--gpus"
          ],
          "description": "GPU devices to add to the container ('all' to pass all GPUs)",
          "args": {
            "name": "gpu-request"
          }
        },
        {
          "names": [
            "--group-add"
          ],
          "description": "Add additional groups to join",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--health-cmd"
          ],
          "description": "Command to run to check health",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--health-interval"
          ],
          "description": "Time between running the check (ms|s|m|h) (default 0s)",
          "args": {
            "name": "duration"
          }
        },
        {
          "names": [
            "--health-retries"
          ],
          "description": "Consecutive failures needed to report unhealthy",
          "args": {
            "name": "int"
          }
        },
        {
          "names": [
            "--health-start-period"
          ],
          "description": "Start period for the container to initialize before starting health-retries countdown (ms|s|m|h) (default 0s)",
          "args": {
            "name": "duration"
          }
        },
        {
          "names": [
            "--health-timeout"
          ],
          "description": "Maximum time to allow one check to run (ms|s|m|h) (default 0s)",
          "args": {
            "name": "duration"
          }
        },
        {
          "names": [
            "--help"
          ],
          "description": "Print usage"
        },
        {
          "names": [
            "-h",
            "--hostname"
          ],
          "description": "Container host name",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--init"
          ],
          "description": "Run an init inside the container that forwards signals and reaps processes"
        },
        {
          "names": [
            "-i",
            "--interactive"
          ],
          "description": "Keep STDIN open even if not attached"
        },
        {
          "names": [
            "--ip"
          ],
          "description": "IPv4 address (e.g., 172.30.100.104)",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--ip6"
          ],
          "description": "IPv6 address (e.g., 2001:db8::33)",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--ipc"
          ],
          "description": "IPC mode to use",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--isolation"
          ],
          "description": "Container isolation technology",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--kernel-memory"
          ],
          "description": "Kernel memory limit",
          "args": {
            "name": "bytes"
          }
        },
        {
          "names": [
            "-l",
            "--label"
          ],
          "description": "Set meta data on a container",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--label-file"
          ],
          "description": "Read in a line delimited file of labels",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--link"
          ],
          "description": "Add link to another container",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--link-local-ip"
          ],
          "description": "Container IPv4/IPv6 link-local addresses",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--log-driver"
          ],
          "description": "Logging driver for the container",
          "args": {
            "name": "string",
            "suggestions": [
              "json-file",
              "syslog",
              "journald",
              "gelf",
              "fluentd",
              "awslogs",
              "splunk",
              "etwlogs",
              "gcplogs",
              "none"
            ]
          }
        },
        {
          "names": [
            "--log-opt"
          ],
          "description": "Log driver options",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--mac-address"
          ],
          "description": "Container MAC address (e.g., 92:d0:c6:0a:29:33)",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "-m",
            "--memory"
          ],
          "description": "Memory limit",
          "args": {
            "name": "bytes"
          }
        },
        {
          "names": [
            "--memory-reservation"
          ],
          "description": "Memory soft limit",
          "args": {
            "name": "bytes"
          }
        },
        {
          "names": [
            "--memory-swap"
          ],
          "description": "Swap limit equal to memory plus swap: '-1' to enable unlimited swap",
          "args": {
            "name": "bytes"
          }
        },
        {
          "names": [
            "--memory-swappiness"
          ],
          "description": "Tune container memory swappiness (0 to 100) (default -1)",
          "args": {
            "name": "int"
          }
        },
        {
          "names": [
            "--mount"
          ],
          "description": "Attach a filesystem mount to the container",
          "args": {
            "name": "mount"
          }
        },
        {
          "names": [
            "--name"
          ],
          "description": "Assign a name to the container",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--network"
          ],
          "description": "Connect a container to a network",
          "args": {
            "name": "network"
          }
        },
        {
          "names": [
            "--network-alias"
          ],
          "description": "Add network-scoped alias for the container",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--no-healthcheck"
          ],
          "description": "Disable any container-specified HEALTHCHECK"
        },
        {
          "names": [
            "--oom-kill-disable"
          ],
          "description": "Disable OOM Killer"
        },
        {
          "names": [
            "--oom-score-adj"
          ],
          "description": "Tune host's OOM preferences (-1000 to 1000)",
          "args": {
            "name": "int"
          }
        },
        {
          "names": [
            "--pid"
          ],
          "description": "PID namespace to use",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--pids-limit"
          ],
          "description": "Tune container pids limit (set -1 for unlimited)",
          "args": {
            "name": "int"
          }
        },
        {
          "names": [
            "--platform"
          ],
          "description": "Set platform if server is multi-platform capable",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--privileged"
          ],
          "description": "Give extended privileges to this container"
        },
        {
          "names": [
            "-p",
            "--publish"
          ],
          "description": "Publish a container's port(s) to the host",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "-P",
            "--publish-all"
          ],
          "description": "Publish all exposed ports to random ports"
        },
        {
          "names": [
            "--pull"
          ],
          "description": "Pull image before running ('always'|'missing'|'never') (default 'missing')",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--read-only"
          ],
          "description": "Mount the container's root filesystem as read only"
        },
        {
          "names": [
            "--restart"
          ],
          "description": "Restart policy to apply when a container exits (default 'no')",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--rm"
          ],
          "description": "Automatically remove the container when it exits"
        },
        {
          "names": [
            "--runtime"
          ],
          "description": "Runtime to use for this container",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--security-opt"
          ],
          "description": "Security Options",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--shm-size"
          ],
          "description": "Size of /dev/shm",
          "args": {
            "name": "bytes"
          }
        },
        {
          "names": [
            "--sig-proxy"
          ],
          "description": "Proxy received signals to the process (default true)"
        },
        {
          "names": [
            "--stop-signal"
          ],
          "description": "Signal to stop a container (default 'SIGTERM')",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--stop-timeout"
          ],
          "description": "Timeout (in seconds) to stop a container",
          "args": {
            "name": "int"
          }
        },
        {
          "names": [
            "--storage-opt"
          ],
          "description": "Storage driver options for the container",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--sysctl"
          ],
          "description": "Sysctl options (default map[])",
          "args": {
            "name": "map"
          }
        },
        {
          "names": [
            "--tmpfs"
          ],
          "description": "Mount a tmpfs directory",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "-t",
            "--tty"
          ],
          "description": "Allocate a pseudo-TTY"
        },
        {
          "names": [
            "--ulimit"
          ],
          "description": "Ulimit options (default [])",
          "args": {
            "name": "ulimit"
          }
        },
        {
          "names": [
            "-u",
            "--user"
          ],
          "description": "Username or UID (format: <name|uid>[:<group|gid>])",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--userns"
          ],
          "description": "User namespace to use",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--uts"
          ],
          "description": "UTS namespace to use",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "-v",
            "--volume"
          ],
          "description": "Bind mount a volume",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "--volume-driver"
          ],
          "description": "Optional volume driver for the container",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--volumes-from"
          ],
          "description": "Mount volumes from the specified container(s)",
          "args": {
            "name": "list"
          }
        },
        {
          "names": [
            "-w",
            "--workdir"
          ],
          "description": "Working directory inside the container",
          "args": {
            "name": "string"
          }
        }
      ],
      "args": [
        {
          "name": "image",
          "description": "The Docker image to use",
          "generators": [
            {
              "kind": "script",
              "script": [
                "docker",
                "images",
                "--format",
                "{{.Repository}} {{.Size}} {{.Tag}} {{.ID}}"
              ]
            }
          ]
        },
        {
          "name": "command"
        }
      ]
    },
    {
      "name": "save",
      "description": "Save one or more images to a tar archive (streamed to STDOUT by default)",
      "options": [
        {
          "names": [
            "-o",
            "--output"
          ],
          "description": "Write to a file, instead of STDOUT",
          "args": {
            "name": "string"
          }
        }
      ],
      "args": [
        {
          "name": "image",
          "generators": [
            {
              "kind": "script",
              "script": [
                "docker",
                "image",
                "ls",
                "--format",
                "{{ json . }}"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "search",
      "description": "Search the Docker Hub for images",
      "options": [
        {
          "names": [
            "-f",
            "--filter"
          ],
          "description": "Filter output based on conditions provided",
          "args": {
            "name": "filter"
          }
        },
        {
          "names": [
            "--format"
          ],
          "description": "Pretty-print search using a Go template",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--limit"
          ],
          "description": "Max number of search results (default 25)",
          "args": {
            "name": "int"
          }
        },
        {
          "names": [
            "--no-trunc"
          ],
          "description": "Don't truncate output"
        }
      ],
      "args": [
        {
          "name": "TERM",
          "description": "Search term"
        }
      ]
    },
    {
      "name": "sbom",
      "description": "View the packaged-based Software Bill Of Materials (SBOM) for an image",
      "options": [
        {
          "names": [
            "-D",
            "--debug"
          ],
          "description": "Show debug logging"
        },
        {
          "names": [
            "--exclude"
          ],
          "description": "Exclude paths from being scanned using a glob expression",
          "args": {
            "name": "paths"
          }
        },
        {
          "names": [
            "--format"
          ],
          "description": "Report output format",
          "args": {
            "name": "fromat",
            "suggestions": [
              "syft-json",
              "cyclonedx-xml",
              "cyclonedx-json",
              "github-0-json",
              "spdx-tag-value",
              "spdx-json",
              "table",
              "text"
            ]
          }
        },
        {
          "names": [
            "--layers"
          ],
          "description": "[experimental] selection of layers to catalog",
          "args": {
            "name": "layers",
            "suggestions": [
              "squashed",
              "all"
            ]
          }
        },
        {
          "names": [
            "-o",
            "--output"
          ],
          "description": "File to write the default report output to (default is STDOUT)",
          "args": {
            "name": "file"
          }
        },
        {
          "names": [
            "--platform"
          ],
          "description": "An optional platform specifier for container image sources (e.g. 'linux/arm64', 'linux/arm64/v8', 'arm64', 'linux')",
          "args": {
            "name": "platform"
          }
        },
        {
          "names": [
            "--quiet"
          ],
          "description": "Suppress all non-report output"
        },
        {
          "names": [
            "-v",
            "--version"
          ],
          "description": "Version for sbom"
        }
      ],
      "args": [
        {
          "name": "image",
          "generators": [
            {
              "kind": "script",
              "script": [
                "docker",
                "image",
                "ls",
                "--format",
                "{{ json . }}"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "start",
      "description": "Start one or more stopped containers",
      "options": [
        {
          "names": [
            "-a",
            "--attach"
          ],
          "description": "Attach STDOUT/STDERR and forward signals"
        },
        {
          "names": [
            "--detach-keys"
          ],
          "description": "Override the key sequence for detaching a container",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "-i",
            "--interactive"
          ],
          "description": "Attach container's STDIN"
        }
      ],
      "args": [
        {
          "name": "container",
          "generators": [
            {
              "kind": "script",
              "script": [
                "docker",
                "ps",
                "-a",
                "--format",
                "{{ json . }}"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "stats",
      "description": "Display a live stream of container(s) resource usage statistics",
      "options": [
        {
          "names": [
            "-a",
            "--all"
          ],
          "description": "Show all containers (default shows just running)"
        },
        {
          "names": [
            "--format"
          ],
          "description": "Pretty-print images using a Go template",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--no-stream"
          ],
          "description": "Disable streaming stats and only pull the first result"
        },
        {
          "names": [
            "--no-trunc"
          ],
          "description": "Do not truncate output"
        }
      ],
      "args": [
        {
          "name": "container",
          "generators": [
            {
              "kind": "script",
              "script": [
                "docker",
                "ps",
                "--format",
                "{{ json . }}"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "stop",
      "description": "Stop one or more running containers",
      "options": [
        {
          "names": [
            "-t",
            "--t"
          ],
          "description": "Seconds to wait for stop before killing it (default 10)",
          "args": {
            "name": "int"
          }
        }
      ],
      "args": [
        {
          "name": "container",
          "generators": [
            {
              "kind": "script",
              "script": [
                "docker",
                "ps",
                "--format",
                "{{ json . }}"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "tag",
      "description": "Create a tag TARGET_IMAGE that refers to SOURCE_IMAGE",
      "args": [
        {
          "name": "SOURCE_IMAGE[:TAG] TARGET_IMAGE[:TAG]"
        }
      ]
    },
    {
      "name": "top",
      "description": "Display the running processes of a container",
      "args": [
        {
          "name": "container",
          "generators": [
            {
              "kind": "script",
              "script": [
                "docker",
                "ps",
                "--format",
                "{{ json . }}"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "unpause",
      "description": "Unpause all processes within one or more containers",
      "args": [
        {
          "name": "container",
          "generators": [
            {
              "kind": "script",
              "script": [
                "docker",
                "ps",
                "--filter",
                "status=paused",
                "--format",
                "{{ json . }}"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "update",
      "description": "Update configuration of one or more containers",
      "options": [
        {
          "names": [
            "--blkio-weight"
          ],
          "description": "Block IO (relative weight), between 10 and 1000, or 0 to disable (default 0)",
          "args": {
            "name": "uint16"
          }
        },
        {
          "names": [
            "--cpu-period"
          ],
          "description": "Limit CPU CFS (Completely Fair Scheduler) period",
          "args": {
            "name": "int"
          }
        },
        {
          "names": [
            "--cpu-quota"
          ],
          "description": "Limit CPU CFS (Completely Fair Scheduler) quota",
          "args": {
            "name": "int"
          }
        },
        {
          "names": [
            "--cpu-rt-period"
          ],
          "description": "Limit the CPU real-time period in microseconds",
          "args": {
            "name": "int"
          }
        },
        {
          "names": [
            "--cpu-rt-runtime"
          ],
          "description": "Limit the CPU real-time runtime in microseconds",
          "args": {
            "name": "int"
          }
        },
        {
          "names": [
            "-c",
            "--cpu-shares"
          ],
          "description": "CPU shares (relative weight)",
          "args": {
            "name": "int"
          }
        },
        {
          "names": [
            "--cpus"
          ],
          "description": "Number of CPUs",
          "args": {
            "name": "decimal"
          }
        },
        {
          "names": [
            "--cpuset-cpus"
          ],
          "description": "CPUs in which to allow execution (0-3, 0,1)",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--cpuset-mems"
          ],
          "description": "MEMs in which to allow execution (0-3, 0,1)",
          "args": {
            "name": "string"
          }
        },
        {
          "names": [
            "--kernel-memory"
          ],
          "description": "Kernel memory limit",
          "args": {
            "name": "bytes"
          }
        },
        {
          "names": [
            "-m",
            "--memory"
          ],
          "description": "Memory limit",
          "args": {
            "name": "bytes"
          }
        },
        {
          "names": [
            "--memory-reservation"
          ],
          "description": "Memory soft limit",
          "args": {
            "name": "bytes"
          }
        },
        {
          "names": [
            "--memory-swap"
          ],
          "description": "Swap limit equal to memory plus swap: '-1' to enable unlimited swap",
          "args": {
            "name": "bytes"
          }
        },
        {
          "names": [
            "--pids-limit"
          ],
          "description": "Tune container pids limit (set -1 for unlimited)",
          "args": {
            "name": "int"
          }
        },
        {
          "names": [
            "--restart"
          ],
          "description": "Restart policy to apply when a container exits",
          "args": {
            "name": "string"
          }
        }
      ],
      "args": [
        {
          "name": "container",
          "generators": [
            {
              "kind": "script",
              "script": [
                "docker",
                "ps",
                "--format",
                "{{ json . }}"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "version",
      "description": "Show the Docker version information",
      "options": [
        {
          "names": [
            "-f",
            "--format"
          ],
          "description": "Format the output. Values: [pretty | json]. (Default: pretty)",
          "args": {
            "name": "string",
            "suggestions": [
              "pretty",
              "json"
            ]
          }
        },
        {
          "names": [
            "--kubeconfig"
          ],
          "description": "Kubernetes config file",
          "args": {
            "name": "string"
          }
        }
      ]
    },
    {
      "name": "wait",
      "description": "Block until one or more containers stop, then print their exit codes",
      "args": [
        {
          "name": "container",
          "generators": [
            {
              "kind": "script",
              "script": [
                "docker",
                "ps",
                "--format",
                "{{ json . }}"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "builder",
      "description": "Manage builds",
      "subcommands": [
        {
          "name": "build",
          "description": "Build an image from a Dockerfile",
          "options": [
            {
              "names": [
                "--add-host"
              ],
              "args": {
                "name": "list",
                "description": "Add a custom host-to-IP mapping (host:ip)"
              }
            },
            {
              "names": [
                "--build-arg"
              ],
              "args": {
                "name": "list",
                "description": "Set build-time variables"
              }
            },
            {
              "names": [
                "--cache-from"
              ],
              "args": {
                "name": "strings",
                "description": "Images to consider as cache sources"
              }
            },
            {
              "names": [
                "--disable-content-trust"
              ],
              "description": "Skip image verification (default true)"
            },
            {
              "names": [
                "-f",
                "--file"
              ],
              "description": "Name of the Dockerfile (Default is 'PATH/Dockerfile')",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--iidfile"
              ],
              "description": "Write the image ID to the file",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--isolation"
              ],
              "description": "Container isolation technology",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--label"
              ],
              "description": "Set metadata for an image",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--network"
              ],
              "description": "Set the networking mode for the RUN instructions during build (default \"default\")",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--no-cache"
              ],
              "description": "Do not use cache when building the image"
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output destination (format: type=local,dest=path)",
              "args": {
                "name": "stringArray"
              }
            },
            {
              "names": [
                "--platform"
              ],
              "description": "Set platform if server is multi-platform capable",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--progress"
              ],
              "description": "Set type of progress output (auto, plain, tty). Use plain to show container output",
              "args": {
                "name": "string",
                "suggestions": [
                  "auto",
                  "plain",
                  "tty"
                ]
              }
            },
            {
              "names": [
                "--pull"
              ],
              "description": "Always attempt to pull a newer version of the image"
            },
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "Suppress the build output and print image ID on success"
            },
            {
              "names": [
                "--secret"
              ],
              "description": "Secret file to expose to the build (only if BuildKit enabled): id=mysecret,src=/local/secret",
              "args": {
                "name": "stringArray"
              }
            },
            {
              "names": [
                "--squash"
              ],
              "description": "Squash newly built layers into a single new layer"
            },
            {
              "names": [
                "--ssh"
              ],
              "description": "SSH agent socket or keys to expose to the build (only if BuildKit enabled) (format: default|<id>[=<socket>|<key>[,<key>]])",
              "args": {
                "name": "stringArray"
              }
            },
            {
              "names": [
                "-t",
                "--tag"
              ],
              "description": "Name and optionally a tag in the 'name:tag' format"
            },
            {
              "names": [
                "--target"
              ],
              "description": "Set the target build stage to build",
              "args": {
                "name": "target build stage"
              }
            }
          ],
          "args": [
            {
              "name": "path"
            }
          ]
        },
        {
          "name": "prune",
          "description": "Amount of disk space to keep for cache",
          "options": [
            {
              "names": [
                "-a",
                "--all"
              ],
              "description": "Remove all unused build cache, not just dangling ones"
            },
            {
              "names": [
                "--filter"
              ],
              "description": "Provide filter values (e.g. 'until=24h')",
              "args": {
                "name": "filter"
              }
            },
            {
              "names": [
                "-f",
                "--force"
              ],
              "description": "Do not prompt for confirmation"
            },
            {
              "names": [
                "--keep-storage"
              ],
              "description": "Amount of disk space to keep for cache",
              "args": {
                "name": "bytes"
              }
            }
          ]
        }
      ]
    },
    {
      "name": "config",
      "description": "Manage Docker configs",
      "subcommands": [
        {
          "name": "create",
          "description": "Create a config from a file or STDIN",
          "options": [
            {
              "names": [
                "-l"
              ],
              "description": "Config labels",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--template-driver"
              ],
              "description": "Template driver",
              "args": {
                "name": "string"
              }
            }
          ],
          "args": [
            {
              "name": "file"
            }
          ]
        },
        {
          "name": "inspect",
          "description": "Display detailed information on one or more configs",
          "options": [
            {
              "names": [
                "-f"
              ],
              "description": "Format the output using the given Go template",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--pretty"
              ],
              "description": "Print the information in a human friendly format"
            }
          ],
          "args": [
            {
              "name": "CONFIG",
              "isVariadic": true
            }
          ]
        },
        {
          "name": "ls",
          "description": "List configs",
          "options": [
            {
              "names": [
                "-f"
              ],
              "description": "Filter output based on conditions provided",
              "args": {
                "name": "filter"
              }
            },
            {
              "names": [
                "--format"
              ],
              "description": "Pretty-print configs using a Go template",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "Only display IDs"
            }
          ]
        },
        {
          "name": "rm",
          "description": "Remove one or more configs",
          "args": [
            {
              "name": "CONFIG",
              "isVariadic": true
            }
          ]
        }
      ]
    },
    {
      "name": "container",
      "description": "Manage containers",
      "subcommands": [
        {
          "name": "attach",
          "description": "Attach local standard input, output, and error streams to a running container,",
          "options": [
            {
              "names": [
                "--detach-keys"
              ],
              "description": "Override the key sequence for detaching a container",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--no-stdin"
              ],
              "description": "Do not attach STDIN"
            },
            {
              "names": [
                "--sig-proxy"
              ],
              "description": "Proxy all received signals to the process (default true)"
            }
          ]
        },
        {
          "name": "cp",
          "description": "Copy files/folders between a container and the local filesystem",
          "options": [
            {
              "names": [
                "-a",
                "--archive"
              ],
              "description": "Archive mode (copy all uid/gid information)"
            },
            {
              "names": [
                "-L",
                "--follow-link"
              ],
              "description": "Always follow symbol link in SRC_PATH"
            }
          ],
          "args": [
            {
              "name": "CONTAINER:SRC_PATH DEST_PATH|- OR SRC_PATH|- CONTAINER:DEST_PATH"
            }
          ]
        },
        {
          "name": "create",
          "description": "Create a new container",
          "options": [
            {
              "names": [
                "--add-host"
              ],
              "description": "Add a custom host-to-IP mapping (host:ip)",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "-a",
                "--attach"
              ],
              "description": "Attach to STDIN, STDOUT or STDERR",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--blkio-weight"
              ],
              "description": "Block IO (relative weight), between 10 and 1000, or 0 to disable (default 0)",
              "args": {
                "name": "uint16"
              }
            },
            {
              "names": [
                "--blkio-weight-device"
              ],
              "description": "Block IO weight (relative device weight) (default [])",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--cap-add"
              ],
              "description": "Add Linux capabilities",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--cap-drop"
              ],
              "description": "Drop Linux capabilities",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--cgroup-parent"
              ],
              "description": "Optional parent cgroup for the container",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--cgroupns"
              ],
              "description": "Cgroup namespace to use (host|private)",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--cidfile"
              ],
              "description": "Write the container ID to the file",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--cpu-period"
              ],
              "description": "Limit CPU CFS (Completely Fair Scheduler) period",
              "args": {
                "name": "int"
              }
            },
            {
              "names": [
                "--cpu-quota"
              ],
              "description": "Limit CPU CFS (Completely Fair Scheduler) quota",
              "args": {
                "name": "int"
              }
            },
            {
              "names": [
                "--cpu-rt-period"
              ],
              "description": "Limit CPU real-time period in microseconds",
              "args": {
                "name": "int"
              }
            },
            {
              "names": [
                "--cpu-rt-runtime"
              ],
              "description": "Limit CPU real-time runtime in microseconds",
              "args": {
                "name": "int"
              }
            },
            {
              "names": [
                "-c",
                "--cpu-shares"
              ],
              "description": "CPU shares (relative weight)",
              "args": {
                "name": "int"
              }
            },
            {
              "names": [
                "--cpus"
              ],
              "description": "Number of CPUs",
              "args": {
                "name": "decimal"
              }
            },
            {
              "names": [
                "--cpuset-cpus"
              ],
              "description": "CPUs in which to allow execution (0-3, 0,1)",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--cpuset-mems"
              ],
              "description": "MEMs in which to allow execution (0-3, 0,1)",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--device"
              ],
              "description": "Add a host device to the container",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--device-cgroup-rule"
              ],
              "description": "Add a rule to the cgroup allowed devices list",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--device-read-bps"
              ],
              "description": "Limit read rate (bytes per second) from a device (default [])",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--device-read-iops"
              ],
              "description": "Limit read rate (IO per second) from a device (default [])",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--device-write-bps"
              ],
              "description": "Limit write rate (bytes per second) to a device (default [])",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--device-write-iops"
              ],
              "description": "Limit write rate (IO per second) to a device (default [])",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--disable-content-trust"
              ],
              "description": "Skip image verification (default true)"
            },
            {
              "names": [
                "--dns"
              ],
              "description": "Set custom DNS servers",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--dns-option"
              ],
              "description": "Set DNS options",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--dns-search"
              ],
              "description": "Set custom DNS search domains",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--domainname"
              ],
              "description": "Container NIS domain name",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--entrypoint"
              ],
              "description": "Overwrite the default ENTRYPOINT of the image",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "-e",
                "--env"
              ],
              "description": "Set environment variables",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--env-file"
              ],
              "description": "Read in a file of environment variables",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--expose"
              ],
              "description": "Expose a port or a range of ports",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--gpus"
              ],
              "description": "GPU devices to add to the container ('all' to pass all GPUs)",
              "args": {
                "name": "gpu-request"
              }
            },
            {
              "names": [
                "--group-add"
              ],
              "description": "Add additional groups to join",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--health-cmd"
              ],
              "description": "Command to run to check health",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--health-interval"
              ],
              "description": "Time between running the check (ms|s|m|h) (default 0s)",
              "args": {
                "name": "duration"
              }
            },
            {
              "names": [
                "--health-retries"
              ],
              "description": "Consecutive failures needed to report unhealthy",
              "args": {
                "name": "int"
              }
            },
            {
              "names": [
                "--health-start-period"
              ],
              "description": "Start period for the container to initialize before starting health-retries countdown (ms|s|m|h) (default 0s)",
              "args": {
                "name": "duration"
              }
            },
            {
              "names": [
                "--health-timeout"
              ],
              "description": "Maximum time to allow one check to run (ms|s|m|h) (default 0s)",
              "args": {
                "name": "duration"
              }
            },
            {
              "names": [
                "--help"
              ],
              "description": "Print usage"
            },
            {
              "names": [
                "-h",
                "--hostname"
              ],
              "description": "Container host name",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--init"
              ],
              "description": "Run an init inside the container that forwards signals and reaps processes"
            },
            {
              "names": [
                "-i",
                "--interactive"
              ],
              "description": "Keep STDIN open even if not attached"
            },
            {
              "names": [
                "--ip"
              ],
              "description": "IPv4 address (e.g., 172.30.100.104)",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--ip6"
              ],
              "description": "IPv6 address (e.g., 2001:db8::33)",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--ipc"
              ],
              "description": "IPC mode to use",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--isolation"
              ],
              "description": "Container isolation technology",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--kernel-memory"
              ],
              "description": "Kernel memory limit",
              "args": {
                "name": "bytes"
              }
            },
            {
              "names": [
                "-l",
                "--label"
              ],
              "description": "Set meta data on a container",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--label-file"
              ],
              "description": "Read in a line delimited file of labels",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--link"
              ],
              "description": "Add link to another container",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--link-local-ip"
              ],
              "description": "Container IPv4/IPv6 link-local addresses",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--log-driver"
              ],
              "description": "Logging driver for the container",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--log-opt"
              ],
              "description": "Log driver options",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--mac-address"
              ],
              "description": "Container MAC address (e.g., 92:d0:c6:0a:29:33)",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "-m",
                "--memory"
              ],
              "description": "Memory limit",
              "args": {
                "name": "bytes"
              }
            },
            {
              "names": [
                "--memory-reservation"
              ],
              "description": "Memory soft limit",
              "args": {
                "name": "bytes"
              }
            },
            {
              "names": [
                "--memory-swap"
              ],
              "description": "Swap limit equal to memory plus swap: '-1' to enable unlimited swap",
              "args": {
                "name": "bytes"
              }
            },
            {
              "names": [
                "--memory-swappiness"
              ],
              "description": "Tune container memory swappiness (0 to 100) (default -1)",
              "args": {
                "name": "int"
              }
            },
            {
              "names": [
                "--mount"
              ],
              "description": "Attach a filesystem mount to the container",
              "args": {
                "name": "mount"
              }
            },
            {
              "names": [
                "--name"
              ],
              "description": "Assign a name to the container",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--network"
              ],
              "description": "Connect a container to a network",
              "args": {
                "name": "network"
              }
            },
            {
              "names": [
                "--network-alias"
              ],
              "description": "Add network-scoped alias for the container",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--no-healthcheck"
              ],
              "description": "Disable any container-specified HEALTHCHECK"
            },
            {
              "names": [
                "--oom-kill-disable"
              ],
              "description": "Disable OOM Killer"
            },
            {
              "names": [
                "--oom-score-adj"
              ],
              "description": "Tune host's OOM preferences (-1000 to 1000)",
              "args": {
                "name": "int"
              }
            },
            {
              "names": [
                "--pid"
              ],
              "description": "PID namespace to use",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--pids-limit"
              ],
              "description": "Tune container pids limit (set -1 for unlimited)",
              "args": {
                "name": "int"
              }
            },
            {
              "names": [
                "--platform"
              ],
              "description": "Set platform if server is multi-platform capable",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--privileged"
              ],
              "description": "Give extended privileges to this container"
            },
            {
              "names": [
                "-p",
                "--publish"
              ],
              "description": "Publish a container's port(s) to the host",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "-P",
                "--publish-all"
              ],
              "description": "Publish all exposed ports to random ports"
            },
            {
              "names": [
                "--pull"
              ],
              "description": "Pull image before creating (\"always\"|\"missing\"|\"never\") (default \"missing\")",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--read-only"
              ],
              "description": "Mount the container's root filesystem as read only"
            },
            {
              "names": [
                "--restart"
              ],
              "description": "Restart policy to apply when a container exits (default \"no\")",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--rm"
              ],
              "description": "Automatically remove the container when it exits"
            },
            {
              "names": [
                "--runtime"
              ],
              "description": "Runtime to use for this container",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--security-opt"
              ],
              "description": "Security Options",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--shm-size"
              ],
              "description": "Size of /dev/shm",
              "args": {
                "name": "bytes"
              }
            },
            {
              "names": [
                "--stop-signal"
              ],
              "description": "Signal to stop a container (default \"SIGTERM\")",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--stop-timeout"
              ],
              "description": "Timeout (in seconds) to stop a container",
              "args": {
                "name": "int"
              }
            },
            {
              "names": [
                "--storage-opt"
              ],
              "description": "Storage driver options for the container",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--sysctl"
              ],
              "description": "Sysctl options (default map[])",
              "args": {
                "name": "map"
              }
            },
            {
              "names": [
                "--tmpfs"
              ],
              "description": "Mount a tmpfs directory",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "-t",
                "--tty"
              ],
              "description": "Allocate a pseudo-TTY"
            },
            {
              "names": [
                "--ulimit"
              ],
              "description": "Ulimit options (default [])",
              "args": {
                "name": "ulimit"
              }
            },
            {
              "names": [
                "-u",
                "--user"
              ],
              "description": "Username or UID (format: <name|uid>[:<group|gid>])",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--userns"
              ],
              "description": "User namespace to use",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--uts"
              ],
              "description": "UTS namespace to use",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "-v",
                "--volume"
              ],
              "description": "Bind mount a volume",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--volume-driver"
              ],
              "description": "Optional volume driver for the container",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--volumes-from"
              ],
              "description": "Mount volumes from the specified container(s)",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "-w",
                "--workdir"
              ],
              "description": "Working directory inside the container",
              "args": {
                "name": "string"
              }
            }
          ],
          "args": [
            {
              "name": "container",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "image",
                    "ls",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            },
            {
              "name": "command"
            }
          ]
        },
        {
          "name": "diff",
          "description": "Inspect changes to files or directories on a container's filesystem",
          "args": [
            {
              "name": "container",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "ps",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "exec",
          "description": "Run a command in a running container",
          "options": [
            {
              "names": [
                "-it"
              ],
              "description": "Launch an interactive session"
            },
            {
              "names": [
                "-d",
                "--detach"
              ],
              "description": "Detached mode: run command in the background"
            },
            {
              "names": [
                "--detach-keys"
              ],
              "description": "Override the key sequence for detaching a container",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "-e",
                "--env"
              ],
              "description": "Set environment variables",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--env-file"
              ],
              "description": "Read in a file of environment variables",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "-i",
                "--interactive"
              ],
              "description": "Keep STDIN open even if not attached"
            },
            {
              "names": [
                "--privileged"
              ],
              "description": "Give extended privileges to the command"
            },
            {
              "names": [
                "-t",
                "--tty"
              ],
              "description": "Allocate a pseudo-TTY"
            },
            {
              "names": [
                "-u",
                "--user"
              ],
              "description": "Username or UID (format: <name|uid>[:<group|gid>])",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "-w",
                "--workdir"
              ],
              "description": "Working directory inside the container",
              "args": {
                "name": "string"
              }
            }
          ],
          "args": [
            {
              "name": "container",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "ps",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            },
            {
              "name": "command"
            }
          ]
        },
        {
          "name": "export",
          "description": "Export a container's filesystem as a tar archive",
          "options": [
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Write to a file, instead of STDOUT",
              "args": {
                "name": "string"
              }
            }
          ],
          "args": [
            {
              "name": "container",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "ps",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "inspect",
          "description": "Return low-level information on Docker objects",
          "options": [
            {
              "names": [
                "-f",
                "--format"
              ],
              "description": "Format the output using the given Go template",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "-s",
                "--size"
              ],
              "description": "Display total file sizes if the type is container"
            }
          ],
          "args": [
            {
              "name": "container",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "ps",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "kill",
          "description": "Kill one or more running containers",
          "options": [
            {
              "names": [
                "-s",
                "--signal"
              ],
              "description": "Signal to send to the container (default \"KILL\")",
              "args": {
                "name": "string"
              }
            }
          ],
          "args": [
            {
              "name": "container",
              "isVariadic": true,
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "ps",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "logs",
          "description": "Fetch the logs of a container",
          "options": [
            {
              "names": [
                "--details"
              ],
              "description": "Show extra details provided to logs"
            },
            {
              "names": [
                "-f",
                "--follow"
              ],
              "description": "Follow log output"
            },
            {
              "names": [
                "--since"
              ],
              "description": "Show logs since timestamp (e.g. 2013-01-02T13:23:37Z) or relative (e.g. 42m for 42 minutes)",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "-n",
                "--tail"
              ],
              "description": "Number of lines to show from the end of the logs (default \"all\")",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "-t",
                "--timestamps"
              ],
              "description": "Show timestamps"
            },
            {
              "names": [
                "--until"
              ],
              "description": "Show logs before a timestamp (e.g. 2013-01-02T13:23:37Z) or relative (e.g. 42m for 42 minutes)",
              "args": {
                "name": "string"
              }
            }
          ],
          "args": [
            {
              "name": "container",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "ps",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "ls",
          "description": "List containers",
          "options": [
            {
              "names": [
                "-a",
                "--all"
              ],
              "description": "Show all containers (default shows just running)"
            },
            {
              "names": [
                "-f",
                "--filter"
              ],
              "description": "Filter output based on conditions provided",
              "args": {
                "name": "filter"
              }
            },
            {
              "names": [
                "--format"
              ],
              "description": "Pretty-print containers using a Go template",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "-n",
                "--last"
              ],
              "description": "Show n last created containers (includes all states) (default -1)",
              "args": {
                "name": "int"
              }
            },
            {
              "names": [
                "-l",
                "--latest"
              ],
              "description": "Show the latest created container (includes all states)"
            },
            {
              "names": [
                "--no-trunc"
              ],
              "description": "Don't truncate output"
            },
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "Only display container IDs"
            },
            {
              "names": [
                "-s",
                "--size"
              ],
              "description": "Display total file sizes"
            }
          ]
        },
        {
          "name": "pause",
          "description": "Pause all processes within one or more containers",
          "args": [
            {
              "name": "container",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "ps",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "port",
          "description": "List port mappings or a specific mapping for the container",
          "args": [
            {
              "name": "container",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "ps",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            },
            {
              "name": "[PRIVATE_PORT[/PROTO]]"
            }
          ]
        },
        {
          "name": "prune",
          "description": "Remove all stopped containers",
          "options": [
            {
              "names": [
                "--filter"
              ],
              "description": "Provide filter values (e.g. 'until=<timestamp>')",
              "args": {
                "name": "filter"
              }
            },
            {
              "names": [
                "-f",
                "--force"
              ],
              "description": "Do not prompt for confirmation"
            }
          ]
        },
        {
          "name": "rename",
          "description": "Rename a container",
          "args": [
            {
              "name": "container",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "ps",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            },
            {
              "name": "NEW_NAME"
            }
          ]
        },
        {
          "name": "restart",
          "description": "Restart one or more containers",
          "options": [
            {
              "names": [
                "-t",
                "--time"
              ],
              "description": "Seconds to wait for stop before killing the container (default 10)",
              "args": {
                "name": "int"
              }
            }
          ],
          "args": [
            {
              "name": "container",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "ps",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "rm",
          "description": "Remove one or more containers",
          "options": [
            {
              "names": [
                "-f",
                "--force"
              ],
              "description": "Force the removal of a running container (uses SIGKILL)"
            },
            {
              "names": [
                "-l",
                "--link"
              ],
              "description": "Remove the specified link"
            },
            {
              "names": [
                "-v",
                "--volumes"
              ],
              "description": "Remove the anonymous volumes associated with the container"
            }
          ],
          "args": [
            {
              "name": "containers",
              "isVariadic": true,
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "ps",
                    "-a",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "run",
          "description": "Run a command in a new container",
          "options": [
            {
              "names": [
                "-it"
              ],
              "description": "Launch an interactive session"
            },
            {
              "names": [
                "--add-host"
              ],
              "description": "Add a custom host-to-IP mapping (host:ip)",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "-a",
                "--attach"
              ],
              "description": "Attach to STDIN, STDOUT or STDERR",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--blkio-weight"
              ],
              "description": "Block IO (relative weight), between 10 and 1000, or 0 to disable (default 0)",
              "args": {
                "name": "uint16"
              }
            },
            {
              "names": [
                "--blkio-weight-device"
              ],
              "description": "Block IO weight (relative device weight) (default [])",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--cap-add"
              ],
              "description": "Add Linux capabilities",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--cap-drop"
              ],
              "description": "Drop Linux capabilities",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--cgroup-parent"
              ],
              "description": "Optional parent cgroup for the container",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--cgroupns"
              ],
              "description": "Cgroup namespace to use (host|private)\n'host':    Run the container in the Docker host's cgroup namespace\n'private': Run the container in its own private cgroup namespace\n'':        Use the cgroup namespace as configured by the\ndefault-cgroupns-mode option on the daemon (default)",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--cidfile"
              ],
              "description": "Write the container ID to the file",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--cpu-period"
              ],
              "description": "Limit CPU CFS (Completely Fair Scheduler) period",
              "args": {
                "name": "int"
              }
            },
            {
              "names": [
                "--cpu-quota"
              ],
              "description": "Limit CPU CFS (Completely Fair Scheduler) quota",
              "args": {
                "name": "int"
              }
            },
            {
              "names": [
                "--cpu-rt-period"
              ],
              "description": "Limit CPU real-time period in microseconds",
              "args": {
                "name": "int"
              }
            },
            {
              "names": [
                "--cpu-rt-runtime"
              ],
              "description": "Limit CPU real-time runtime in microseconds",
              "args": {
                "name": "int"
              }
            },
            {
              "names": [
                "-c",
                "--cpu-shares"
              ],
              "description": "CPU shares (relative weight)",
              "args": {
                "name": "int"
              }
            },
            {
              "names": [
                "--cpus"
              ],
              "description": "Number of CPUs",
              "args": {
                "name": "decimal"
              }
            },
            {
              "names": [
                "--cpuset-cpus"
              ],
              "description": "CPUs in which to allow execution (0-3, 0,1)",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--cpuset-mems"
              ],
              "description": "MEMs in which to allow execution (0-3, 0,1)",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "-d",
                "--detach"
              ],
              "description": "Run container in background and print container ID"
            },
            {
              "names": [
                "--detach-keys"
              ],
              "description": "Override the key sequence for detaching a container",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--device"
              ],
              "description": "Add a host device to the container",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--device-cgroup-rule"
              ],
              "description": "Add a rule to the cgroup allowed devices list",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--device-read-bps"
              ],
              "description": "Limit read rate (bytes per second) from a device (default [])",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--device-read-iops"
              ],
              "description": "Limit read rate (IO per second) from a device (default [])",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--device-write-bps"
              ],
              "description": "Limit write rate (bytes per second) to a device (default [])",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--device-write-iops"
              ],
              "description": "Limit write rate (IO per second) to a device (default [])",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--disable-content-trust"
              ],
              "description": "Skip image verification (default true)"
            },
            {
              "names": [
                "--dns"
              ],
              "description": "Set custom DNS servers",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--dns-option"
              ],
              "description": "Set DNS options",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--dns-search"
              ],
              "description": "Set custom DNS search domains",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--domainname"
              ],
              "description": "Container NIS domain name",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--entrypoint"
              ],
              "description": "Overwrite the default ENTRYPOINT of the image",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "-e",
                "--env"
              ],
              "description": "Set environment variables",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--env-file"
              ],
              "description": "Read in a file of environment variables",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--expose"
              ],
              "description": "Expose a port or a range of ports",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--gpus"
              ],
              "description": "GPU devices to add to the container ('all' to pass all GPUs)",
              "args": {
                "name": "gpu-request"
              }
            },
            {
              "names": [
                "--group-add"
              ],
              "description": "Add additional groups to join",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--health-cmd"
              ],
              "description": "Command to run to check health",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--health-interval"
              ],
              "description": "Time between running the check (ms|s|m|h) (default 0s)",
              "args": {
                "name": "duration"
              }
            },
            {
              "names": [
                "--health-retries"
              ],
              "description": "Consecutive failures needed to report unhealthy",
              "args": {
                "name": "int"
              }
            },
            {
              "names": [
                "--health-start-period"
              ],
              "description": "Start period for the container to initialize before starting health-retries countdown (ms|s|m|h) (default 0s)",
              "args": {
                "name": "duration"
              }
            },
            {
              "names": [
                "--health-timeout"
              ],
              "description": "Maximum time to allow one check to run (ms|s|m|h) (default 0s)",
              "args": {
                "name": "duration"
              }
            },
            {
              "names": [
                "--help"
              ],
              "description": "Print usage"
            },
            {
              "names": [
                "-h",
                "--hostname"
              ],
              "description": "Container host name",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--init"
              ],
              "description": "Run an init inside the container that forwards signals and reaps processes"
            },
            {
              "names": [
                "-i",
                "--interactive"
              ],
              "description": "Keep STDIN open even if not attached"
            },
            {
              "names": [
                "--ip"
              ],
              "description": "IPv4 address (e.g., 172.30.100.104)",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--ip6"
              ],
              "description": "IPv6 address (e.g., 2001:db8::33)",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--ipc"
              ],
              "description": "IPC mode to use",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--isolation"
              ],
              "description": "Container isolation technology",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--kernel-memory"
              ],
              "description": "Kernel memory limit",
              "args": {
                "name": "bytes"
              }
            },
            {
              "names": [
                "-l",
                "--label"
              ],
              "description": "Set meta data on a container",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--label-file"
              ],
              "description": "Read in a line delimited file of labels",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--link"
              ],
              "description": "Add link to another container",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--link-local-ip"
              ],
              "description": "Container IPv4/IPv6 link-local addresses",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--log-driver"
              ],
              "description": "Logging driver for the container",
              "args": {
                "name": "string",
                "suggestions": [
                  "json-file",
                  "syslog",
                  "journald",
                  "gelf",
                  "fluentd",
                  "awslogs",
                  "splunk",
                  "etwlogs",
                  "gcplogs",
                  "none"
                ]
              }
            },
            {
              "names": [
                "--log-opt"
              ],
              "description": "Log driver options",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--mac-address"
              ],
              "description": "Container MAC address (e.g., 92:d0:c6:0a:29:33)",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "-m",
                "--memory"
              ],
              "description": "Memory limit",
              "args": {
                "name": "bytes"
              }
            },
            {
              "names": [
                "--memory-reservation"
              ],
              "description": "Memory soft limit",
              "args": {
                "name": "bytes"
              }
            },
            {
              "names": [
                "--memory-swap"
              ],
              "description": "Swap limit equal to memory plus swap: '-1' to enable unlimited swap",
              "args": {
                "name": "bytes"
              }
            },
            {
              "names": [
                "--memory-swappiness"
              ],
              "description": "Tune container memory swappiness (0 to 100) (default -1)",
              "args": {
                "name": "int"
              }
            },
            {
              "names": [
                "--mount"
              ],
              "description": "Attach a filesystem mount to the container",
              "args": {
                "name": "mount"
              }
            },
            {
              "names": [
                "--name"
              ],
              "description": "Assign a name to the container",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--network"
              ],
              "description": "Connect a container to a network",
              "args": {
                "name": "network"
              }
            },
            {
              "names": [
                "--network-alias"
              ],
              "description": "Add network-scoped alias for the container",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--no-healthcheck"
              ],
              "description": "Disable any container-specified HEALTHCHECK"
            },
            {
              "names": [
                "--oom-kill-disable"
              ],
              "description": "Disable OOM Killer"
            },
            {
              "names": [
                "--oom-score-adj"
              ],
              "description": "Tune host's OOM preferences (-1000 to 1000)",
              "args": {
                "name": "int"
              }
            },
            {
              "names": [
                "--pid"
              ],
              "description": "PID namespace to use",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--pids-limit"
              ],
              "description": "Tune container pids limit (set -1 for unlimited)",
              "args": {
                "name": "int"
              }
            },
            {
              "names": [
                "--platform"
              ],
              "description": "Set platform if server is multi-platform capable",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--privileged"
              ],
              "description": "Give extended privileges to this container"
            },
            {
              "names": [
                "-p",
                "--publish"
              ],
              "description": "Publish a container's port(s) to the host",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "-P",
                "--publish-all"
              ],
              "description": "Publish all exposed ports to random ports"
            },
            {
              "names": [
                "--pull"
              ],
              "description": "Pull image before running ('always'|'missing'|'never') (default 'missing')",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--read-only"
              ],
              "description": "Mount the container's root filesystem as read only"
            },
            {
              "names": [
                "--restart"
              ],
              "description": "Restart policy to apply when a container exits (default 'no')",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--rm"
              ],
              "description": "Automatically remove the container when it exits"
            },
            {
              "names": [
                "--runtime"
              ],
              "description": "Runtime to use for this container",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--security-opt"
              ],
              "description": "Security Options",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--shm-size"
              ],
              "description": "Size of /dev/shm",
              "args": {
                "name": "bytes"
              }
            },
            {
              "names": [
                "--sig-proxy"
              ],
              "description": "Proxy received signals to the process (default true)"
            },
            {
              "names": [
                "--stop-signal"
              ],
              "description": "Signal to stop a container (default 'SIGTERM')",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--stop-timeout"
              ],
              "description": "Timeout (in seconds) to stop a container",
              "args": {
                "name": "int"
              }
            },
            {
              "names": [
                "--storage-opt"
              ],
              "description": "Storage driver options for the container",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--sysctl"
              ],
              "description": "Sysctl options (default map[])",
              "args": {
                "name": "map"
              }
            },
            {
              "names": [
                "--tmpfs"
              ],
              "description": "Mount a tmpfs directory",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "-t",
                "--tty"
              ],
              "description": "Allocate a pseudo-TTY"
            },
            {
              "names": [
                "--ulimit"
              ],
              "description": "Ulimit options (default [])",
              "args": {
                "name": "ulimit"
              }
            },
            {
              "names": [
                "-u",
                "--user"
              ],
              "description": "Username or UID (format: <name|uid>[:<group|gid>])",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--userns"
              ],
              "description": "User namespace to use",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--uts"
              ],
              "description": "UTS namespace to use",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "-v",
                "--volume"
              ],
              "description": "Bind mount a volume",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--volume-driver"
              ],
              "description": "Optional volume driver for the container",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--volumes-from"
              ],
              "description": "Mount volumes from the specified container(s)",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "-w",
                "--workdir"
              ],
              "description": "Working directory inside the container",
              "args": {
                "name": "string"
              }
            }
          ],
          "args": [
            {
              "name": "image",
              "description": "The Docker image to use",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "images",
                    "--format",
                    "{{.Repository}} {{.Size}} {{.Tag}} {{.ID}}"
                  ]
                }
              ]
            },
            {
              "name": "command"
            }
          ]
        },
        {
          "name": "start",
          "description": "Start one or more stopped containers",
          "options": [
            {
              "names": [
                "-a",
                "--attach"
              ],
              "description": "Attach STDOUT/STDERR and forward signals"
            },
            {
              "names": [
                "--detach-keys"
              ],
              "description": "Override the key sequence for detaching a container",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "-i",
                "--interactive"
              ],
              "description": "Attach container's STDIN"
            }
          ],
          "args": [
            {
              "name": "container",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "ps",
                    "-a",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "stats",
          "description": "Display a live stream of container(s) resource usage statistics",
          "options": [
            {
              "names": [
                "-a",
                "--all"
              ],
              "description": "Show all containers (default shows just running)"
            },
            {
              "names": [
                "--format"
              ],
              "description": "Pretty-print images using a Go template",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--no-stream"
              ],
              "description": "Disable streaming stats and only pull the first result"
            },
            {
              "names": [
                "--no-trunc"
              ],
              "description": "Do not truncate output"
            }
          ],
          "args": [
            {
              "name": "container",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "ps",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "stop",
          "description": "Stop one or more running containers",
          "options": [
            {
              "names": [
                "-t",
                "--t"
              ],
              "description": "Seconds to wait for stop before killing it (default 10)",
              "args": {
                "name": "int"
              }
            }
          ],
          "args": [
            {
              "name": "container",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "ps",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "top",
          "description": "Display the running processes of a container",
          "args": [
            {
              "name": "container",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "ps",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "unpause",
          "description": "Unpause all processes within one or more containers",
          "args": [
            {
              "name": "container",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "ps",
                    "--filter",
                    "status=paused",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "update",
          "description": "Update configuration of one or more containers",
          "options": [
            {
              "names": [
                "--blkio-weight"
              ],
              "description": "Block IO (relative weight), between 10 and 1000, or 0 to disable (default 0)",
              "args": {
                "name": "uint16"
              }
            },
            {
              "names": [
                "--cpu-period"
              ],
              "description": "Limit CPU CFS (Completely Fair Scheduler) period",
              "args": {
                "name": "int"
              }
            },
            {
              "names": [
                "--cpu-quota"
              ],
              "description": "Limit CPU CFS (Completely Fair Scheduler) quota",
              "args": {
                "name": "int"
              }
            },
            {
              "names": [
                "--cpu-rt-period"
              ],
              "description": "Limit the CPU real-time period in microseconds",
              "args": {
                "name": "int"
              }
            },
            {
              "names": [
                "--cpu-rt-runtime"
              ],
              "description": "Limit the CPU real-time runtime in microseconds",
              "args": {
                "name": "int"
              }
            },
            {
              "names": [
                "-c",
                "--cpu-shares"
              ],
              "description": "CPU shares (relative weight)",
              "args": {
                "name": "int"
              }
            },
            {
              "names": [
                "--cpus"
              ],
              "description": "Number of CPUs",
              "args": {
                "name": "decimal"
              }
            },
            {
              "names": [
                "--cpuset-cpus"
              ],
              "description": "CPUs in which to allow execution (0-3, 0,1)",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--cpuset-mems"
              ],
              "description": "MEMs in which to allow execution (0-3, 0,1)",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--kernel-memory"
              ],
              "description": "Kernel memory limit",
              "args": {
                "name": "bytes"
              }
            },
            {
              "names": [
                "-m",
                "--memory"
              ],
              "description": "Memory limit",
              "args": {
                "name": "bytes"
              }
            },
            {
              "names": [
                "--memory-reservation"
              ],
              "description": "Memory soft limit",
              "args": {
                "name": "bytes"
              }
            },
            {
              "names": [
                "--memory-swap"
              ],
              "description": "Swap limit equal to memory plus swap: '-1' to enable unlimited swap",
              "args": {
                "name": "bytes"
              }
            },
            {
              "names": [
                "--pids-limit"
              ],
              "description": "Tune container pids limit (set -1 for unlimited)",
              "args": {
                "name": "int"
              }
            },
            {
              "names": [
                "--restart"
              ],
              "description": "Restart policy to apply when a container exits",
              "args": {
                "name": "string"
              }
            }
          ],
          "args": [
            {
              "name": "container",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "ps",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "wait",
          "description": "Block until one or more containers stop, then print their exit codes",
          "args": [
            {
              "name": "container",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "ps",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "context",
      "description": "Manage contexts",
      "subcommands": [
        {
          "name": "create",
          "description": "Create new context",
          "subcommands": [
            {
              "name": "aci",
              "description": "Create a context for Azure Container Instances",
              "options": [
                {
                  "names": [
                    "--description"
                  ],
                  "description": "Description of the context",
                  "args": {
                    "name": "string"
                  }
                },
                {
                  "names": [
                    "-h",
                    "--help"
                  ],
                  "description": "Help for aci"
                },
                {
                  "names": [
                    "--location"
                  ],
                  "description": "Location (default \"eastus\")",
                  "args": {
                    "name": "string"
                  }
                },
                {
                  "names": [
                    "--resource-group"
                  ],
                  "description": "Resource group",
                  "args": {
                    "name": "string"
                  }
                },
                {
                  "names": [
                    "--subscription-id"
                  ],
                  "description": "Location",
                  "args": {
                    "name": "string"
                  }
                }
              ],
              "args": [
                {
                  "name": "CONTEXT"
                }
              ]
            },
            {
              "name": "ecs",
              "description": "Create a context for Amazon ECS",
              "options": [
                {
                  "names": [
                    "--access-keys"
                  ],
                  "description": "Use AWS access keys from file",
                  "args": {
                    "name": "string"
                  }
                },
                {
                  "names": [
                    "--description"
                  ],
                  "description": "Description of the context",
                  "args": {
                    "name": "string"
                  }
                },
                {
                  "names": [
                    "--from-env"
                  ],
                  "description": "Use AWS environment variables for profile, or credentials and region"
                },
                {
                  "names": [
                    "-h",
                    "--help"
                  ],
                  "description": "Help for ecs"
                },
                {
                  "names": [
                    "--local-simulation"
                  ],
                  "description": "Create context for ECS local simulation endpoints"
                },
                {
                  "names": [
                    "--profile"
                  ],
                  "description": "Use an existing AWS profile",
                  "args": {
                    "name": "string"
                  }
                }
              ],
              "args": [
                {
                  "name": "CONTEXT"
                }
              ]
            }
          ],
          "options": [
            {
              "names": [
                "--default-stack-orchestrator"
              ],
              "description": "Default orchestrator for stack operations to use with this context (swarm|kubernetes|all)",
              "args": {
                "name": "string",
                "suggestions": [
                  "swarm",
                  "kubernetes",
                  "all"
                ]
              }
            },
            {
              "names": [
                "--description"
              ],
              "description": "Description of the context",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--docker"
              ],
              "description": "Set the docker endpoint (default [])",
              "args": {
                "name": "stringToString"
              }
            },
            {
              "names": [
                "--from"
              ],
              "description": "Create context from a named context",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "-h",
                "--help"
              ],
              "description": "Help for create"
            },
            {
              "names": [
                "--kubernetes"
              ],
              "description": "Set the kubernetes endpoint (default [])",
              "args": {
                "name": "stringToString"
              }
            }
          ]
        },
        {
          "name": "export",
          "description": "Export a context to a tar or kubeconfig file",
          "options": [
            {
              "names": [
                "-h",
                "--help"
              ],
              "description": "Help for export"
            },
            {
              "names": [
                "--kubeconfig"
              ],
              "description": "Export as a kubeconfig file"
            }
          ],
          "args": [
            {
              "name": "CONTEXT",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "context",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            },
            {
              "name": "FILE"
            }
          ]
        },
        {
          "name": "import",
          "description": "Import a context from a tar or zip file",
          "options": [
            {
              "names": [
                "-h",
                "--help"
              ],
              "description": "Help for export"
            }
          ],
          "args": [
            {
              "name": "CONTEXT"
            },
            {
              "name": "FILE"
            }
          ]
        },
        {
          "name": "inspect",
          "description": "Display detailed information on one or more contexts",
          "options": [
            {
              "names": [
                "-f"
              ],
              "description": "Format the output using the given Go template",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "-h",
                "--help"
              ],
              "description": "Help for inspect"
            }
          ],
          "args": [
            {
              "name": "CONTEXT",
              "isVariadic": true,
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "context",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "list",
          "description": "List available contexts",
          "options": [
            {
              "names": [
                "--format"
              ],
              "description": "Format the output. Values: [pretty | json]. (Default: pretty)",
              "args": {
                "name": "string",
                "suggestions": [
                  "pretty",
                  "json"
                ]
              }
            },
            {
              "names": [
                "-h",
                "--help"
              ],
              "description": "Help for list"
            },
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "Only show context names"
            }
          ]
        },
        {
          "name": "rm",
          "description": "Remove one or more contexts",
          "options": [
            {
              "names": [
                "-f",
                "--force"
              ],
              "description": "Force removing current context"
            },
            {
              "names": [
                "-h",
                "--help"
              ],
              "description": "Help for rm"
            }
          ],
          "args": [
            {
              "name": "CONTEXT",
              "isVariadic": true,
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "context",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "show",
          "description": "Print the current context",
          "options": [
            {
              "names": [
                "-h",
                "--help"
              ],
              "description": "Help for show"
            }
          ]
        },
        {
          "name": "update",
          "description": "Update a context",
          "options": [
            {
              "names": [
                "--default-stack-orchestrator"
              ],
              "description": "Default orchestrator for stack operations to use with this context (swarm|kubernetes|all)",
              "args": {
                "name": "string",
                "suggestions": [
                  "swarm",
                  "kubernetes",
                  "all"
                ]
              }
            },
            {
              "names": [
                "--description"
              ],
              "description": "Description of the context",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--docker"
              ],
              "description": "Set the docker endpoint (default [])",
              "args": {
                "name": "stringToString"
              }
            },
            {
              "names": [
                "-h",
                "--help"
              ],
              "description": "Help for update"
            },
            {
              "names": [
                "--kubernetes"
              ],
              "description": "Set the kubernetes endpoint (default [])",
              "args": {
                "name": "stringToString"
              }
            }
          ],
          "args": [
            {
              "name": "CONTEXT",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "context",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "use",
          "description": "Set the default context",
          "options": [
            {
              "names": [
                "-h",
                "--help"
              ],
              "description": "Help for use"
            }
          ],
          "args": [
            {
              "name": "CONTEXT",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "context",
                    "list",
                    "--format",
                    "{{ json . }}"
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
            "-h",
            "--help"
          ],
          "description": "Help for context"
        }
      ]
    },
    {
      "name": "image",
      "description": "Manage images",
      "subcommands": [
        {
          "name": "build",
          "description": "Build an image from a Dockerfile",
          "options": [
            {
              "names": [
                "--add-host"
              ],
              "args": {
                "name": "list",
                "description": "Add a custom host-to-IP mapping (host:ip)"
              }
            },
            {
              "names": [
                "--build-arg"
              ],
              "args": {
                "name": "list",
                "description": "Set build-time variables"
              }
            },
            {
              "names": [
                "--cache-from"
              ],
              "args": {
                "name": "strings",
                "description": "Images to consider as cache sources"
              }
            },
            {
              "names": [
                "--disable-content-trust"
              ],
              "description": "Skip image verification (default true)"
            },
            {
              "names": [
                "-f",
                "--file"
              ],
              "description": "Name of the Dockerfile (Default is 'PATH/Dockerfile')",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--iidfile"
              ],
              "description": "Write the image ID to the file",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--isolation"
              ],
              "description": "Container isolation technology",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--label"
              ],
              "description": "Set metadata for an image",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--network"
              ],
              "description": "Set the networking mode for the RUN instructions during build (default \"default\")",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--no-cache"
              ],
              "description": "Do not use cache when building the image"
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output destination (format: type=local,dest=path)",
              "args": {
                "name": "stringArray"
              }
            },
            {
              "names": [
                "--platform"
              ],
              "description": "Set platform if server is multi-platform capable",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--progress"
              ],
              "description": "Set type of progress output (auto, plain, tty). Use plain to show container output",
              "args": {
                "name": "string",
                "suggestions": [
                  "auto",
                  "plain",
                  "tty"
                ]
              }
            },
            {
              "names": [
                "--pull"
              ],
              "description": "Always attempt to pull a newer version of the image"
            },
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "Suppress the build output and print image ID on success"
            },
            {
              "names": [
                "--secret"
              ],
              "description": "Secret file to expose to the build (only if BuildKit enabled): id=mysecret,src=/local/secret",
              "args": {
                "name": "stringArray"
              }
            },
            {
              "names": [
                "--squash"
              ],
              "description": "Squash newly built layers into a single new layer"
            },
            {
              "names": [
                "--ssh"
              ],
              "description": "SSH agent socket or keys to expose to the build (only if BuildKit enabled) (format: default|<id>[=<socket>|<key>[,<key>]])",
              "args": {
                "name": "stringArray"
              }
            },
            {
              "names": [
                "-t",
                "--tag"
              ],
              "description": "Name and optionally a tag in the 'name:tag' format"
            },
            {
              "names": [
                "--target"
              ],
              "description": "Set the target build stage to build",
              "args": {
                "name": "target build stage"
              }
            }
          ],
          "args": [
            {
              "name": "path"
            }
          ]
        },
        {
          "name": "history",
          "description": "Show the history of an image",
          "options": [
            {
              "names": [
                "--format"
              ],
              "description": "Pretty-print images using a Go template",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "-H",
                "--human"
              ],
              "description": "Print sizes and dates in human readable format (default true)"
            },
            {
              "names": [
                "--no-trunc"
              ],
              "description": "Don't truncate output"
            },
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "Only show image IDs"
            }
          ],
          "args": [
            {
              "name": "image",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "image",
                    "ls",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "import",
          "description": "Import the contents from a tarball to create a filesystem image",
          "options": [
            {
              "names": [
                "-c",
                "--change"
              ],
              "description": "Apply Dockerfile instruction to the created image",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "-m",
                "--message"
              ],
              "description": "Set commit message for imported image",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--platform"
              ],
              "description": "Set platform if server is multi-platform capable",
              "args": {
                "name": "string"
              }
            }
          ],
          "args": [
            {
              "name": "file|URL|- [REPOSITORY[:TAG]]"
            }
          ]
        },
        {
          "name": "inspect",
          "description": "Display detailed information on one or more images",
          "options": [
            {
              "names": [
                "-f"
              ],
              "description": "Format the output using the given Go template",
              "args": {
                "name": "string"
              }
            }
          ],
          "args": [
            {
              "name": "image",
              "isVariadic": true,
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "image",
                    "ls",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "load",
          "description": "Load an image from a tar archive or STDIN",
          "options": [
            {
              "names": [
                "-i"
              ],
              "description": "Read from tar archive file, instead of STDIN",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "Suppress the load output"
            }
          ]
        },
        {
          "name": "ls",
          "description": "List images",
          "options": [
            {
              "names": [
                "-a",
                "--all"
              ],
              "description": "Show all images (default hides intermediate images)"
            },
            {
              "names": [
                "--digests"
              ],
              "description": "Show digests"
            },
            {
              "names": [
                "-f",
                "--filter"
              ],
              "description": "Filter output based on conditions provided",
              "args": {
                "name": "filter"
              }
            },
            {
              "names": [
                "--format"
              ],
              "description": "Pretty-print images using a Go template",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--no-trunc"
              ],
              "description": "Don't truncate output"
            },
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "Only show image IDs"
            }
          ],
          "args": [
            {
              "name": "[REPOSITORY[:TAG]]"
            }
          ]
        },
        {
          "name": "prune",
          "description": "Remove unused images",
          "options": [
            {
              "names": [
                "-a",
                "--all"
              ],
              "description": "Remove all unused images, not just dangling ones"
            },
            {
              "names": [
                "--filter"
              ],
              "description": "Provide filter values (e.g. 'until=<timestamp>')",
              "args": {
                "name": "filter"
              }
            },
            {
              "names": [
                "-f",
                "--force"
              ],
              "description": "Do not prompt for confirmation"
            }
          ]
        },
        {
          "name": "pull",
          "description": "Pull an image or a repository from a registry",
          "options": [
            {
              "names": [
                "-a",
                "--all-tags"
              ],
              "description": "Download all tagged images in the repository"
            },
            {
              "names": [
                "--disable-content-trust"
              ],
              "description": "Skip image verification (default true)"
            },
            {
              "names": [
                "--platform"
              ],
              "description": "Set platform if server is multi-platform capable",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "Suppress verbose output"
            }
          ],
          "args": [
            {
              "name": "NAME[:TAG|@DIGEST]"
            }
          ]
        },
        {
          "name": "push",
          "description": "Push an image or a repository to a registry",
          "options": [
            {
              "names": [
                "-a",
                "--all-tags"
              ],
              "description": "Push all tagged images in the repository"
            },
            {
              "names": [
                "--disable-content-trust"
              ],
              "description": "Skip image signing (default true)"
            },
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "Suppress verbose output"
            }
          ],
          "args": [
            {
              "name": "NAME[:TAG]"
            }
          ]
        },
        {
          "name": "rm",
          "description": "Remove one or more images",
          "options": [
            {
              "names": [
                "-f",
                "--force"
              ],
              "description": "Force removal of the image"
            },
            {
              "names": [
                "--no-prune"
              ],
              "description": "Do not delete untagged parents"
            }
          ],
          "args": [
            {
              "name": "image",
              "isVariadic": true,
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "image",
                    "ls",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "save",
          "description": "Save one or more images to a tar archive (streamed to STDOUT by default)",
          "options": [
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Write to a file, instead of STDOUT",
              "args": {
                "name": "string"
              }
            }
          ],
          "args": [
            {
              "name": "image",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "image",
                    "ls",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "tag",
          "description": "Create a tag TARGET_IMAGE that refers to SOURCE_IMAGE",
          "args": [
            {
              "name": "SOURCE_IMAGE[:TAG] TARGET_IMAGE[:TAG]"
            }
          ]
        }
      ]
    },
    {
      "name": "network",
      "description": "Manage networks",
      "subcommands": [
        {
          "name": "connect",
          "description": "Connect a container to a network",
          "options": [
            {
              "names": [
                "--alias"
              ],
              "description": "Add network-scoped alias for the container",
              "args": {
                "name": "strings"
              }
            },
            {
              "names": [
                "--driver-opt"
              ],
              "description": "Driver options for the network",
              "args": {
                "name": "strings"
              }
            },
            {
              "names": [
                "--ip"
              ],
              "description": "IPv4 address (e.g., 172.30.100.104)",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--ip6"
              ],
              "description": "IPv6 address (e.g., 2001:db8::33)",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--link"
              ],
              "description": "Add link to another container",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--link-local-ip"
              ],
              "description": "Add a link-local address for the container",
              "args": {
                "name": "strings"
              }
            }
          ],
          "args": [
            {
              "name": "NETWORK",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "network",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            },
            {
              "name": "container",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "ps",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "create",
          "description": "Create a network",
          "options": [
            {
              "names": [
                "--attachable"
              ],
              "description": "Enable manual container attachment"
            },
            {
              "names": [
                "--aux-address"
              ],
              "description": "Auxiliary IPv4 or IPv6 addresses used by Network driver (default map[])",
              "args": {
                "name": "map"
              }
            },
            {
              "names": [
                "--config-from"
              ],
              "description": "The network from which to copy the configuration",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--config-only"
              ],
              "description": "Create a configuration only network"
            },
            {
              "names": [
                "-d",
                "--driver"
              ],
              "description": "Driver to manage the Network (default \"bridge\")",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--gateway"
              ],
              "description": "IPv4 or IPv6 Gateway for the master subnet",
              "args": {
                "name": "strings"
              }
            },
            {
              "names": [
                "--ingress"
              ],
              "description": "Create swarm routing-mesh network"
            },
            {
              "names": [
                "--internal"
              ],
              "description": "Restrict external access to the network"
            },
            {
              "names": [
                "--ip-range"
              ],
              "description": "Allocate container ip from a sub-range",
              "args": {
                "name": "strings"
              }
            },
            {
              "names": [
                "--ipam-driver"
              ],
              "description": "IP Address Management Driver (default \"default\")",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--ipam-opt"
              ],
              "description": "Set IPAM driver specific options (default map[])",
              "args": {
                "name": "map"
              }
            },
            {
              "names": [
                "--ipv6"
              ],
              "description": "Enable IPv6 networking"
            },
            {
              "names": [
                "--label"
              ],
              "description": "Set metadata on a network",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "-o",
                "--opt"
              ],
              "description": "Set driver specific options (default map[])",
              "args": {
                "name": "map"
              }
            },
            {
              "names": [
                "--scope"
              ],
              "description": "Control the network's scope",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--subnet"
              ],
              "description": "Subnet in CIDR format that represents a network segment",
              "args": {
                "name": "strings"
              }
            }
          ],
          "args": [
            {
              "name": "NETWORK"
            }
          ]
        },
        {
          "name": "disconnect",
          "description": "Disconnect a container from a network",
          "options": [
            {
              "names": [
                "-f",
                "--force"
              ],
              "description": "Force the container to disconnect from a network"
            }
          ],
          "args": [
            {
              "name": "NETWORK",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "network",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            },
            {
              "name": "container",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "ps",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "inspect",
          "description": "Display detailed information on one or more networks",
          "options": [
            {
              "names": [
                "-f",
                "--format"
              ],
              "description": "Format the output using the given Go template",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "-v",
                "--verbose"
              ],
              "description": "Verbose output for diagnostics"
            }
          ],
          "args": [
            {
              "name": "NETWORK",
              "isVariadic": true,
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "network",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "ls",
          "description": "List networks",
          "options": [
            {
              "names": [
                "-f",
                "--filter"
              ],
              "description": "Provide filter values (e.g. 'driver=bridge')",
              "args": {
                "name": "filter"
              }
            },
            {
              "names": [
                "--format"
              ],
              "description": "Pretty-print networks using a Go template",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--no-trunc"
              ],
              "description": "Do not truncate the output"
            },
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "Only display network IDs"
            }
          ]
        },
        {
          "name": "prune",
          "description": "Remove all unused networks",
          "options": [
            {
              "names": [
                "--filter"
              ],
              "description": "Provide filter values (e.g. 'until=<timestamp>')",
              "args": {
                "name": "filter"
              }
            },
            {
              "names": [
                "-f",
                "--force"
              ],
              "description": "Do not prompt for confirmation"
            }
          ]
        },
        {
          "name": "rm",
          "description": "Remove one or more networks",
          "args": [
            {
              "name": "NETWORK",
              "isVariadic": true,
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "network",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "node",
      "description": "Manage Swarm nodes",
      "subcommands": [
        {
          "name": "demote",
          "description": "Demote one or more nodes from manager in the swarm",
          "args": [
            {
              "name": "NODE",
              "isVariadic": true,
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "node",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "inspect",
          "description": "Display detailed information on one or more nodes",
          "options": [
            {
              "names": [
                "-f",
                "--format"
              ],
              "description": "Format the output using the given Go template",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--pretty"
              ],
              "description": "Print the information in a human friendly format"
            }
          ],
          "args": [
            {
              "name": "NODE",
              "isVariadic": true,
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "node",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "ls",
          "description": "List nodes in the swarm",
          "options": [
            {
              "names": [
                "-f",
                "--filter"
              ],
              "description": "Filter output based on conditions provided",
              "args": {
                "name": "filter"
              }
            },
            {
              "names": [
                "--format"
              ],
              "description": "Pretty-print nodes using a Go template",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "Only display IDs"
            }
          ]
        },
        {
          "name": "promote",
          "description": "Promote one or more nodes to manager in the swarm",
          "args": [
            {
              "name": "NODE",
              "isVariadic": true,
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "node",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "ps",
          "description": "List tasks running on one or more nodes, defaults to current node",
          "options": [
            {
              "names": [
                "-f",
                "--filter"
              ],
              "description": "Filter output based on conditions provided",
              "args": {
                "name": "filter"
              }
            },
            {
              "names": [
                "--format"
              ],
              "description": "Pretty-print tasks using a Go template",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--no-resolve"
              ],
              "description": "Do not map IDs to Names"
            },
            {
              "names": [
                "--no-trunc"
              ],
              "description": "Do not truncate output"
            },
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "Only display task IDs"
            }
          ],
          "args": [
            {
              "name": "NODE",
              "isVariadic": true,
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "node",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "rm",
          "description": "Remove one or more nodes from the swarm",
          "options": [
            {
              "names": [
                "-f",
                "--force"
              ],
              "description": "Force remove a node from the swarm"
            }
          ],
          "args": [
            {
              "name": "NODE",
              "isVariadic": true,
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "node",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "update",
          "description": "Update a node",
          "options": [
            {
              "names": [
                "--availability"
              ],
              "description": "Availability of the node (\"active\"|\"pause\"|\"drain\")",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--label-add"
              ],
              "description": "Add or update a node label (key=value)",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--label-rm"
              ],
              "description": "Remove a node label if exists",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--role"
              ],
              "description": "Role of the node (\"worker\"|\"manager\")",
              "args": {
                "name": "string"
              }
            }
          ],
          "args": [
            {
              "name": "NODE",
              "isVariadic": true,
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "node",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "buildx",
      "description": "Extended build capabilities with BuildKit",
      "subcommands": [
        {
          "name": "bake",
          "description": "Bake is a high-level build command. Each specified target will run in parallel as part of the build",
          "options": [
            {
              "names": [
                "-f",
                "--file"
              ],
              "description": "Build definition file",
              "args": {
                "name": "string",
                "isVariadic": true
              }
            },
            {
              "names": [
                "--load"
              ],
              "description": "Shorthand for --set=*.output=type=docker",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--metadata-file"
              ],
              "description": "Write build result metadata to the file",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--no-cache"
              ],
              "description": "Do not use cache when building the image",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--print"
              ],
              "description": "Print the options without building",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--progress"
              ],
              "description": "Set type of progress output (auto, plain, tty). Use plain to show container output",
              "args": {
                "name": "progress",
                "suggestions": [
                  "auto",
                  "plain",
                  "tty"
                ]
              }
            },
            {
              "names": [
                "--pull"
              ],
              "description": "Always attempt to pull all referenced images",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--push"
              ],
              "description": "Shorthand for --set=*.output=type=registry",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--set"
              ],
              "description": "Override target value (e.g., targetpattern.key=value)",
              "args": {
                "name": "string"
              }
            }
          ],
          "args": [
            {
              "name": "string"
            }
          ]
        },
        {
          "name": "build",
          "description": "The buildx build command starts a build using BuildKit. This command is similar to the UI of docker build command and takes the same flags and arguments",
          "options": [
            {
              "names": [
                "--add-host"
              ],
              "description": "Add a custom host-to-IP mapping",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--allow"
              ],
              "description": "Allow extra privileged entitlement",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--build-arg"
              ],
              "description": "Set build-time variables",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--build-context"
              ],
              "description": "Additional build contexts",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--cache-from"
              ],
              "description": "External cache sources",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--cache-to"
              ],
              "description": "Cache export destinations",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--cgroup-parent"
              ],
              "description": "Optional parent cgroup for the container",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--compress"
              ],
              "description": "Compress the build context using gzip",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--cpu-period"
              ],
              "description": "Limit the CPU CFS (Completely Fair Scheduler) period",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--cpu-quota"
              ],
              "description": "Limit the CPU CFS (Completely Fair Scheduler) quota",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--cpu-shares",
                "-c"
              ],
              "description": "CPU shares (relative weight)",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--cpuset-cpus"
              ],
              "description": "CPUs in which to allow execution (0-3, 0,1)",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--cpuset-mems"
              ],
              "description": "MEMs in which to allow execution (0-3, 0,1)",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--file",
                "-f"
              ],
              "description": "Name of the Dockerfile",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--force-rm"
              ],
              "description": "Always remove intermediate containers",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--iidfile"
              ],
              "description": "Write the image ID to the file",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--invoke"
              ],
              "description": "Invoke a command after the build [experimental]",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--isolation"
              ],
              "description": "Container isolation technology",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--label"
              ],
              "description": "Set metadata for an image",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--load"
              ],
              "description": "Shorthand for --output=type=docker",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--memory",
                "-m"
              ],
              "description": "Memory limit",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--memory-swap"
              ],
              "description": "Swap limit equal to memory plus swap: -1 to enable unlimited swap",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--metadata-file"
              ],
              "description": "Write build result metadata to the file",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--network"
              ],
              "description": "Set the networking mode for the RUN instructions during build",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--no-cache"
              ],
              "description": "Do not use cache when building the image",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--no-cache-filter"
              ],
              "description": "Do not cache specified stages",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--output",
                "-o"
              ],
              "description": "Output destination (format: type=local,dest=path)",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--platform"
              ],
              "description": "Set target platform for build",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--print"
              ],
              "description": "Print result of information request (e.g., outline, targets) [experimental]",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--progress"
              ],
              "description": "Set type of progress output (auto, plain, tty). Use plain to show container output",
              "args": {
                "name": "progress",
                "suggestions": [
                  "auto",
                  "plain",
                  "tty"
                ]
              }
            },
            {
              "names": [
                "--pull"
              ],
              "description": "Always attempt to pull all referenced images",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--push"
              ],
              "description": "Shorthand for --output=type=registry",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--quiet",
                "-q"
              ],
              "description": "Suppress the build output and print image ID on success",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--rm"
              ],
              "description": "Remove intermediate containers after a successful build",
              "args": {
                "name": "container"
              }
            },
            {
              "names": [
                "--secret"
              ],
              "description": "Secret to expose to the build (format: id=mysecret[,src=/local/secret])",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--security-opt"
              ],
              "description": "Security options",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--shm-size"
              ],
              "description": "Size of /dev/shm",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--squash"
              ],
              "description": "Squash newly built layers into a single new layer",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--ssh"
              ],
              "description": "SSH agent socket or keys to expose to the build (format: default|&lt;id&gt;[=&lt;socket&gt;|&lt;key&gt;[,&lt;key&gt;]])",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--tag",
                "-t"
              ],
              "description": "Name and optionally a tag (format: name:tag)",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--target"
              ],
              "description": "Set the target build stage to build",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--ulimit"
              ],
              "description": "Ulimit options",
              "args": {
                "name": "string"
              }
            }
          ],
          "args": [
            {
              "name": "string"
            }
          ]
        },
        {
          "name": "create",
          "description": "Create a new builder instance",
          "options": [
            {
              "names": [
                "--append"
              ],
              "description": "Append a node to builder instead of changing it",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--bootstrap"
              ],
              "description": "Boot builder after creation",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--buildkitd-flags"
              ],
              "description": "Flags for buildkitd daemon",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--config"
              ],
              "description": "BuildKit config file",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--driver"
              ],
              "description": "Driver to use (available: docker-container, kubernetes, remote)",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--driver-opt"
              ],
              "description": "Options for the driver",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--leave"
              ],
              "description": "Remove a node from builder instead of changing it",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--name"
              ],
              "description": "Builder instance name",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--node"
              ],
              "description": "Create/modify node with given name",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--platform"
              ],
              "description": "Fixed platforms for current node",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--use"
              ],
              "description": "Set the current builder instance",
              "args": {
                "name": "string"
              }
            }
          ],
          "args": [
            {
              "name": "string"
            }
          ]
        },
        {
          "name": "du",
          "description": "Disk usage",
          "options": [
            {
              "names": [
                "--filter"
              ],
              "description": "Provide filter values"
            },
            {
              "names": [
                "--verbose"
              ],
              "description": "Provide a more verbose output"
            }
          ],
          "args": [
            {
              "name": "string"
            }
          ]
        },
        {
          "name": "imagetools",
          "description": "Imagetools contains commands for working with manifest lists in the registry. These commands are useful for inspecting multi-platform build results",
          "subcommands": [
            {
              "name": "create",
              "description": "Create a new image based on source images",
              "options": [
                {
                  "names": [
                    "--append"
                  ],
                  "description": "Append to existing manifest",
                  "args": {
                    "name": "string"
                  }
                },
                {
                  "names": [
                    "--dry-run"
                  ],
                  "description": "Show final image instead of pushing",
                  "args": {
                    "name": "string"
                  }
                },
                {
                  "names": [
                    "--file",
                    "-f"
                  ],
                  "description": "Read source descriptor from file",
                  "args": {
                    "name": "string"
                  }
                },
                {
                  "names": [
                    "--progress"
                  ],
                  "description": "Set type of progress output (auto, plain, tty). Use plain to show container output",
                  "args": {
                    "name": "progress",
                    "suggestions": [
                      "auto",
                      "plain",
                      "tty"
                    ]
                  }
                },
                {
                  "names": [
                    "--tag",
                    "-t"
                  ],
                  "description": "Set reference for new image",
                  "args": {
                    "name": "string"
                  }
                }
              ],
              "args": [
                {
                  "name": "string"
                }
              ]
            },
            {
              "name": "inspect",
              "description": "Inspect current builder instance",
              "options": [
                {
                  "names": [
                    "--format"
                  ],
                  "description": "Format the output using the given Go template",
                  "args": {
                    "name": "sting"
                  }
                },
                {
                  "names": [
                    "--raw"
                  ],
                  "description": "Show original, unformatted JSON manifest"
                }
              ],
              "args": [
                {
                  "name": "string"
                }
              ]
            }
          ],
          "args": [
            {
              "name": "string"
            }
          ]
        },
        {
          "name": "inspect",
          "description": "Inspect current builder instance",
          "options": [
            {
              "names": [
                "--bootstrap"
              ],
              "description": "Ensure builder has booted before inspecting",
              "args": {
                "name": "string"
              }
            }
          ],
          "args": [
            {
              "name": "string"
            }
          ]
        },
        {
          "name": "install",
          "description": "Install buildx as a ‘docker builder’ alias"
        },
        {
          "name": "ls",
          "description": "List builder instances"
        },
        {
          "name": "prune",
          "description": "Remove build cache",
          "options": [
            {
              "names": [
                "--all",
                "-a"
              ],
              "description": "Include internal/frontend images",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--filter"
              ],
              "description": "Provide filter values (e.g., until=24h)",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--force",
                "-f"
              ],
              "description": "Do not prompt for confirmation",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--keep-storage"
              ],
              "description": "Amount of disk space to keep for cache",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--verbose"
              ],
              "description": "Provide a more verbose output",
              "args": {
                "name": "string"
              }
            }
          ],
          "args": [
            {
              "name": "string"
            }
          ]
        },
        {
          "name": "rm",
          "description": "Remove a builder instance",
          "options": [
            {
              "names": [
                "--all-inactive"
              ],
              "description": "Remove all inactive builders",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--force",
                "-f"
              ],
              "description": "Do not prompt for confirmation",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--keep-daemon"
              ],
              "description": "Keep the buildkitd daemon running",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--keep-state"
              ],
              "description": "Keep BuildKit state",
              "args": {
                "name": "string"
              }
            }
          ],
          "args": [
            {
              "name": "string"
            }
          ]
        },
        {
          "name": "stop",
          "description": "Stop builder instance",
          "args": [
            {
              "name": "string"
            }
          ]
        },
        {
          "name": "uninstall",
          "description": "Uninstall the ‘docker builder’ alias"
        },
        {
          "name": "use",
          "description": "Set the current builder instance",
          "options": [
            {
              "names": [
                "--default"
              ],
              "description": "Set builder as default for current context",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--global"
              ],
              "description": "Builder persists context changes",
              "args": {
                "name": "string"
              }
            }
          ],
          "args": [
            {
              "name": "string"
            }
          ]
        },
        {
          "name": "version",
          "description": "Show buildx version information"
        }
      ],
      "options": [
        {
          "names": [
            "--builder"
          ],
          "description": "Override the configured builder instance",
          "args": {
            "name": "string"
          },
          "isPersistent": true
        }
      ]
    },
    {
      "name": "plugin",
      "description": "Manage plugins",
      "subcommands": [
        {
          "name": "create",
          "description": "Create a plugin from a rootfs and configuration. Plugin data directory must contain config.json and rootfs directory",
          "options": [
            {
              "names": [
                "--compress"
              ],
              "description": "Compress the context using gzip"
            }
          ],
          "args": [
            {
              "name": "PLUGIN"
            },
            {
              "name": "PLUGIN-DATA-DIR"
            }
          ]
        },
        {
          "name": "disable",
          "description": "Disable a plugin",
          "options": [
            {
              "names": [
                "-f",
                "--force"
              ],
              "description": "Force the disable of an active plugin"
            }
          ],
          "args": [
            {
              "name": "PLUGIN",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "plugin",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "enable",
          "description": "Enable a plugin",
          "options": [
            {
              "names": [
                "--timeout"
              ],
              "description": "HTTP client timeout (in seconds) (default 30)",
              "args": {
                "name": "int"
              }
            }
          ],
          "args": [
            {
              "name": "PLUGIN",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "plugin",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "inspect",
          "description": "Display detailed information on one or more plugins",
          "options": [
            {
              "names": [
                "-f",
                "--format"
              ],
              "description": "Format the output using the given Go template",
              "args": {
                "name": "string"
              }
            }
          ],
          "args": [
            {
              "name": "PLUGIN",
              "isVariadic": true,
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "plugin",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "install",
          "description": "Install a plugin",
          "options": [
            {
              "names": [
                "--alias"
              ],
              "description": "Local name for plugin",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--disable"
              ],
              "description": "Do not enable the plugin on install"
            },
            {
              "names": [
                "--disable-content-trust"
              ],
              "description": "Skip image verification (default true)"
            },
            {
              "names": [
                "--grant-all-permissions"
              ],
              "description": "Grant all permissions necessary to run the plugin"
            }
          ],
          "args": [
            {
              "name": "PLUGIN"
            },
            {
              "name": "KEY=VALUE",
              "isVariadic": true
            }
          ]
        },
        {
          "name": "ls",
          "description": "List plugins",
          "options": [
            {
              "names": [
                "-f",
                "--filter"
              ],
              "description": "Provide filter values (e.g. 'enabled=true')",
              "args": {
                "name": "filter"
              }
            },
            {
              "names": [
                "--format"
              ],
              "description": "Pretty-print plugins using a Go template",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--no-trunc"
              ],
              "description": "Don't truncate output"
            },
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "Only display plugin IDs"
            }
          ]
        },
        {
          "name": "push",
          "description": "Push a plugin to a registry",
          "options": [
            {
              "names": [
                "--disable-content-trust"
              ],
              "description": "Skip image signing (default true)"
            }
          ],
          "args": [
            {
              "name": "PLUGIN:[TAG]"
            }
          ]
        },
        {
          "name": "rm",
          "description": "Remove one or more plugins",
          "options": [
            {
              "names": [
                "-f",
                "--force"
              ],
              "description": "Force the removal of an active plugin"
            }
          ],
          "args": [
            {
              "name": "PLUGIN",
              "isVariadic": true,
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "plugin",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "set",
          "description": "Change settings for a plugin",
          "args": [
            {
              "name": "PLUGIN",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "plugin",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            },
            {
              "name": "KEY=VALUE",
              "isVariadic": true
            }
          ]
        },
        {
          "name": "upgrade",
          "description": "Upgrade an existing plugin",
          "options": [
            {
              "names": [
                "--disable-content-trust"
              ],
              "description": "Skip image verification (default true)"
            },
            {
              "names": [
                "--grant-all-permissions"
              ],
              "description": "Grant all permissions necessary to run the plugin"
            },
            {
              "names": [
                "--skip-remote-check"
              ],
              "description": "Do not check if specified remote plugin matches existing plugin image"
            }
          ],
          "args": [
            {
              "name": "PLUGIN",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "plugin",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            },
            {
              "name": "REMOTE"
            }
          ]
        }
      ]
    },
    {
      "name": "secret",
      "description": "Manage Docker secrets",
      "subcommands": [
        {
          "name": "create",
          "description": "Create a secret from a file or STDIN as content",
          "options": [
            {
              "names": [
                "-d",
                "--driver"
              ],
              "description": "Secret driver",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "-l",
                "--label"
              ],
              "description": "Secret labels",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--template-driver"
              ],
              "description": "Template driver",
              "args": {
                "name": "string"
              }
            }
          ],
          "args": [
            {
              "name": "SECRET NAME"
            },
            {
              "name": "SECRET"
            }
          ]
        },
        {
          "name": "inspect",
          "description": "Display detailed information on one or more secrets",
          "options": [
            {
              "names": [
                "-f",
                "--format"
              ],
              "description": "Format the output using the given Go template",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--pretty"
              ],
              "description": "Print the information in a human friendly format"
            }
          ],
          "args": [
            {
              "name": "SECRET",
              "isVariadic": true,
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "secret",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "ls",
          "description": "List secrets",
          "options": [
            {
              "names": [
                "-f",
                "--filter"
              ],
              "description": "Filter output based on conditions provided",
              "args": {
                "name": "filter"
              }
            },
            {
              "names": [
                "--format"
              ],
              "description": "Pretty-print secrets using a Go template",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "Only display IDs"
            }
          ]
        },
        {
          "name": "rm",
          "description": "Remove one or more secrets",
          "args": [
            {
              "name": "SECRET",
              "isVariadic": true,
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "secret",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "service",
      "description": "Manage services",
      "subcommands": [
        {
          "name": "create",
          "description": "Create a new service",
          "options": [
            {
              "names": [
                "--cap-add"
              ],
              "description": "Add Linux capabilities",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--cap-drop"
              ],
              "description": "Drop Linux capabilities",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--config"
              ],
              "description": "Specify configurations to expose to the service",
              "args": {
                "name": "config"
              }
            },
            {
              "names": [
                "--constraint"
              ],
              "description": "Placement constraints",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--container-label"
              ],
              "description": "Container labels",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--credential-spec"
              ],
              "description": "Credential spec for managed service account (Windows only)",
              "args": {
                "name": "credential-spec"
              }
            },
            {
              "names": [
                "-d",
                "--detach"
              ],
              "description": "Exit immediately instead of waiting for the service to converge"
            },
            {
              "names": [
                "--dns"
              ],
              "description": "Set custom DNS servers",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--dns-option"
              ],
              "description": "Set DNS options",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--dns-search"
              ],
              "description": "Set custom DNS search domains",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--endpoint-mode"
              ],
              "description": "Endpoint mode (vip or dnsrr) (default \"vip\")",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--entrypoint"
              ],
              "description": "Overwrite the default ENTRYPOINT of the image",
              "args": {
                "name": "command"
              }
            },
            {
              "names": [
                "-e",
                "--env"
              ],
              "description": "Set environment variables",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--env-file"
              ],
              "description": "Read in a file of environment variables",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--generic-resource"
              ],
              "description": "User defined resources",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--group"
              ],
              "description": "Set one or more supplementary user groups for the container",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--health-cmd"
              ],
              "description": "Command to run to check health",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--health-interval"
              ],
              "description": "Time between running the check (ms|s|m|h)",
              "args": {
                "name": "duration"
              }
            },
            {
              "names": [
                "--health-retries"
              ],
              "description": "Consecutive failures needed to report unhealthy",
              "args": {
                "name": "int"
              }
            },
            {
              "names": [
                "--health-start-period"
              ],
              "description": "Start period for the container to initialize before counting retries towards unstable (ms|s|m|h)",
              "args": {
                "name": "duration"
              }
            },
            {
              "names": [
                "--health-timeout"
              ],
              "description": "Maximum time to allow one check to run (ms|s|m|h)",
              "args": {
                "name": "duration"
              }
            },
            {
              "names": [
                "--host"
              ],
              "description": "Set one or more custom host-to-IP mappings (host:ip)",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--hostname"
              ],
              "description": "Container hostname",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--init"
              ],
              "description": "Use an init inside each service container to forward signals and reap processes"
            },
            {
              "names": [
                "--isolation"
              ],
              "description": "Service container isolation mode",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "-l",
                "--label"
              ],
              "description": "Service labels",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--limit-cpu"
              ],
              "description": "Limit CPUs",
              "args": {
                "name": "decimal"
              }
            },
            {
              "names": [
                "--limit-memory"
              ],
              "description": "Limit Memory",
              "args": {
                "name": "bytes"
              }
            },
            {
              "names": [
                "--limit-pids"
              ],
              "description": "Limit maximum number of processes (default 0 = unlimited)",
              "args": {
                "name": "int"
              }
            },
            {
              "names": [
                "--log-driver"
              ],
              "description": "Logging driver for service",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--log-opt"
              ],
              "description": "Logging driver options",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--max-concurrent"
              ],
              "description": "Number of job tasks to run concurrently (default equal to --replicas)",
              "args": {
                "name": "uint"
              }
            },
            {
              "names": [
                "--mode"
              ],
              "description": "Service mode (replicated, global, replicated-job, or global-job) (default \"replicated\")",
              "args": {
                "name": "string",
                "suggestions": [
                  "replicated",
                  "global",
                  "replicated-job",
                  "global-job"
                ]
              }
            },
            {
              "names": [
                "--mount"
              ],
              "description": "Attach a filesystem mount to the service",
              "args": {
                "name": "mount"
              }
            },
            {
              "names": [
                "--name"
              ],
              "description": "Service name",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--network"
              ],
              "description": "Network attachments",
              "args": {
                "name": "network"
              }
            },
            {
              "names": [
                "--no-healthcheck"
              ],
              "description": "Disable any container-specified HEALTHCHECK"
            },
            {
              "names": [
                "--no-resolve-image"
              ],
              "description": "Do not query the registry to resolve image digest and supported platforms"
            },
            {
              "names": [
                "--placement-pref"
              ],
              "description": "Add a placement preference",
              "args": {
                "name": "pref"
              }
            },
            {
              "names": [
                "-p",
                "--publish"
              ],
              "description": "Publish a port as a node port",
              "args": {
                "name": "port"
              }
            },
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "Suppress progress output"
            },
            {
              "names": [
                "--read-only"
              ],
              "description": "Mount the container's root filesystem as read only"
            },
            {
              "names": [
                "--replicas"
              ],
              "description": "Number of tasks",
              "args": {
                "name": "uint"
              }
            },
            {
              "names": [
                "--replicas-max-per-node"
              ],
              "description": "Maximum number of tasks per node (default 0 = unlimited)",
              "args": {
                "name": "uint"
              }
            },
            {
              "names": [
                "--reserve-cpu"
              ],
              "description": "Reserve CPUs",
              "args": {
                "name": "decimal"
              }
            },
            {
              "names": [
                "--reserve-memory"
              ],
              "description": "Reserve Memory",
              "args": {
                "name": "bytes"
              }
            },
            {
              "names": [
                "--restart-condition"
              ],
              "description": "Restart when condition is met (\"none\"|\"on-failure\"|\"any\") (default \"any\")",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--restart-delay"
              ],
              "description": "Delay between restart attempts (ns|us|ms|s|m|h) (default 5s)",
              "args": {
                "name": "duration"
              }
            },
            {
              "names": [
                "--restart-max-attempts"
              ],
              "description": "Maximum number of restarts before giving up",
              "args": {
                "name": "uint"
              }
            },
            {
              "names": [
                "--restart-window"
              ],
              "description": "Window used to evaluate the restart policy (ns|us|ms|s|m|h)",
              "args": {
                "name": "duration"
              }
            },
            {
              "names": [
                "--rollback-delay"
              ],
              "description": "Delay between task rollbacks (ns|us|ms|s|m|h) (default 0s)",
              "args": {
                "name": "duration"
              }
            },
            {
              "names": [
                "--rollback-failure-action"
              ],
              "description": "Action on rollback failure (\"pause\"|\"continue\") (default \"pause\")",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--rollback-max-failure-ratio"
              ],
              "description": "Failure rate to tolerate during a rollback (default 0)",
              "args": {
                "name": "float"
              }
            },
            {
              "names": [
                "--rollback-monitor"
              ],
              "description": "Duration after each task rollback to monitor for failure (ns|us|ms|s|m|h) (default 5s)",
              "args": {
                "name": "duration"
              }
            },
            {
              "names": [
                "--rollback-order"
              ],
              "description": "Rollback order (\"start-first\"|\"stop-first\") (default \"stop-first\")",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--rollback-parallelism"
              ],
              "description": "Maximum number of tasks rolled back simultaneously (0 to roll back all at once) (default 1)",
              "args": {
                "name": "uint"
              }
            },
            {
              "names": [
                "--secret"
              ],
              "description": "Specify secrets to expose to the service",
              "args": {
                "name": "secret"
              }
            },
            {
              "names": [
                "--stop-grace-period"
              ],
              "description": "Time to wait before force killing a container (ns|us|ms|s|m|h) (default 10s)",
              "args": {
                "name": "duration"
              }
            },
            {
              "names": [
                "--stop-signal"
              ],
              "description": "Signal to stop the container",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--sysctl"
              ],
              "description": "Sysctl options",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "-t",
                "--tty"
              ],
              "description": "Allocate a pseudo-TTY"
            },
            {
              "names": [
                "--ulimit"
              ],
              "description": "Ulimit options (default [])",
              "args": {
                "name": "ulimit"
              }
            },
            {
              "names": [
                "--update-delay"
              ],
              "description": "Delay between updates (ns|us|ms|s|m|h) (default 0s)",
              "args": {
                "name": "duration"
              }
            },
            {
              "names": [
                "--update-failure-action"
              ],
              "description": "Action on update failure (\"pause\"|\"continue\"|\"rollback\") (default \"pause\")",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--update-max-failure-ratio"
              ],
              "description": "Failure rate to tolerate during an update (default 0)",
              "args": {
                "name": "float"
              }
            },
            {
              "names": [
                "--update-monitor"
              ],
              "description": "Duration after each task update to monitor for failure (ns|us|ms|s|m|h) (default 5s)",
              "args": {
                "name": "duration"
              }
            },
            {
              "names": [
                "--update-order"
              ],
              "description": "Update order (\"start-first\"|\"stop-first\") (default \"stop-first\")",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--update-parallelism"
              ],
              "description": "Maximum number of tasks updated simultaneously (0 to update all at once) (default 1)",
              "args": {
                "name": "uint"
              }
            },
            {
              "names": [
                "-u",
                "--user"
              ],
              "description": "Username or UID (format: <name|uid>[:<group|gid>])",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--with-registry-auth"
              ],
              "description": "Send registry authentication details to swarm agents"
            },
            {
              "names": [
                "-w",
                "--workdir"
              ],
              "description": "Working directory inside the container",
              "args": {
                "name": "string"
              }
            }
          ],
          "args": [
            {
              "name": "image",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "image",
                    "ls",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            },
            {
              "name": "COMMAND",
              "isOptional": true
            }
          ]
        },
        {
          "name": "inspect",
          "description": "Display detailed information on one or more services",
          "options": [
            {
              "names": [
                "-f",
                "--format"
              ],
              "description": "Format the output using the given Go template",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--pretty"
              ],
              "description": "Print the information in a human friendly format"
            }
          ],
          "args": [
            {
              "name": "SERVICE",
              "isVariadic": true,
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "service",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "logs",
          "description": "Fetch the logs of a service or task",
          "options": [
            {
              "names": [
                "--details"
              ],
              "description": "Show extra details provided to logs"
            },
            {
              "names": [
                "-f",
                "--follow"
              ],
              "description": "Follow log output"
            },
            {
              "names": [
                "--no-resolve"
              ],
              "description": "Do not map IDs to Names in output"
            },
            {
              "names": [
                "--no-task-ids"
              ],
              "description": "Do not include task IDs in output"
            },
            {
              "names": [
                "--no-trunc"
              ],
              "description": "Do not truncate output"
            },
            {
              "names": [
                "--raw"
              ],
              "description": "Do not neatly format logs"
            },
            {
              "names": [
                "--since"
              ],
              "description": "Show logs since timestamp (e.g. 2013-01-02T13:23:37Z) or relative (e.g. 42m for 42 minutes)",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "-n",
                "--tail"
              ],
              "description": "Number of lines to show from the end of the logs (default \"all\")",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "-t",
                "--timestamps"
              ],
              "description": "Show timestamps"
            }
          ],
          "args": [
            {
              "name": "SERVICE OR TASK",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "service",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "ls",
          "description": "List services",
          "options": [
            {
              "names": [
                "-f",
                "--filter"
              ],
              "description": "Filter output based on conditions provided",
              "args": {
                "name": "filter"
              }
            },
            {
              "names": [
                "--format"
              ],
              "description": "Pretty-print services using a Go template",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "Only display IDs"
            }
          ]
        },
        {
          "name": "ps",
          "description": "List the tasks of one or more services",
          "options": [
            {
              "names": [
                "-f",
                "--filter"
              ],
              "description": "Filter output based on conditions provided",
              "args": {
                "name": "filter"
              }
            },
            {
              "names": [
                "--format"
              ],
              "description": "Pretty-print tasks using a Go template",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--no-resolve"
              ],
              "description": "Do not map IDs to Names"
            },
            {
              "names": [
                "--no-trunc"
              ],
              "description": "Do not truncate output"
            },
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "Only display task IDs"
            }
          ],
          "args": [
            {
              "name": "SERVICE",
              "isVariadic": true,
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "service",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "rm",
          "description": "Remove one or more services",
          "args": [
            {
              "name": "SERVICE",
              "isVariadic": true,
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "service",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "rollback",
          "description": "Revert changes to a service's configuration",
          "options": [
            {
              "names": [
                "-d",
                "--detach"
              ],
              "description": "Exit immediately instead of waiting for the service to converge"
            },
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "Suppress progress output"
            }
          ],
          "args": [
            {
              "name": "SERVICE",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "service",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "scale",
          "description": "Scale one or multiple replicated services",
          "options": [
            {
              "names": [
                "-d",
                "--detach"
              ],
              "description": "Exit immediately instead of waiting for the service to converge"
            }
          ],
          "args": [
            {
              "name": "SERVICE=REPLICAS",
              "isVariadic": true,
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "service",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "update",
          "description": "Update a service",
          "options": [
            {
              "names": [
                "--args"
              ],
              "description": "Service command args",
              "args": {
                "name": "command"
              }
            },
            {
              "names": [
                "--cap-add"
              ],
              "description": "Add Linux capabilities",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--cap-drop"
              ],
              "description": "Drop Linux capabilities",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--config-add"
              ],
              "description": "Add or update a config file on a service",
              "args": {
                "name": "config"
              }
            },
            {
              "names": [
                "--config-rm"
              ],
              "description": "Remove a configuration file",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--constraint-add"
              ],
              "description": "Add or update a placement constraint",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--constraint-rm"
              ],
              "description": "Remove a constraint",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--container-label-add"
              ],
              "description": "Add or update a container label",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--container-label-rm"
              ],
              "description": "Remove a container label by its key",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--credential-spec"
              ],
              "description": "Credential spec for managed service account (Windows only)",
              "args": {
                "name": "credential-spec"
              }
            },
            {
              "names": [
                "-d",
                "--detach"
              ],
              "description": "Exit immediately instead of waiting for the service to converge"
            },
            {
              "names": [
                "--dns-add"
              ],
              "description": "Add or update a custom DNS server",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--dns-option-add"
              ],
              "description": "Add or update a DNS option",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--dns-option-rm"
              ],
              "description": "Remove a DNS option",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--dns-rm"
              ],
              "description": "Remove a custom DNS server",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--dns-search-add"
              ],
              "description": "Add or update a custom DNS search domain",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--dns-search-rm"
              ],
              "description": "Remove a DNS search domain",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--endpoint-mode"
              ],
              "description": "Endpoint mode (vip or dnsrr)",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--entrypoint"
              ],
              "description": "Overwrite the default ENTRYPOINT of the image",
              "args": {
                "name": "command"
              }
            },
            {
              "names": [
                "--env-add"
              ],
              "description": "Add or update an environment variable",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--env-rm"
              ],
              "description": "Remove an environment variable",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--force"
              ],
              "description": "Force update even if no changes require it"
            },
            {
              "names": [
                "--generic-resource-add"
              ],
              "description": "Add a Generic resource",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--generic-resource-rm"
              ],
              "description": "Remove a Generic resource",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--group-add"
              ],
              "description": "Add an additional supplementary user group to the container",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--group-rm"
              ],
              "description": "Remove a previously added supplementary user group from the container",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--health-cmd"
              ],
              "description": "Command to run to check health",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--health-interval"
              ],
              "description": "Time between running the check (ms|s|m|h)",
              "args": {
                "name": "duration"
              }
            },
            {
              "names": [
                "--health-retries"
              ],
              "description": "Consecutive failures needed to report unhealthy",
              "args": {
                "name": "int"
              }
            },
            {
              "names": [
                "--health-start-period"
              ],
              "description": "Start period for the container to initialize before counting retries towards unstable (ms|s|m|h)",
              "args": {
                "name": "duration"
              }
            },
            {
              "names": [
                "--health-timeout"
              ],
              "description": "Maximum time to allow one check to run (ms|s|m|h)",
              "args": {
                "name": "duration"
              }
            },
            {
              "names": [
                "--host-add"
              ],
              "description": "Add a custom host-to-IP mapping (host:ip)",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--host-rm"
              ],
              "description": "Remove a custom host-to-IP mapping (host:ip)",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--hostname"
              ],
              "description": "Container hostname",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--image"
              ],
              "description": "Service image tag",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--init"
              ],
              "description": "Use an init inside each service container to forward signals and reap processes"
            },
            {
              "names": [
                "--isolation"
              ],
              "description": "Service container isolation mode",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--label-add"
              ],
              "description": "Add or update a service label",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--label-rm"
              ],
              "description": "Remove a label by its key",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--limit-cpu"
              ],
              "description": "Limit CPUs",
              "args": {
                "name": "decimal"
              }
            },
            {
              "names": [
                "--limit-memory"
              ],
              "description": "Limit Memory",
              "args": {
                "name": "bytes"
              }
            },
            {
              "names": [
                "--limit-pids"
              ],
              "description": "Limit maximum number of processes (default 0 = unlimited)",
              "args": {
                "name": "int"
              }
            },
            {
              "names": [
                "--log-driver"
              ],
              "description": "Logging driver for service",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--log-opt"
              ],
              "description": "Logging driver options",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--max-concurrent"
              ],
              "description": "Number of job tasks to run concurrently (default equal to --replicas)",
              "args": {
                "name": "uint"
              }
            },
            {
              "names": [
                "--mount-add"
              ],
              "description": "Add or update a mount on a service",
              "args": {
                "name": "mount"
              }
            },
            {
              "names": [
                "--mount-rm"
              ],
              "description": "Remove a mount by its target path",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--network-add"
              ],
              "description": "Add a network",
              "args": {
                "name": "network"
              }
            },
            {
              "names": [
                "--network-rm"
              ],
              "description": "Remove a network",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--no-healthcheck"
              ],
              "description": "Disable any container-specified HEALTHCHECK"
            },
            {
              "names": [
                "--no-resolve-image"
              ],
              "description": "Do not query the registry to resolve image digest and supported platforms"
            },
            {
              "names": [
                "--placement-pref-add"
              ],
              "description": "Add a placement preference",
              "args": {
                "name": "pref"
              }
            },
            {
              "names": [
                "--placement-pref-rm"
              ],
              "description": "Remove a placement preference",
              "args": {
                "name": "pref"
              }
            },
            {
              "names": [
                "--publish-add"
              ],
              "description": "Add or update a published port",
              "args": {
                "name": "port"
              }
            },
            {
              "names": [
                "--publish-rm"
              ],
              "description": "Remove a published port by its target port",
              "args": {
                "name": "port"
              }
            },
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "Suppress progress output"
            },
            {
              "names": [
                "--read-only"
              ],
              "description": "Mount the container's root filesystem as read only"
            },
            {
              "names": [
                "--replicas"
              ],
              "description": "Number of tasks",
              "args": {
                "name": "uint"
              }
            },
            {
              "names": [
                "--replicas-max-per-node"
              ],
              "description": "Maximum number of tasks per node (default 0 = unlimited)",
              "args": {
                "name": "uint"
              }
            },
            {
              "names": [
                "--reserve-cpu"
              ],
              "description": "Reserve CPUs",
              "args": {
                "name": "decimal"
              }
            },
            {
              "names": [
                "--reserve-memory"
              ],
              "description": "Reserve Memory",
              "args": {
                "name": "bytes"
              }
            },
            {
              "names": [
                "--restart-condition"
              ],
              "description": "Restart when condition is met (\"none\"|\"on-failure\"|\"any\")",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--restart-delay"
              ],
              "description": "Delay between restart attempts (ns|us|ms|s|m|h)",
              "args": {
                "name": "duration"
              }
            },
            {
              "names": [
                "--restart-max-attempts"
              ],
              "description": "Maximum number of restarts before giving up",
              "args": {
                "name": "uint"
              }
            },
            {
              "names": [
                "--restart-window"
              ],
              "description": "Window used to evaluate the restart policy (ns|us|ms|s|m|h)",
              "args": {
                "name": "duration"
              }
            },
            {
              "names": [
                "--rollback"
              ],
              "description": "Rollback to previous specification"
            },
            {
              "names": [
                "--rollback-delay"
              ],
              "description": "Delay between task rollbacks (ns|us|ms|s|m|h)",
              "args": {
                "name": "duration"
              }
            },
            {
              "names": [
                "--rollback-failure-action"
              ],
              "description": "Action on rollback failure (\"pause\"|\"continue\")",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--rollback-max-failure-ratio"
              ],
              "description": "Failure rate to tolerate during a rollback",
              "args": {
                "name": "float"
              }
            },
            {
              "names": [
                "--rollback-monitor"
              ],
              "description": "Duration after each task rollback to monitor for failure (ns|us|ms|s|m|h)",
              "args": {
                "name": "duration"
              }
            },
            {
              "names": [
                "--rollback-order"
              ],
              "description": "Rollback order (\"start-first\"|\"stop-first\")",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--rollback-parallelism"
              ],
              "description": "Maximum number of tasks rolled back simultaneously (0 to roll back all at once)",
              "args": {
                "name": "uint"
              }
            },
            {
              "names": [
                "--secret-add"
              ],
              "description": "Add or update a secret on a service",
              "args": {
                "name": "secret"
              }
            },
            {
              "names": [
                "--secret-rm"
              ],
              "description": "Remove a secret",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--stop-grace-period"
              ],
              "description": "Time to wait before force killing a container (ns|us|ms|s|m|h)",
              "args": {
                "name": "duration"
              }
            },
            {
              "names": [
                "--stop-signal"
              ],
              "description": "Signal to stop the container",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--sysctl-add"
              ],
              "description": "Add or update a Sysctl option",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--sysctl-rm"
              ],
              "description": "Remove a Sysctl option",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "-t",
                "--tty"
              ],
              "description": "Allocate a pseudo-TTY"
            },
            {
              "names": [
                "--ulimit-add"
              ],
              "description": "Add or update a ulimit option (default [])",
              "args": {
                "name": "ulimit"
              }
            },
            {
              "names": [
                "--ulimit-rm"
              ],
              "description": "Remove a ulimit option",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "--update-delay"
              ],
              "description": "Delay between updates (ns|us|ms|s|m|h)",
              "args": {
                "name": "duration"
              }
            },
            {
              "names": [
                "--update-failure-action"
              ],
              "description": "Action on update failure (\"pause\"|\"continue\"|\"rollback\")",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--update-max-failure-ratio"
              ],
              "description": "Failure rate to tolerate during an update",
              "args": {
                "name": "float"
              }
            },
            {
              "names": [
                "--update-monitor"
              ],
              "description": "Duration after each task update to monitor for failure (ns|us|ms|s|m|h)",
              "args": {
                "name": "duration"
              }
            },
            {
              "names": [
                "--update-order"
              ],
              "description": "Update order (\"start-first\"|\"stop-first\")",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--update-parallelism"
              ],
              "description": "Maximum number of tasks updated simultaneously (0 to update all at once)",
              "args": {
                "name": "uint"
              }
            },
            {
              "names": [
                "-u",
                "--user"
              ],
              "description": "Username or UID (format: <name|uid>[:<group|gid>])",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--with-registry-auth"
              ],
              "description": "Send registry authentication details to swarm agents"
            },
            {
              "names": [
                "-w",
                "--workdir"
              ],
              "description": "Working directory inside the container",
              "args": {
                "name": "string"
              }
            }
          ],
          "args": [
            {
              "name": "SERVICE",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "service",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "stack",
      "description": "Manage Docker stacks",
      "subcommands": [
        {
          "name": "deploy",
          "description": "Deploy a new stack or update an existing stack",
          "options": [
            {
              "names": [
                "-c",
                "--compose-file"
              ],
              "description": "Path to a Compose file, or \"-\" to read from stdin",
              "args": {
                "name": "strings"
              }
            },
            {
              "names": [
                "--orchestrator"
              ],
              "description": "Orchestrator to use (swarm|kubernetes|all)",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--prune"
              ],
              "description": "Prune services that are no longer referenced"
            },
            {
              "names": [
                "--resolve-image"
              ],
              "description": "Query the registry to resolve image digest and supported platforms (\"always\"|\"changed\"|\"never\") (default \"always\")",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--with-registry-auth"
              ],
              "description": "Send registry authentication details to Swarm agents"
            }
          ],
          "args": [
            {
              "name": "STACK"
            }
          ]
        },
        {
          "name": "ls",
          "description": "List stacks",
          "options": [
            {
              "names": [
                "--format"
              ],
              "description": "Pretty-print stacks using a Go template",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--orchestrator"
              ],
              "description": "Orchestrator to use (swarm|kubernetes|all)",
              "args": {
                "name": "string"
              }
            }
          ]
        },
        {
          "name": "ps",
          "description": "List the tasks in the stack",
          "options": [
            {
              "names": [
                "-f",
                "--filter"
              ],
              "description": "Filter output based on conditions provided",
              "args": {
                "name": "filter"
              }
            },
            {
              "names": [
                "--format"
              ],
              "description": "Pretty-print tasks using a Go template",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--no-resolve"
              ],
              "description": "Do not map IDs to Names"
            },
            {
              "names": [
                "--no-trunc"
              ],
              "description": "Do not truncate output"
            },
            {
              "names": [
                "--orchestrator"
              ],
              "description": "Orchestrator to use (swarm|kubernetes|all)",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "Only display task IDs"
            }
          ],
          "args": [
            {
              "name": "STACK",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "stack",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "rm",
          "description": "Remove one or more stacks",
          "options": [
            {
              "names": [
                "--orchestrator"
              ],
              "description": "Orchestrator to use (swarm|kubernetes|all)",
              "args": {
                "name": "string"
              }
            }
          ],
          "args": [
            {
              "name": "STACK",
              "isVariadic": true,
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "stack",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "services",
          "description": "List the services in the stack",
          "options": [
            {
              "names": [
                "-f",
                "--filter"
              ],
              "description": "Filter output based on conditions provided",
              "args": {
                "name": "filter"
              }
            },
            {
              "names": [
                "--format"
              ],
              "description": "Pretty-print services using a Go template",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--orchestrator"
              ],
              "description": "Orchestrator to use (swarm|kubernetes|all)",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "Only display IDs"
            }
          ],
          "args": [
            {
              "name": "STACK",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "stack",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "swarm",
      "description": "Manage Swarm",
      "subcommands": [
        {
          "name": "ca",
          "description": "Display and rotate the root CA",
          "options": [
            {
              "names": [
                "--ca-cert"
              ],
              "description": "Path to the PEM-formatted root CA certificate to use for the new cluster",
              "args": {
                "name": "pem-file"
              }
            },
            {
              "names": [
                "--ca-key"
              ],
              "description": "Path to the PEM-formatted root CA key to use for the new cluster",
              "args": {
                "name": "pem-file"
              }
            },
            {
              "names": [
                "--cert-expiry"
              ],
              "description": "Validity period for node certificates (ns|us|ms|s|m|h) (default 2160h0m0s)",
              "args": {
                "name": "duration"
              }
            },
            {
              "names": [
                "-d",
                "--detach"
              ],
              "description": "Exit immediately instead of waiting for the root rotation to converge"
            },
            {
              "names": [
                "--external-ca"
              ],
              "description": "Specifications of one or more certificate signing endpoints",
              "args": {
                "name": "external-ca"
              }
            },
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "Suppress progress output"
            },
            {
              "names": [
                "--rotate"
              ],
              "description": "Rotate the swarm CA - if no certificate or key are provided, new ones will be generated"
            }
          ]
        },
        {
          "name": "init",
          "description": "Initialize a swarm",
          "options": [
            {
              "names": [
                "--advertise-addr"
              ],
              "description": "Advertised address (format: <ip|interface>[:port])",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--autolock"
              ],
              "description": "Enable manager autolocking (requiring an unlock key to start a stopped manager)"
            },
            {
              "names": [
                "--availability"
              ],
              "description": "Availability of the node (\"active\"|\"pause\"|\"drain\") (default \"active\")",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--cert-expiry"
              ],
              "description": "Validity period for node certificates (ns|us|ms|s|m|h) (default 2160h0m0s)",
              "args": {
                "name": "duration"
              }
            },
            {
              "names": [
                "--data-path-addr"
              ],
              "description": "Address or interface to use for data path traffic (format: <ip|interface>)",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--data-path-port"
              ],
              "description": "Port number to use for data path traffic (1024 - 49151). If no value is set or is set to 0, the default port (4789) is used",
              "args": {
                "name": "uint32"
              }
            },
            {
              "names": [
                "--default-addr-pool"
              ],
              "description": "Default address pool in CIDR format (default [])",
              "args": {
                "name": "ipNetSlice"
              }
            },
            {
              "names": [
                "--default-addr-pool-mask-length"
              ],
              "description": "Default address pool subnet mask length (default 24)",
              "args": {
                "name": "uint32"
              }
            },
            {
              "names": [
                "--dispatcher-heartbeat"
              ],
              "description": "Dispatcher heartbeat period (ns|us|ms|s|m|h) (default 5s)",
              "args": {
                "name": "duration"
              }
            },
            {
              "names": [
                "--external-ca"
              ],
              "description": "Specifications of one or more certificate signing endpoints",
              "args": {
                "name": "external-ca"
              }
            },
            {
              "names": [
                "--force-new-cluster"
              ],
              "description": "Force create a new cluster from current state"
            },
            {
              "names": [
                "--listen-addr"
              ],
              "description": "Listen address (format: <ip|interface>[:port]) (default 0.0.0.0:2377)",
              "args": {
                "name": "node-addr"
              }
            },
            {
              "names": [
                "--max-snapshots"
              ],
              "description": "Number of additional Raft snapshots to retain",
              "args": {
                "name": "uint"
              }
            },
            {
              "names": [
                "--snapshot-interval"
              ],
              "description": "Number of log entries between Raft snapshots (default 10000)",
              "args": {
                "name": "uint"
              }
            },
            {
              "names": [
                "--task-history-limit"
              ],
              "description": "Task history retention limit (default 5)",
              "args": {
                "name": "int"
              }
            }
          ]
        },
        {
          "name": "join",
          "description": "Join a swarm as a node and/or manager",
          "options": [
            {
              "names": [
                "--advertise-addr"
              ],
              "description": "Advertised address (format: <ip|interface>[:port])",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--availability"
              ],
              "description": "Availability of the node (\"active\"|\"pause\"|\"drain\") (default \"active\")",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--data-path-addr"
              ],
              "description": "Address or interface to use for data path traffic (format: <ip|interface>)",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--listen-addr"
              ],
              "description": "Listen address (format: <ip|interface>[:port]) (default 0.0.0.0:2377)",
              "args": {
                "name": "node-addr"
              }
            },
            {
              "names": [
                "--token"
              ],
              "description": "Token for entry into the swarm",
              "args": {
                "name": "string"
              }
            }
          ],
          "args": [
            {
              "name": "HOST:PORT"
            }
          ]
        },
        {
          "name": "join-token",
          "description": "Manage join tokens",
          "options": [
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "Only display token"
            },
            {
              "names": [
                "--rotate"
              ],
              "description": "Rotate join token"
            }
          ],
          "args": [
            {
              "name": "worker or manager",
              "suggestions": [
                "worker",
                "manager"
              ]
            }
          ]
        },
        {
          "name": "leave",
          "description": "Leave the swarm",
          "options": [
            {
              "names": [
                "-f",
                "--force"
              ],
              "description": "Force this node to leave the swarm, ignoring warnings"
            }
          ]
        },
        {
          "name": "unlock",
          "description": "Unlock swarm"
        },
        {
          "name": "unlock-key",
          "description": "Manage the unlock key",
          "options": [
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "Only display token"
            },
            {
              "names": [
                "--rotate"
              ],
              "description": "Rotate unlock key"
            }
          ]
        },
        {
          "name": "update",
          "description": "Update the swarm",
          "options": [
            {
              "names": [
                "--autolock"
              ],
              "description": "Change manager autolocking setting (true|false)",
              "args": {
                "suggestions": [
                  "true",
                  "false"
                ]
              }
            },
            {
              "names": [
                "--cert-expiry"
              ],
              "description": "Validity period for node certificates (ns|us|ms|s|m|h) (default 2160h0m0s)",
              "args": {
                "name": "duration"
              }
            },
            {
              "names": [
                "--dispatcher-heartbeat"
              ],
              "description": "Dispatcher heartbeat period (ns|us|ms|s|m|h) (default 5s)",
              "args": {
                "name": "duration"
              }
            },
            {
              "names": [
                "--external-ca"
              ],
              "description": "Specifications of one or more certificate signing endpoints",
              "args": {
                "name": "external-ca"
              }
            },
            {
              "names": [
                "--max-snapshots"
              ],
              "description": "Number of additional Raft snapshots to retain",
              "args": {
                "name": "uint"
              }
            },
            {
              "names": [
                "--snapshot-interval"
              ],
              "description": "Number of log entries between Raft snapshots (default 10000)",
              "args": {
                "name": "uint"
              }
            },
            {
              "names": [
                "--task-history-limit"
              ],
              "description": "Task history retention limit (default 5)",
              "args": {
                "name": "int"
              }
            }
          ]
        }
      ]
    },
    {
      "name": "system",
      "description": "Manage Docker",
      "subcommands": [
        {
          "name": "prune",
          "description": "Remove unused data",
          "options": [
            {
              "names": [
                "-a",
                "--all"
              ],
              "description": "Remove all unused images not just dangling ones"
            },
            {
              "names": [
                "--filter"
              ],
              "description": "Provide filter values (e.g. 'label=<key>=<value')",
              "args": {
                "name": "filter"
              }
            },
            {
              "names": [
                "-f",
                "--force"
              ],
              "description": "Do not prompt for confirmation"
            },
            {
              "names": [
                "--volumes"
              ],
              "description": "Prune volumes"
            }
          ]
        },
        {
          "name": "df",
          "description": "Show docker disk usage",
          "options": [
            {
              "names": [
                "--format"
              ],
              "description": "Pretty-print images using a Go template",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "-v",
                "--verbose"
              ],
              "description": "Show detailed information on space usage"
            }
          ]
        },
        {
          "name": "events",
          "description": "Get real time events from the server",
          "options": [
            {
              "names": [
                "-f",
                "--filter"
              ],
              "description": "Filter output based on conditions provided",
              "args": {
                "name": "filter"
              }
            },
            {
              "names": [
                "--format"
              ],
              "description": "Format the output using the given Go template",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--since"
              ],
              "description": "Show all events created since timestamp",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--until"
              ],
              "description": "Stream events until this timestamp",
              "args": {
                "name": "string"
              }
            }
          ]
        },
        {
          "name": "info",
          "description": "Display system-wide information",
          "options": [
            {
              "names": [
                "-f",
                "--format"
              ],
              "description": "Format the output using the given Go template",
              "args": {
                "name": "string"
              }
            }
          ]
        }
      ]
    },
    {
      "name": "trust",
      "description": "Manage trust on Docker images",
      "subcommands": [
        {
          "name": "inspect",
          "description": "Return low-level information about keys and signatures",
          "options": [
            {
              "names": [
                "--pretty"
              ],
              "description": "Print the information in a human friendly format"
            }
          ],
          "args": [
            {
              "name": "IMAGE[:TAG]",
              "isVariadic": true
            }
          ]
        },
        {
          "name": "revoke",
          "description": "Remove trust for an image",
          "options": [
            {
              "names": [
                "-y",
                "--yes"
              ],
              "description": "Do not prompt for confirmation"
            }
          ],
          "args": [
            {
              "name": "image",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "image",
                    "ls",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "sign",
          "description": "Sign an image",
          "options": [
            {
              "names": [
                "--local"
              ],
              "description": "Sign a locally tagged image"
            }
          ],
          "args": [
            {
              "name": "image",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "image",
                    "ls",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "volume",
      "description": "Manage volumes",
      "subcommands": [
        {
          "name": "create",
          "description": "Create a volume",
          "options": [
            {
              "names": [
                "-d",
                "--driver"
              ],
              "description": "Specify volume driver name (default \"local\")",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "--label"
              ],
              "description": "Set metadata for a volume",
              "args": {
                "name": "list"
              }
            },
            {
              "names": [
                "-o",
                "--opt"
              ],
              "description": "Set driver specific options (default map[])",
              "args": {
                "name": "map"
              }
            }
          ],
          "args": [
            {
              "name": "VOLUME"
            }
          ]
        },
        {
          "name": "inspect",
          "description": "Display detailed information on one or more volumes",
          "options": [
            {
              "names": [
                "-f",
                "--format"
              ],
              "description": "Format the output using the given Go template",
              "args": {
                "name": "string"
              }
            }
          ],
          "args": [
            {
              "name": "VOLUME",
              "isVariadic": true,
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "volume",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "ls",
          "description": "List volumes",
          "options": [
            {
              "names": [
                "-f",
                "--filter"
              ],
              "description": "Provide filter values (e.g. 'dangling=true')",
              "args": {
                "name": "filter"
              }
            },
            {
              "names": [
                "--format"
              ],
              "description": "Pretty-print volumes using a Go template",
              "args": {
                "name": "string"
              }
            },
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "Only display volume names"
            }
          ]
        },
        {
          "name": "prune",
          "description": "Remove all unused local volumes",
          "options": [
            {
              "names": [
                "--filter"
              ],
              "description": "Provide filter values (e.g. 'label=<label>')",
              "args": {
                "name": "filter"
              }
            },
            {
              "names": [
                "-f",
                "--force"
              ],
              "description": "Do not prompt for confirmation"
            }
          ]
        },
        {
          "name": "rm",
          "description": "Remove one or more volumes",
          "options": [
            {
              "names": [
                "-f",
                "--force"
              ],
              "description": "Force the removal of one or more volumes"
            }
          ],
          "args": [
            {
              "name": "VOLUME",
              "isVariadic": true,
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "docker",
                    "volume",
                    "list",
                    "--format",
                    "{{ json . }}"
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "compose",
      "description": "Define and run multi-container applications with Docker",
      "generators": []
    }
  ]
};
