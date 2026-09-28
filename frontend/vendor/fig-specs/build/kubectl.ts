// 由 scripts/sync_fig_specs.mjs 生成（withfig/autocomplete @ aef52acff84c45edde61ae610cc2c964802b9a38）——纯数据，勿手改。
// 归一化形态见 src/lib/completion/fig/types.ts；重生成：pnpm fig:sync
import type { FigSpecRoot } from "../../../src/lib/completion/fig/types";

export const spec: FigSpecRoot = {
  "name": "kubectl",
  "subcommands": [
    {
      "name": "alpha",
      "description": "These commands correspond to alpha features that are not enabled in Kubernetes clusters by default",
      "subcommands": [
        {
          "name": "debug",
          "description": "Tools for debugging Kubernetes resources",
          "options": [
            {
              "names": [
                "--arguments-only"
              ],
              "description": "If specified, everything after -- will be passed to the new container as Args instead of Command"
            },
            {
              "names": [
                "--attach"
              ],
              "description": "If true, wait for the Pod to start running, and then attach to the Pod as if 'kubectl attach ...' were called.  Default false, unless '-i/--stdin' is set, in which case the default is true"
            },
            {
              "names": [
                "--container"
              ],
              "description": "Container name to use for debug container"
            },
            {
              "names": [
                "--env"
              ],
              "description": "Environment variables to set in the container"
            },
            {
              "names": [
                "--image"
              ],
              "description": "Container image to use for debug container"
            },
            {
              "names": [
                "--image-pull-policy"
              ],
              "description": "The image pull policy for the container"
            },
            {
              "names": [
                "--quiet"
              ],
              "description": "If true, suppress prompt messages"
            },
            {
              "names": [
                "-i",
                "--stdin"
              ],
              "description": "Keep stdin open on the container(s) in the pod, even if nothing is attached"
            },
            {
              "names": [
                "--target"
              ],
              "description": "Target processes in this container name"
            },
            {
              "names": [
                "-t",
                "--tty"
              ],
              "description": "Allocated a TTY for each container in the pod"
            }
          ]
        }
      ]
    },
    {
      "name": "annotate",
      "description": "Update the annotations on one or more resources",
      "options": [
        {
          "names": [
            "-f",
            "--filename"
          ],
          "description": "Filename, directory, or URL to files identifying the resource",
          "args": {
            "name": "File"
          }
        },
        {
          "names": [
            "-k",
            "--kustomize"
          ],
          "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
          "args": {
            "name": "Kustomize Dir"
          }
        },
        {
          "names": [
            "-o",
            "--output"
          ],
          "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
          "args": {
            "name": "Output Format",
            "suggestions": [
              "json",
              "yaml",
              "name",
              "go-template",
              "go-template-file",
              "template",
              "templatefile",
              "jsonpath",
              "jsonpath-file"
            ]
          }
        },
        {
          "names": [
            "--resource-version"
          ],
          "description": "If non-empty, the annotation update will only succeed if this is the current resource-version for the object. Only valid when specifying a single resource"
        },
        {
          "names": [
            "--dry-run"
          ],
          "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
          "args": {
            "name": "Strategy",
            "suggestions": [
              "none",
              "server",
              "client"
            ]
          }
        },
        {
          "names": [
            "--field-selector"
          ],
          "description": "Selector (field query) to filter on, supports '=', '==', and '!='.(e.g. --field-selector key1=value1,key2=value2). The server only supports a limited number of field queries per type"
        },
        {
          "names": [
            "--local"
          ],
          "description": "If true, annotation will NOT contact api-server but run locally"
        },
        {
          "names": [
            "--all"
          ],
          "description": "Select all resources, including uninitialized ones, in the namespace of the specified resource types"
        },
        {
          "names": [
            "--allow-missing-template-keys"
          ],
          "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
        },
        {
          "names": [
            "-R",
            "--recursive"
          ],
          "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
        },
        {
          "names": [
            "-l",
            "--selector"
          ],
          "description": "Selector (label query) to filter on, not including uninitialized ones, supports '=', '==', and '!='.(e.g. -l key1=value1,key2=value2)"
        },
        {
          "names": [
            "--template"
          ],
          "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
        },
        {
          "names": [
            "--overwrite"
          ],
          "description": "If true, allow annotations to be overwritten, otherwise reject annotation updates that overwrite existing annotations"
        },
        {
          "names": [
            "--record"
          ],
          "description": "Record current kubectl command in the resource annotation. If set to false, do not record the command. If set to true, record the command. If not set, default to updating the existing annotation value only if one already exists"
        }
      ],
      "args": [
        {
          "name": "Resource Type",
          "generators": [
            {
              "kind": "script",
              "script": [
                "kubectl",
                "api-resources",
                "-o",
                "name"
              ]
            }
          ]
        },
        {
          "name": "Resource",
          "isOptional": true
        },
        {
          "name": "KEY=VAL",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "api-resources",
      "description": "Print the supported API resources on the server",
      "options": [
        {
          "names": [
            "-o",
            "--output"
          ],
          "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
          "args": {
            "name": "Output Format",
            "suggestions": [
              "json",
              "yaml",
              "name",
              "go-template",
              "go-template-file",
              "template",
              "templatefile",
              "jsonpath",
              "jsonpath-file"
            ]
          }
        },
        {
          "names": [
            "--api-group"
          ],
          "description": "Limit to resources in the specified API group"
        },
        {
          "names": [
            "--cached"
          ],
          "description": "Use the cached list of resources if available"
        },
        {
          "names": [
            "--namespaced"
          ],
          "description": "If false, non-namespaced resources will be returned, otherwise returning namespaced resources by default"
        },
        {
          "names": [
            "--no-headers"
          ],
          "description": "When using the default or custom-column output format, don't print headers (default print headers)"
        },
        {
          "names": [
            "--sort-by"
          ],
          "description": "If non-empty, sort nodes list using specified field. The field can be either 'name' or 'kind'"
        },
        {
          "names": [
            "--verbs"
          ],
          "description": "Limit to resources that support the specified verbs"
        }
      ]
    },
    {
      "name": "api-versions",
      "description": "Print the supported API versions on the server, in the form of \"group/version\""
    },
    {
      "name": "apply",
      "description": "Apply a configuration to a resource by filename or stdin. The resource name must be specified. This resource will be created if it doesn't exist yet. To use 'apply', always create the resource initially with either 'apply' or 'create --save-config'",
      "subcommands": [
        {
          "name": "edit-last-applied",
          "description": "Edit the latest last-applied-configuration annotations of resources from the default editor",
          "options": [
            {
              "names": [
                "--allow-missing-template-keys"
              ],
              "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
            },
            {
              "names": [
                "-f",
                "--filename"
              ],
              "description": "Filename, directory, or URL to files identifying the resource",
              "args": {
                "name": "File"
              }
            },
            {
              "names": [
                "-k",
                "--kustomize"
              ],
              "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
              "args": {
                "name": "Kustomize Dir"
              }
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "--record"
              ],
              "description": "Record current kubectl command in the resource annotation. If set to false, do not record the command. If set to true, record the command. If not set, default to updating the existing annotation value only if one already exists"
            },
            {
              "names": [
                "-R",
                "--recursive"
              ],
              "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
            },
            {
              "names": [
                "--template"
              ],
              "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
            },
            {
              "names": [
                "--windows-line-endings"
              ],
              "description": "Defaults to the line ending native to your platform"
            },
            {
              "names": [
                "--field-manager"
              ],
              "description": "Name of the manager used to track field ownership"
            },
            {
              "names": [
                "--show-manged-fields"
              ],
              "description": "If true, keep the managedFields when printing objects in JSON or YAML format"
            }
          ],
          "args": [
            {
              "name": "TYPE | TYPE/NAME"
            },
            {
              "name": "Resource",
              "isOptional": true
            }
          ]
        },
        {
          "name": "set-last-applied",
          "description": "Set the latest last-applied-configuration annotations by setting it to match the contents of a file. This results in the last-applied-configuration being updated as though 'kubectl apply -f<file> ' was run, without updating any other parts of the object",
          "options": [
            {
              "names": [
                "--allow-missing-template-keys"
              ],
              "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
            },
            {
              "names": [
                "-f",
                "--filename"
              ],
              "description": "Filename, directory, or URL to files identifying the resource",
              "args": {
                "name": "File"
              }
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "--template"
              ],
              "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
            },
            {
              "names": [
                "--show-manged-fields"
              ],
              "description": "If true, keep the managedFields when printing objects in JSON or YAML format"
            },
            {
              "names": [
                "--create-annotation"
              ],
              "description": "Will create 'last-applied-configuration' annotations if current objects doesn't have one"
            }
          ]
        },
        {
          "name": "view-last-applied",
          "description": "View the latest last-applied-configuration annotations by type/name or file",
          "options": [
            {
              "names": [
                "--all"
              ],
              "description": "Select all resources, including uninitialized ones, in the namespace of the specified resource types"
            },
            {
              "names": [
                "-f",
                "--filename"
              ],
              "description": "Filename, directory, or URL to files identifying the resource",
              "args": {
                "name": "File"
              }
            },
            {
              "names": [
                "-k",
                "--kustomize"
              ],
              "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
              "args": {
                "name": "Kustomize Dir"
              }
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "-R",
                "--recursive"
              ],
              "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
            },
            {
              "names": [
                "-l",
                "--selector"
              ],
              "description": "Selector (label query) to filter on, not including uninitialized ones, supports '=', '==', and '!='.(e.g. -l key1=value1,key2=value2)"
            }
          ],
          "args": [
            {
              "name": "TYPE | TYPE/NAME"
            },
            {
              "name": "Resource",
              "isOptional": true
            }
          ]
        }
      ],
      "options": [
        {
          "names": [
            "-f",
            "--filename"
          ],
          "description": "Filename, directory, or URL to files identifying the resource",
          "args": {
            "name": "File"
          }
        },
        {
          "names": [
            "-k",
            "--kustomize"
          ],
          "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
          "args": {
            "name": "Kustomize Dir"
          }
        },
        {
          "names": [
            "-o",
            "--output"
          ],
          "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
          "args": {
            "name": "Output Format",
            "suggestions": [
              "json",
              "yaml",
              "name",
              "go-template",
              "go-template-file",
              "template",
              "templatefile",
              "jsonpath",
              "jsonpath-file"
            ]
          }
        },
        {
          "names": [
            "--resource-version"
          ],
          "description": "If non-empty, the annotation update will only succeed if this is the current resource-version for the object. Only valid when specifying a single resource"
        },
        {
          "names": [
            "--dry-run"
          ],
          "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
          "args": {
            "name": "Strategy",
            "suggestions": [
              "none",
              "server",
              "client"
            ]
          }
        },
        {
          "names": [
            "--field-selector"
          ],
          "description": "Selector (field query) to filter on, supports '=', '==', and '!='.(e.g. --field-selector key1=value1,key2=value2). The server only supports a limited number of field queries per type"
        },
        {
          "names": [
            "--local"
          ],
          "description": "If true, annotation will NOT contact api-server but run locally"
        },
        {
          "names": [
            "--all"
          ],
          "description": "Select all resources, including uninitialized ones, in the namespace of the specified resource types"
        },
        {
          "names": [
            "--allow-missing-template-keys"
          ],
          "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
        },
        {
          "names": [
            "-R",
            "--recursive"
          ],
          "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
        },
        {
          "names": [
            "-l",
            "--selector"
          ],
          "description": "Selector (label query) to filter on, not including uninitialized ones, supports '=', '==', and '!='.(e.g. -l key1=value1,key2=value2)"
        },
        {
          "names": [
            "--template"
          ],
          "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
        },
        {
          "names": [
            "--overwrite"
          ],
          "description": "If true, allow annotations to be overwritten, otherwise reject annotation updates that overwrite existing annotations"
        },
        {
          "names": [
            "--record"
          ],
          "description": "Record current kubectl command in the resource annotation. If set to false, do not record the command. If set to true, record the command. If not set, default to updating the existing annotation value only if one already exists"
        },
        {
          "names": [
            "--cascade"
          ],
          "description": "If true, cascade the deletion of the resources managed by this resource (e.g. Pods created by a ReplicationController). Default true"
        },
        {
          "names": [
            "--field-manager"
          ],
          "description": "Name of the manager used to track field ownership"
        },
        {
          "names": [
            "--force"
          ],
          "description": "If true, immediately remove resources from API and bypass graceful deletion. Note that immediate deletion of some resources may result in inconsistency or data loss and requires confirmation"
        },
        {
          "names": [
            "--force-conflicts"
          ],
          "description": "If true, server-side apply will force the changes against conflicts"
        },
        {
          "names": [
            "--grace-period"
          ],
          "description": "Period of time in seconds given to the resource to terminate gracefully. Ignored if negative. Set to 1 for immediate shutdown. Can only be set to 0 when --force is true (force deletion)",
          "args": {
            "name": "INT (seconds)"
          }
        },
        {
          "names": [
            "--openapi-patch"
          ],
          "description": "If true, use openapi to calculate diff when the openapi presents and the resource can be found in the openapi spec. Otherwise, fall back to use baked-in types"
        },
        {
          "names": [
            "--overwrite"
          ],
          "description": "Automatically resolve conflicts between the modified and live configuration by using values from the modified configuration"
        },
        {
          "names": [
            "--prune"
          ],
          "description": "Automatically delete resource objects, including the uninitialized ones, that do not appear in the configs and are created by either apply or create --save-config. Should be used with either -l or --all"
        },
        {
          "names": [
            "--prune-whitelist"
          ],
          "description": "Overwrite the default whitelist with <group/version/kind> for --prune",
          "args": {
            "name": "group/version/kind"
          }
        },
        {
          "names": [
            "--server-side"
          ],
          "description": "If true, apply runs in the server instead of the client"
        },
        {
          "names": [
            "--timeout"
          ],
          "description": "The length of time to wait before giving up on a delete, zero means determine a timeout from the size of the object",
          "args": {
            "name": "INT (Seconds)"
          }
        },
        {
          "names": [
            "--validate"
          ],
          "description": "If true, use a schema to validate the input before sending it"
        },
        {
          "names": [
            "--wait"
          ],
          "description": "If true, wait for resources to be gone before returning. This waits for finalizers"
        }
      ]
    },
    {
      "name": "attach",
      "description": "Attach to a process that is already running inside an existing container",
      "options": [
        {
          "names": [
            "-c",
            "--container"
          ],
          "description": "Container name. If omitted, the first container in the pod will be chosen",
          "args": {
            "name": "Container"
          }
        },
        {
          "names": [
            "--pod-running-timeout"
          ],
          "description": "The length of time (like 5s, 2m, or 3h, higher than zero) to wait until at least one pod is running"
        },
        {
          "names": [
            "-i",
            "--stdin"
          ],
          "description": "Pass stdin to the container"
        },
        {
          "names": [
            "-t",
            "--tty"
          ],
          "description": "Stdin is a TTY"
        }
      ],
      "args": [
        {
          "name": "Running Pods",
          "generators": [
            {
              "kind": "script",
              "script": [
                "kubectl",
                "get",
                "pods",
                "--field-selector=status.phase=Running",
                "-o",
                "name"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "auth",
      "description": "Inspect authorization",
      "subcommands": [
        {
          "name": "can-i",
          "description": "Check whether an action is allowed",
          "options": [
            {
              "names": [
                "-A",
                "--all-namespaces"
              ],
              "description": "If true, check the specified action in all namespaces"
            },
            {
              "names": [
                "--list"
              ],
              "description": "If true, prints all allowed actions"
            },
            {
              "names": [
                "--no-headers"
              ],
              "description": "If true, prints allowed actions without headers"
            },
            {
              "names": [
                "-q",
                "--quiet"
              ],
              "description": "If true, suppress output and just return the exit code"
            },
            {
              "names": [
                "--subresource"
              ],
              "description": "SubResource such as pod/log or deployment/scale"
            }
          ],
          "args": [
            {
              "name": "VERB",
              "suggestions": [
                "*",
                "get",
                "list",
                "watch",
                "delete",
                "create",
                "update",
                "patch"
              ]
            },
            {
              "name": "TYPE | TYPE/NAME"
            },
            {
              "name": "Resource",
              "isOptional": true
            }
          ]
        },
        {
          "name": "reconcile",
          "description": "Reconciles rules for RBAC Role, RoleBinding, ClusterRole, and ClusterRole binding objects",
          "options": [
            {
              "names": [
                "--allow-missing-template-keys"
              ],
              "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
            },
            {
              "names": [
                "--dry-run"
              ],
              "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
              "args": {
                "name": "Strategy",
                "suggestions": [
                  "none",
                  "server",
                  "client"
                ]
              }
            },
            {
              "names": [
                "-f",
                "--filename"
              ],
              "description": "Filename, directory, or URL to files identifying the resource",
              "args": {
                "name": "File"
              }
            },
            {
              "names": [
                "-k",
                "--kustomize"
              ],
              "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
              "args": {
                "name": "Kustomize Dir"
              }
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "-R",
                "--recursive"
              ],
              "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
            },
            {
              "names": [
                "--template"
              ],
              "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
            },
            {
              "names": [
                "--remove-extra-permissions"
              ],
              "description": "If true, removes extra permissions added to roles"
            },
            {
              "names": [
                "--remove-extra-subjects"
              ],
              "description": "If true, removes extra subjects added to rolebindings"
            },
            {
              "names": [
                "--show-managed-fields"
              ],
              "description": "If true, keep the managedFields when printing objects in JSON or YAML format"
            }
          ]
        }
      ]
    },
    {
      "name": "autoscale",
      "description": "Creates an autoscaler that automatically chooses and sets the number of pods that run in a kubernetes cluster",
      "options": [
        {
          "names": [
            "--allow-missing-template-keys"
          ],
          "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
        },
        {
          "names": [
            "-o",
            "--output"
          ],
          "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
          "args": {
            "name": "Output Format",
            "suggestions": [
              "json",
              "yaml",
              "name",
              "go-template",
              "go-template-file",
              "template",
              "templatefile",
              "jsonpath",
              "jsonpath-file"
            ]
          }
        },
        {
          "names": [
            "--record"
          ],
          "description": "Record current kubectl command in the resource annotation. If set to false, do not record the command. If set to true, record the command. If not set, default to updating the existing annotation value only if one already exists"
        },
        {
          "names": [
            "-R",
            "--recursive"
          ],
          "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
        },
        {
          "names": [
            "--dry-run"
          ],
          "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
          "args": {
            "name": "Strategy",
            "suggestions": [
              "none",
              "server",
              "client"
            ]
          }
        },
        {
          "names": [
            "-f",
            "--filename"
          ],
          "description": "Filename, directory, or URL to files identifying the resource",
          "args": {
            "name": "File"
          }
        },
        {
          "names": [
            "-k",
            "--kustomize"
          ],
          "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
          "args": {
            "name": "Kustomize Dir"
          }
        },
        {
          "names": [
            "--template"
          ],
          "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
        },
        {
          "names": [
            "--cpu-percent"
          ],
          "description": "The target average CPU utilization (represented as a percent of requested CPU) over all the pods. If it's not specified or negative, a default autoscaling policy will be used",
          "args": {
            "name": "INT (Percent)"
          }
        },
        {
          "names": [
            "--generator"
          ],
          "description": "The name of the API generator to use. Currently there is only 1 generator"
        },
        {
          "names": [
            "--max"
          ],
          "description": "The upper limit for the number of pods that can be set by the autoscaler. Required",
          "args": {
            "name": "INT"
          }
        },
        {
          "names": [
            "--min"
          ],
          "description": "The lower limit for the number of pods that can be set by the autoscaler. If it's not specified or negative, the server will apply a default value",
          "args": {
            "name": "INT"
          }
        },
        {
          "names": [
            "--name"
          ],
          "description": "The name for the newly created object. If not specified, the name of the input resource will be used"
        },
        {
          "names": [
            "--save-config"
          ],
          "description": "If true, the configuration of current object will be saved in its annotation. Otherwise, the annotation will be unchanged. This flag is useful when you want to perform kubectl apply on this object in the future"
        }
      ],
      "args": [
        {
          "name": "TYPE | TYPE/NAME"
        },
        {
          "name": "Resource",
          "isOptional": true
        }
      ]
    },
    {
      "name": "certificate",
      "description": "Modify certificate resources",
      "subcommands": [
        {
          "name": "approve",
          "description": "Approve a certificate signing request",
          "options": [
            {
              "names": [
                "--allow-missing-template-keys"
              ],
              "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
            },
            {
              "names": [
                "-f",
                "--filename"
              ],
              "description": "Filename, directory, or URL to files identifying the resource",
              "args": {
                "name": "File"
              }
            },
            {
              "names": [
                "-k",
                "--kustomize"
              ],
              "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
              "args": {
                "name": "Kustomize Dir"
              }
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "-R",
                "--recursive"
              ],
              "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
            },
            {
              "names": [
                "--template"
              ],
              "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
            },
            {
              "names": [
                "--force"
              ],
              "description": "Update the CSR even if it is already approved"
            }
          ],
          "args": [
            {
              "name": "NAME"
            }
          ]
        },
        {
          "name": "deny",
          "description": "Deny a certificate signing request",
          "options": [
            {
              "names": [
                "--allow-missing-template-keys"
              ],
              "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
            },
            {
              "names": [
                "-f",
                "--filename"
              ],
              "description": "Filename, directory, or URL to files identifying the resource",
              "args": {
                "name": "File"
              }
            },
            {
              "names": [
                "-k",
                "--kustomize"
              ],
              "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
              "args": {
                "name": "Kustomize Dir"
              }
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "-R",
                "--recursive"
              ],
              "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
            },
            {
              "names": [
                "--template"
              ],
              "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
            },
            {
              "names": [
                "--force"
              ],
              "description": "Update the CSR even if it is already approved"
            }
          ],
          "args": [
            {
              "name": "NAME"
            }
          ]
        }
      ]
    },
    {
      "name": "cluster-info",
      "description": "Display addresses of the master and services with label kubernetes.io/cluster-service=true To further debug and diagnose cluster problems, use 'kubectl cluster-info dump'",
      "subcommands": [
        {
          "name": "dump",
          "description": "Dumps cluster info out suitable for debugging and diagnosing cluster problems.  By default, dumps everything to stdout. You can optionally specify a directory with --output-directory.  If you specify a directory, kubernetes will build a set of files in that directory.  By default only dumps things in the 'kube-system' namespace, but you can switch to a different namespace with the --namespaces flag, or specify --all-namespaces to dump all namespaces",
          "options": [
            {
              "names": [
                "--allow-missing-template-keys"
              ],
              "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "--template"
              ],
              "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
            },
            {
              "names": [
                "-A",
                "--all-namespaces"
              ],
              "description": "If true, dump all namespaces.  If true, --namespaces is ignored"
            },
            {
              "names": [
                "--namespaces"
              ],
              "description": "A comma separated list of namespaces to dump",
              "args": {
                "name": "Namespaces (Comma separated)"
              }
            },
            {
              "names": [
                "--output-directory"
              ],
              "description": "Where to output the files.  If empty or '-' uses stdout, otherwise creates a directory hierarchy in that directory"
            },
            {
              "names": [
                "--pod-running-timeout"
              ],
              "description": "The length of time (like 5s, 2m, or 3h, higher than zero) to wait until at least one pod is running",
              "args": {
                "name": "Length of Time"
              }
            },
            {
              "names": [
                "--show-managed-fields"
              ],
              "description": "If true, keep the managedFields when printing objects in JSON or YAML format"
            }
          ]
        }
      ]
    },
    {
      "name": "completion",
      "description": "Output shell completion code for the specified shell (bash or zsh). The shell code must be evaluated to provide interactive completion of kubectl commands.  This can be done by sourcing it from the .bash_profile"
    },
    {
      "name": "config",
      "description": "Modify kubeconfig files using subcommands like \"kubectl config set current-context my-context\"",
      "subcommands": [
        {
          "name": "current-context",
          "description": "Displays the current-context"
        },
        {
          "name": "delete-cluster",
          "description": "Delete the specified cluster from the kubeconfig",
          "args": [
            {
              "name": "Cluster"
            }
          ]
        },
        {
          "name": "delete-context",
          "description": "Delete the specified context from the kubeconfig",
          "args": [
            {
              "name": "Context"
            }
          ]
        },
        {
          "name": "get-clusters",
          "description": "Display clusters defined in the kubeconfig"
        },
        {
          "name": "get-contexts",
          "description": "Displays one or many contexts from the kubeconfig file",
          "options": [
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "--no-headers"
              ],
              "description": "When using the default or custom-column output format, don't print headers (default print headers)"
            }
          ],
          "args": [
            {
              "name": "Context",
              "isOptional": true
            }
          ]
        },
        {
          "name": "get-users",
          "description": "Display users defined in the kubeconfig"
        },
        {
          "name": "rename-context",
          "description": "Renames a context from the kubeconfig file",
          "args": [
            {
              "name": "Context"
            },
            {
              "name": "New Context Name"
            }
          ]
        },
        {
          "name": "set",
          "description": "Sets an individual value in a kubeconfig file",
          "options": [
            {
              "names": [
                "--set-raw-bytes"
              ],
              "description": "When writing a []byte PROPERTY_VALUE, write the given string directly without base64 decoding"
            }
          ],
          "args": [
            {
              "name": "PROPERTY_NAME"
            },
            {
              "name": "PROPERTY_VALUE"
            }
          ]
        },
        {
          "name": "set-cluster",
          "description": "Sets a cluster entry in kubeconfig",
          "options": [
            {
              "names": [
                "--embed-certs"
              ],
              "description": "Embed-certs for the cluster entry in kubeconfig"
            },
            {
              "names": [
                "--server"
              ],
              "args": {
                "name": "Server"
              }
            },
            {
              "names": [
                "--certificate-authority"
              ],
              "description": "Path to certificate authority",
              "args": {
                "name": "Certificate Authority"
              }
            },
            {
              "names": [
                "--insecure-skip-tls-verify"
              ],
              "args": {
                "suggestions": [
                  "true",
                  "false"
                ]
              }
            },
            {
              "names": [
                "--tls-server-name"
              ],
              "args": {
                "name": "TLS Server Name"
              }
            }
          ],
          "args": [
            {
              "name": "NAME"
            }
          ]
        },
        {
          "name": "set-context",
          "description": "Sets a context entry in kubeconfig",
          "options": [
            {
              "names": [
                "--current"
              ],
              "description": "Modify the current context"
            },
            {
              "names": [
                "--cluster"
              ],
              "args": {
                "name": "cluster_nickname"
              }
            },
            {
              "names": [
                "--user"
              ],
              "args": {
                "name": "user_nickname"
              }
            },
            {
              "names": [
                "--namespace"
              ],
              "args": {
                "name": "namespace"
              }
            }
          ],
          "args": [
            {
              "name": "Context"
            }
          ]
        },
        {
          "name": "set-credentials",
          "description": "Sets a user entry in kubeconfig",
          "options": [
            {
              "names": [
                "--client-certificate"
              ],
              "description": "Client cert for user entry"
            },
            {
              "names": [
                "--client-key"
              ],
              "description": "Client key for user entry"
            },
            {
              "names": [
                "--token"
              ],
              "description": "Bearer Token for user entry",
              "args": {
                "name": "Bearer Token"
              }
            },
            {
              "names": [
                "--username"
              ],
              "description": "Username for basic authentication",
              "args": {
                "name": "Username"
              }
            },
            {
              "names": [
                "--password"
              ],
              "description": "Password for basic authentication",
              "args": {
                "name": "Password"
              }
            },
            {
              "names": [
                "--auth-provider"
              ],
              "description": "Auth provider for the user entry in kubeconfig",
              "args": {
                "name": "Auth Provider"
              }
            },
            {
              "names": [
                "--auth-provider-arg"
              ],
              "description": "'key=value' arguments for the auth provider",
              "args": {
                "name": "key=value"
              }
            },
            {
              "names": [
                "--embed-certs"
              ],
              "description": "Embed client cert/key for the user entry in kubeconfig"
            },
            {
              "names": [
                "--exec-api-version"
              ],
              "description": "API version of the exec credential plugin for the user entry in kubeconfig",
              "args": {
                "name": "API Version"
              }
            },
            {
              "names": [
                "--exec-arg"
              ],
              "description": "New arguments for the exec credential plugin command for the user entry in kubeconfig",
              "args": {
                "name": "Exec Arg"
              }
            },
            {
              "names": [
                "--exec-command"
              ],
              "description": "Command for the exec credential plugin for the user entry in kubeconfig",
              "args": {
                "name": "Exec Command"
              }
            },
            {
              "names": [
                "--exec-env"
              ],
              "description": "'key=value' environment values for the exec credential plugin",
              "args": {
                "name": "key=value"
              }
            }
          ],
          "args": [
            {
              "name": "Cluster"
            }
          ]
        },
        {
          "name": "unset",
          "description": "Unsets an individual value in a kubeconfig file",
          "args": [
            {
              "name": "PROPERTY_NAME"
            }
          ]
        },
        {
          "name": "use-context",
          "description": "Sets the current-context in a kubeconfig file",
          "args": [
            {
              "name": "Context"
            }
          ]
        },
        {
          "name": "view",
          "description": "Display merged kubeconfig settings or a specified kubeconfig file",
          "options": [
            {
              "names": [
                "--allow-missing-template-keys"
              ],
              "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "--template"
              ],
              "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
            },
            {
              "names": [
                "--flatten"
              ],
              "description": "Flatten the resulting kubeconfig file into self-contained output (useful for creating portable kubeconfig files)"
            },
            {
              "names": [
                "--merge"
              ],
              "description": "Merge the full hierarchy of kubeconfig files"
            },
            {
              "names": [
                "--minify"
              ],
              "description": "Remove all information not used by current-context from the output"
            },
            {
              "names": [
                "--raw"
              ],
              "description": "Display raw byte data"
            },
            {
              "names": [
                "--show-managed-fields"
              ],
              "description": "If true, keep the managedFields when printing objects in JSON or YAML format"
            }
          ]
        }
      ],
      "options": [
        {
          "names": [
            "--kubeconfig"
          ],
          "args": {
            "name": "path"
          }
        }
      ]
    },
    {
      "name": "convert",
      "description": "Convert config files between different API versions. Both YAML and JSON formats are accepted",
      "options": [
        {
          "names": [
            "--allow-missing-template-keys"
          ],
          "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
        },
        {
          "names": [
            "-f",
            "--filename"
          ],
          "description": "Filename, directory, or URL to files identifying the resource",
          "args": {
            "name": "File"
          }
        },
        {
          "names": [
            "-k",
            "--kustomize"
          ],
          "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
          "args": {
            "name": "Kustomize Dir"
          }
        },
        {
          "names": [
            "-o",
            "--output"
          ],
          "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
          "args": {
            "name": "Output Format",
            "suggestions": [
              "json",
              "yaml",
              "name",
              "go-template",
              "go-template-file",
              "template",
              "templatefile",
              "jsonpath",
              "jsonpath-file"
            ]
          }
        },
        {
          "names": [
            "-R",
            "--recursive"
          ],
          "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
        },
        {
          "names": [
            "--template"
          ],
          "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
        },
        {
          "names": [
            "--local"
          ],
          "description": "If true, convert will NOT try to contact api-server but run locally"
        },
        {
          "names": [
            "--output-version"
          ],
          "description": "Output the formatted object with the given group version (for ex: 'extensions/v1beta1')"
        },
        {
          "names": [
            "--validate"
          ],
          "description": "If true, use a schema to validate the input before sending it"
        }
      ]
    },
    {
      "name": "cordon",
      "description": "Mark node as unschedulable",
      "options": [
        {
          "names": [
            "--dry-run"
          ],
          "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
          "args": {
            "name": "Strategy",
            "suggestions": [
              "none",
              "server",
              "client"
            ]
          }
        },
        {
          "names": [
            "-l",
            "--selector"
          ],
          "description": "Selector (label query) to filter on, not including uninitialized ones, supports '=', '==', and '!='.(e.g. -l key1=value1,key2=value2)"
        }
      ],
      "args": [
        {
          "name": "Node",
          "generators": [
            {
              "kind": "script",
              "script": [
                "kubectl",
                "get",
                "nodes",
                "-o",
                "custom-columns=:.metadata.name"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "cp",
      "description": "Copy files and directories to and from containers",
      "options": [
        {
          "names": [
            "-c",
            "--container"
          ],
          "description": "Container name. If omitted, the first container in the pod will be chosen"
        },
        {
          "names": [
            "--no-preserve"
          ],
          "description": "The copied file/directory's ownership and permissions will not be preserved in the container"
        }
      ]
    },
    {
      "name": "create",
      "description": "Create a resource from a file or from stdin",
      "subcommands": [
        {
          "name": "clusterrole",
          "description": "Create a ClusterRole",
          "options": [
            {
              "names": [
                "--allow-missing-template-keys"
              ],
              "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
            },
            {
              "names": [
                "--dry-run"
              ],
              "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
              "args": {
                "name": "Strategy",
                "suggestions": [
                  "none",
                  "server",
                  "client"
                ]
              }
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "--template"
              ],
              "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
            },
            {
              "names": [
                "--aggregation-rule"
              ],
              "description": "An aggregation label selector for combining ClusterRoles"
            },
            {
              "names": [
                "--non-resource-url"
              ],
              "description": "A partial url that user should have access to"
            },
            {
              "names": [
                "--resource"
              ],
              "description": "Resource that the rule applies to",
              "args": {
                "name": "Resource Type",
                "generators": [
                  {
                    "kind": "script",
                    "script": [
                      "kubectl",
                      "api-resources",
                      "-o",
                      "name"
                    ]
                  }
                ]
              }
            },
            {
              "names": [
                "--resource-name"
              ],
              "description": "Resource in the white list that the rule applies to, repeat this flag for multiple items"
            },
            {
              "names": [
                "--save-config"
              ],
              "description": "If true, the configuration of current object will be saved in its annotation. Otherwise, the annotation will be unchanged. This flag is useful when you want to perform kubectl apply on this object in the future"
            },
            {
              "names": [
                "--validate"
              ],
              "description": "If true, use a schema to validate the input before sending it"
            },
            {
              "names": [
                "--verb"
              ],
              "description": "Verb that applies to the resources contained in the rule",
              "args": {
                "name": "VERB",
                "suggestions": [
                  "*",
                  "get",
                  "list",
                  "watch",
                  "delete",
                  "create",
                  "update",
                  "patch"
                ]
              }
            }
          ],
          "args": [
            {
              "name": "NAME"
            }
          ]
        },
        {
          "name": "clusterrolebinding",
          "description": "Create a ClusterRoleBinding for a particular ClusterRole",
          "options": [
            {
              "names": [
                "--allow-missing-template-keys"
              ],
              "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
            },
            {
              "names": [
                "--dry-run"
              ],
              "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
              "args": {
                "name": "Strategy",
                "suggestions": [
                  "none",
                  "server",
                  "client"
                ]
              }
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "--template"
              ],
              "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
            },
            {
              "names": [
                "--clusterrole"
              ],
              "description": "ClusterRole this ClusterRoleBinding should reference",
              "args": {
                "name": "Cluster Role",
                "generators": [
                  {
                    "kind": "script",
                    "script": [
                      "kubectl",
                      "get",
                      "clusterroles",
                      "-o",
                      "custom-columns=:.metadata.name"
                    ]
                  }
                ]
              }
            },
            {
              "names": [
                "--user"
              ],
              "args": {
                "name": "User Name"
              }
            },
            {
              "names": [
                "--group"
              ],
              "description": "Groups to bind to the clusterrole",
              "args": {
                "name": "Group Name"
              }
            },
            {
              "names": [
                "--save-config"
              ],
              "description": "If true, the configuration of current object will be saved in its annotation. Otherwise, the annotation will be unchanged. This flag is useful when you want to perform kubectl apply on this object in the future"
            },
            {
              "names": [
                "--serviceaccount"
              ],
              "description": "Service accounts to bind to the clusterrole, in the format <namespace>:<name>",
              "args": {
                "name": "<namespace>:<name>"
              }
            },
            {
              "names": [
                "--validate"
              ],
              "description": "If true, use a schema to validate the input before sending it"
            }
          ],
          "args": [
            {
              "name": "NAME"
            }
          ]
        },
        {
          "name": "configmap",
          "description": "Create a configmap based on a file, directory, or specified literal value",
          "options": [
            {
              "names": [
                "--allow-missing-template-keys"
              ],
              "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
            },
            {
              "names": [
                "--dry-run"
              ],
              "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
              "args": {
                "name": "Strategy",
                "suggestions": [
                  "none",
                  "server",
                  "client"
                ]
              }
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "--template"
              ],
              "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
            },
            {
              "names": [
                "--append-hash"
              ],
              "description": "Append a hash of the configmap to its name"
            },
            {
              "names": [
                "--from-env-file"
              ],
              "description": "Specify the path to a file to read lines of key=val pairs to create a configmap (i.e. a Docker .env file)"
            },
            {
              "names": [
                "--from-file"
              ],
              "description": "Key file can be specified using its file path, in which case file basename will be used as configmap key, or optionally with a key and file path, in which case the given key will be used.  Specifying a directory will iterate each named file in the directory whose basename is a valid configmap key"
            },
            {
              "names": [
                "--from-literal"
              ],
              "description": "Specify a key and literal value to insert in configmap (i.e. mykey=somevalue)",
              "args": {
                "name": "key=value"
              }
            },
            {
              "names": [
                "--save-config"
              ],
              "description": "If true, the configuration of current object will be saved in its annotation. Otherwise, the annotation will be unchanged. This flag is useful when you want to perform kubectl apply on this object in the future"
            },
            {
              "names": [
                "--validate"
              ],
              "description": "If true, use a schema to validate the input before sending it"
            }
          ],
          "args": [
            {
              "name": "NAME"
            }
          ]
        },
        {
          "name": "cronjob",
          "description": "Create a cronjob with the specified name",
          "options": [
            {
              "names": [
                "--allow-missing-template-keys"
              ],
              "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
            },
            {
              "names": [
                "--dry-run"
              ],
              "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
              "args": {
                "name": "Strategy",
                "suggestions": [
                  "none",
                  "server",
                  "client"
                ]
              }
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "--template"
              ],
              "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
            },
            {
              "names": [
                "--image"
              ],
              "description": "Image name to run",
              "args": {
                "name": "Image"
              }
            },
            {
              "names": [
                "--restart"
              ],
              "description": "Job's restart policy. supported values: OnFailure, Never",
              "args": {
                "suggestions": [
                  "OnFailure",
                  "Never"
                ]
              }
            },
            {
              "names": [
                "--save-config"
              ],
              "description": "If true, the configuration of current object will be saved in its annotation. Otherwise, the annotation will be unchanged. This flag is useful when you want to perform kubectl apply on this object in the future"
            },
            {
              "names": [
                "--schedule"
              ],
              "description": "A schedule in the Cron format the job should be run with",
              "args": {
                "name": "Cron"
              }
            },
            {
              "names": [
                "--validate"
              ],
              "description": "If true, use a schema to validate the input before sending it"
            }
          ],
          "args": [
            {
              "name": "NAME"
            }
          ]
        },
        {
          "name": "deployment",
          "description": "Create a deployment with the specified name",
          "options": [
            {
              "names": [
                "--allow-missing-template-keys"
              ],
              "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
            },
            {
              "names": [
                "--dry-run"
              ],
              "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
              "args": {
                "name": "Strategy",
                "suggestions": [
                  "none",
                  "server",
                  "client"
                ]
              }
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "--template"
              ],
              "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
            },
            {
              "names": [
                "--image"
              ],
              "description": "Image name to run",
              "args": {
                "name": "Image"
              }
            },
            {
              "names": [
                "--save-config"
              ],
              "description": "If true, the configuration of current object will be saved in its annotation. Otherwise, the annotation will be unchanged. This flag is useful when you want to perform kubectl apply on this object in the future"
            },
            {
              "names": [
                "--validate"
              ],
              "description": "If true, use a schema to validate the input before sending it"
            }
          ],
          "args": [
            {
              "name": "NAME"
            }
          ]
        },
        {
          "name": "ingress",
          "description": "Create an ingress with the specified name",
          "options": [
            {
              "names": [
                "--allow-missing-template-keys"
              ],
              "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
            },
            {
              "names": [
                "--dry-run"
              ],
              "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
              "args": {
                "name": "Strategy",
                "suggestions": [
                  "none",
                  "server",
                  "client"
                ]
              }
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "--template"
              ],
              "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
            },
            {
              "names": [
                "--annotation"
              ],
              "description": "Annotation to insert in the ingress object, in the format annotation=value",
              "args": {
                "name": "annotation=value"
              }
            },
            {
              "names": [
                "--class"
              ],
              "description": "Ingress Class to be used"
            },
            {
              "names": [
                "--default-backend"
              ],
              "description": "Default service for backend, in format of svcname:port",
              "args": {
                "name": "svcname:port"
              }
            },
            {
              "names": [
                "--field-manager"
              ],
              "description": "Name of the manager used to track field ownership"
            },
            {
              "names": [
                "--rule"
              ],
              "description": "Rule in format host/path=service:port[,tls=secretname]. Paths containing the leading character '*' are considered pathType=Prefix. tls argument is optional",
              "args": {
                "name": "host/path=service:port[,tls=secretname]"
              }
            },
            {
              "names": [
                "--show-managed-fields"
              ],
              "description": "If true, keep the managedFields when printing objects in JSON or YAML format"
            },
            {
              "names": [
                "--validate"
              ],
              "description": "If true, use a schema to validate the input before sending it"
            }
          ],
          "args": [
            {
              "name": "NAME"
            }
          ]
        },
        {
          "name": "job",
          "description": "Create a job with the specified name",
          "options": [
            {
              "names": [
                "--allow-missing-template-keys"
              ],
              "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
            },
            {
              "names": [
                "--dry-run"
              ],
              "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
              "args": {
                "name": "Strategy",
                "suggestions": [
                  "none",
                  "server",
                  "client"
                ]
              }
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "--template"
              ],
              "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
            },
            {
              "names": [
                "--from"
              ],
              "description": "The name of the resource to create a Job from (only cronjob is supported)",
              "args": {
                "name": "Cronjob"
              }
            },
            {
              "names": [
                "--image"
              ],
              "description": "Image name to run",
              "args": {
                "name": "Image"
              }
            },
            {
              "names": [
                "--save-config"
              ],
              "description": "If true, the configuration of current object will be saved in its annotation. Otherwise, the annotation will be unchanged. This flag is useful when you want to perform kubectl apply on this object in the future"
            },
            {
              "names": [
                "--validate"
              ],
              "description": "If true, use a schema to validate the input before sending it"
            }
          ],
          "args": [
            {
              "name": "NAME"
            },
            {
              "name": "COMMAND"
            }
          ]
        },
        {
          "name": "namespace",
          "description": "Create a namespace with the specified name",
          "options": [
            {
              "names": [
                "--allow-missing-template-keys"
              ],
              "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
            },
            {
              "names": [
                "--dry-run"
              ],
              "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
              "args": {
                "name": "Strategy",
                "suggestions": [
                  "none",
                  "server",
                  "client"
                ]
              }
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "--template"
              ],
              "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
            },
            {
              "names": [
                "--save-config"
              ],
              "description": "If true, the configuration of current object will be saved in its annotation. Otherwise, the annotation will be unchanged. This flag is useful when you want to perform kubectl apply on this object in the future"
            },
            {
              "names": [
                "--validate"
              ],
              "description": "If true, use a schema to validate the input before sending it"
            }
          ],
          "args": [
            {
              "name": "NAME"
            }
          ]
        },
        {
          "name": "poddisruptionbudget",
          "description": "Create a pod disruption budget with the specified name, selector, and desired minimum available pods",
          "options": [
            {
              "names": [
                "--allow-missing-template-keys"
              ],
              "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
            },
            {
              "names": [
                "--dry-run"
              ],
              "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
              "args": {
                "name": "Strategy",
                "suggestions": [
                  "none",
                  "server",
                  "client"
                ]
              }
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "--template"
              ],
              "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
            },
            {
              "names": [
                "-l",
                "--selector"
              ],
              "description": "Selector (label query) to filter on, not including uninitialized ones, supports '=', '==', and '!='.(e.g. -l key1=value1,key2=value2)"
            },
            {
              "names": [
                "--max-unavailable"
              ],
              "description": "The maximum number or percentage of unavailable pods this budget requires",
              "args": {
                "name": "INT (Percent)"
              }
            },
            {
              "names": [
                "--min-available"
              ],
              "description": "The minimum number or percentage of available pods this budget requires",
              "args": {
                "name": "INT (Percent)"
              }
            },
            {
              "names": [
                "--save-config"
              ],
              "description": "If true, the configuration of current object will be saved in its annotation. Otherwise, the annotation will be unchanged. This flag is useful when you want to perform kubectl apply on this object in the future"
            },
            {
              "names": [
                "--validate"
              ],
              "description": "If true, use a schema to validate the input before sending it"
            }
          ],
          "args": [
            {
              "name": "NAME"
            }
          ]
        },
        {
          "name": "priorityclass",
          "description": "Create a priorityclass with the specified name, value, globalDefault and description",
          "options": [
            {
              "names": [
                "--allow-missing-template-keys"
              ],
              "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
            },
            {
              "names": [
                "--dry-run"
              ],
              "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
              "args": {
                "name": "Strategy",
                "suggestions": [
                  "none",
                  "server",
                  "client"
                ]
              }
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "--template"
              ],
              "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
            },
            {
              "names": [
                "--description"
              ],
              "description": "Description is an arbitrary string that usually provides guidelines on when this priority class should be used",
              "args": {
                "name": "Description"
              }
            },
            {
              "names": [
                "--global-default"
              ],
              "description": "Global-default specifies whether this PriorityClass should be considered as the default priority"
            },
            {
              "names": [
                "--preemption-policy"
              ],
              "description": "Preemption-policy is the policy for preempting pods with lower priority",
              "args": {
                "name": "Preemption Policy"
              }
            },
            {
              "names": [
                "--save-config"
              ],
              "description": "If true, the configuration of current object will be saved in its annotation. Otherwise, the annotation will be unchanged. This flag is useful when you want to perform kubectl apply on this object in the future"
            },
            {
              "names": [
                "--validate"
              ],
              "description": "If true, use a schema to validate the input before sending it"
            },
            {
              "names": [
                "--value"
              ],
              "description": "The value of this priority class",
              "args": {
                "name": "INT"
              }
            }
          ],
          "args": [
            {
              "name": "NAME"
            }
          ]
        },
        {
          "name": "quota",
          "description": "Create a resourcequota with the specified name, hard limits and optional scopes",
          "options": [
            {
              "names": [
                "--allow-missing-template-keys"
              ],
              "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
            },
            {
              "names": [
                "--dry-run"
              ],
              "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
              "args": {
                "name": "Strategy",
                "suggestions": [
                  "none",
                  "server",
                  "client"
                ]
              }
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "--template"
              ],
              "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
            },
            {
              "names": [
                "--field-manager"
              ],
              "description": "Name of the manager used to track field ownership"
            },
            {
              "names": [
                "--hard"
              ],
              "description": "A comma-delimited set of resource=quantity pairs that define a hard limit",
              "args": {
                "name": "key=value (Comma delimited)"
              }
            },
            {
              "names": [
                "--save-config"
              ],
              "description": "If true, the configuration of current object will be saved in its annotation. Otherwise, the annotation will be unchanged. This flag is useful when you want to perform kubectl apply on this object in the future"
            },
            {
              "names": [
                "--scopes"
              ],
              "description": "A comma-delimited set of quota scopes that must all match each object tracked by the quota",
              "args": {
                "name": "Scopes (Comma delimited)"
              }
            },
            {
              "names": [
                "--validate"
              ],
              "description": "If true, use a schema to validate the input before sending it"
            }
          ],
          "args": [
            {
              "name": "NAME"
            }
          ]
        },
        {
          "name": "role",
          "description": "Create a role with single rule",
          "options": [
            {
              "names": [
                "--allow-missing-template-keys"
              ],
              "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
            },
            {
              "names": [
                "--dry-run"
              ],
              "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
              "args": {
                "name": "Strategy",
                "suggestions": [
                  "none",
                  "server",
                  "client"
                ]
              }
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "--template"
              ],
              "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
            },
            {
              "names": [
                "--resource"
              ],
              "description": "Resource that the rule applies to",
              "args": {
                "name": "Resource Type",
                "generators": [
                  {
                    "kind": "script",
                    "script": [
                      "kubectl",
                      "api-resources",
                      "-o",
                      "name"
                    ]
                  }
                ]
              }
            },
            {
              "names": [
                "--resource-name"
              ],
              "description": "Resource in the white list that the rule applies to, repeat this flag for multiple items"
            },
            {
              "names": [
                "--save-config"
              ],
              "description": "If true, the configuration of current object will be saved in its annotation. Otherwise, the annotation will be unchanged. This flag is useful when you want to perform kubectl apply on this object in the future"
            },
            {
              "names": [
                "--validate"
              ],
              "description": "If true, use a schema to validate the input before sending it"
            },
            {
              "names": [
                "--verb"
              ],
              "description": "Verb that applies to the resources contained in the rule",
              "args": {
                "name": "VERB",
                "suggestions": [
                  "get",
                  "list",
                  "watch",
                  "delete"
                ]
              }
            }
          ],
          "args": [
            {
              "name": "NAME"
            }
          ]
        },
        {
          "name": "rolebinding",
          "description": "Create a RoleBinding for a particular Role or ClusterRole",
          "options": [
            {
              "names": [
                "--allow-missing-template-keys"
              ],
              "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
            },
            {
              "names": [
                "--dry-run"
              ],
              "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
              "args": {
                "name": "Strategy",
                "suggestions": [
                  "none",
                  "server",
                  "client"
                ]
              }
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "--template"
              ],
              "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
            },
            {
              "names": [
                "--clusterrole"
              ],
              "description": "ClusterRole this RoleBinding should reference",
              "args": {
                "name": "Cluster Role",
                "generators": [
                  {
                    "kind": "script",
                    "script": [
                      "kubectl",
                      "get",
                      "clusterroles",
                      "-o",
                      "custom-columns=:.metadata.name"
                    ]
                  }
                ]
              }
            },
            {
              "names": [
                "--group"
              ],
              "description": "Groups to bind to the role"
            },
            {
              "names": [
                "--role"
              ],
              "description": "Role this RoleBinding should reference",
              "args": {
                "name": "Role"
              }
            },
            {
              "names": [
                "--save-config"
              ],
              "description": "If true, the configuration of current object will be saved in its annotation. Otherwise, the annotation will be unchanged. This flag is useful when you want to perform kubectl apply on this object in the future"
            },
            {
              "names": [
                "--serviceaccount"
              ],
              "description": "Service accounts to bind to the role, in the format <namespace>:<name>",
              "args": {
                "name": "<namespace>:<name>"
              }
            },
            {
              "names": [
                "--username"
              ],
              "args": {
                "name": "Username"
              }
            },
            {
              "names": [
                "--validate"
              ],
              "description": "If true, use a schema to validate the input before sending it"
            }
          ],
          "args": [
            {
              "name": "NAME"
            }
          ]
        },
        {
          "name": "secret",
          "description": "Create a secret using specified subcommand",
          "subcommands": [
            {
              "name": "docker-registry",
              "description": "Create a new secret for use with Docker registries",
              "options": [
                {
                  "names": [
                    "--allow-missing-template-keys"
                  ],
                  "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
                },
                {
                  "names": [
                    "--dry-run"
                  ],
                  "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
                  "args": {
                    "name": "Strategy",
                    "suggestions": [
                      "none",
                      "server",
                      "client"
                    ]
                  }
                },
                {
                  "names": [
                    "-o",
                    "--output"
                  ],
                  "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
                  "args": {
                    "name": "Output Format",
                    "suggestions": [
                      "json",
                      "yaml",
                      "name",
                      "go-template",
                      "go-template-file",
                      "template",
                      "templatefile",
                      "jsonpath",
                      "jsonpath-file"
                    ]
                  }
                },
                {
                  "names": [
                    "--template"
                  ],
                  "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
                },
                {
                  "names": [
                    "--append-hash"
                  ],
                  "description": "Append a hash of the secret to its name"
                },
                {
                  "names": [
                    "--docker-email"
                  ],
                  "description": "Email for Docker registry",
                  "args": {
                    "name": "Email"
                  }
                },
                {
                  "names": [
                    "--docker-password"
                  ],
                  "description": "Password for Docker registry authentication",
                  "args": {
                    "name": "Password"
                  }
                },
                {
                  "names": [
                    "--docker-server"
                  ],
                  "description": "Server location for Docker registry",
                  "args": {
                    "name": "Server"
                  }
                },
                {
                  "names": [
                    "--docker-username"
                  ],
                  "description": "Username for Docker registry authentication",
                  "args": {
                    "name": "Username"
                  }
                },
                {
                  "names": [
                    "--from-file"
                  ],
                  "description": "Key files can be specified using their file path, in which case a default name will be given to them, or optionally with a name and file path, in which case the given name will be used.  Specifying a directory will iterate each named file in the directory that is a valid secret key"
                },
                {
                  "names": [
                    "--save-config"
                  ],
                  "description": "If true, the configuration of current object will be saved in its annotation. Otherwise, the annotation will be unchanged. This flag is useful when you want to perform kubectl apply on this object in the future"
                },
                {
                  "names": [
                    "--validate"
                  ],
                  "description": "If true, use a schema to validate the input before sending it"
                }
              ],
              "args": [
                {
                  "name": "NAME"
                }
              ]
            },
            {
              "name": "generic",
              "description": "Create a secret based on a file, directory, or specified literal value",
              "options": [
                {
                  "names": [
                    "--allow-missing-template-keys"
                  ],
                  "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
                },
                {
                  "names": [
                    "--dry-run"
                  ],
                  "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
                  "args": {
                    "name": "Strategy",
                    "suggestions": [
                      "none",
                      "server",
                      "client"
                    ]
                  }
                },
                {
                  "names": [
                    "-o",
                    "--output"
                  ],
                  "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
                  "args": {
                    "name": "Output Format",
                    "suggestions": [
                      "json",
                      "yaml",
                      "name",
                      "go-template",
                      "go-template-file",
                      "template",
                      "templatefile",
                      "jsonpath",
                      "jsonpath-file"
                    ]
                  }
                },
                {
                  "names": [
                    "--template"
                  ],
                  "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
                },
                {
                  "names": [
                    "--append-hash"
                  ],
                  "description": "Append a hash of the secret to its name"
                },
                {
                  "names": [
                    "--from-env-file"
                  ],
                  "description": "Specify the path to a file to read lines of key=val pairs to create a secret (i.e. a Docker .env file)"
                },
                {
                  "names": [
                    "--from-file"
                  ],
                  "description": "Key files can be specified using their file path, in which case a default name will be given to them, or optionally with a name and file path, in which case the given name will be used.  Specifying a directory will iterate each named file in the directory that is a valid secret key"
                },
                {
                  "names": [
                    "--from-literal"
                  ],
                  "description": "Specify a key and literal value to insert in secret (i.e. mykey=somevalue)",
                  "args": {
                    "name": "key=value"
                  }
                },
                {
                  "names": [
                    "--save-config"
                  ],
                  "description": "If true, the configuration of current object will be saved in its annotation. Otherwise, the annotation will be unchanged. This flag is useful when you want to perform kubectl apply on this object in the future"
                },
                {
                  "names": [
                    "--type"
                  ],
                  "description": "The type of secret to create"
                },
                {
                  "names": [
                    "--validate"
                  ],
                  "description": "If true, use a schema to validate the input before sending it"
                }
              ],
              "args": [
                {
                  "name": "NAME"
                }
              ]
            },
            {
              "name": "tls",
              "description": "Create a TLS secret from the given public/private key pair",
              "options": [
                {
                  "names": [
                    "--allow-missing-template-keys"
                  ],
                  "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
                },
                {
                  "names": [
                    "--dry-run"
                  ],
                  "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
                  "args": {
                    "name": "Strategy",
                    "suggestions": [
                      "none",
                      "server",
                      "client"
                    ]
                  }
                },
                {
                  "names": [
                    "-o",
                    "--output"
                  ],
                  "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
                  "args": {
                    "name": "Output Format",
                    "suggestions": [
                      "json",
                      "yaml",
                      "name",
                      "go-template",
                      "go-template-file",
                      "template",
                      "templatefile",
                      "jsonpath",
                      "jsonpath-file"
                    ]
                  }
                },
                {
                  "names": [
                    "--template"
                  ],
                  "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
                },
                {
                  "names": [
                    "--append-hash"
                  ],
                  "description": "Append a hash of the secret to its name"
                },
                {
                  "names": [
                    "--cert"
                  ],
                  "description": "Path to PEM encoded public key certificate"
                },
                {
                  "names": [
                    "--key"
                  ],
                  "description": "Path to private key associated with given certificate"
                },
                {
                  "names": [
                    "--save-config"
                  ],
                  "description": "If true, the configuration of current object will be saved in its annotation. Otherwise, the annotation will be unchanged. This flag is useful when you want to perform kubectl apply on this object in the future"
                },
                {
                  "names": [
                    "--validate"
                  ],
                  "description": "If true, use a schema to validate the input before sending it"
                }
              ],
              "args": [
                {
                  "name": "NAME"
                }
              ]
            }
          ]
        },
        {
          "name": "service",
          "description": "Create a service using specified subcommand",
          "subcommands": [
            {
              "name": "clusterip",
              "description": "Create a ClusterIP service with the specified name",
              "options": [
                {
                  "names": [
                    "--allow-missing-template-keys"
                  ],
                  "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
                },
                {
                  "names": [
                    "--dry-run"
                  ],
                  "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
                  "args": {
                    "name": "Strategy",
                    "suggestions": [
                      "none",
                      "server",
                      "client"
                    ]
                  }
                },
                {
                  "names": [
                    "-o",
                    "--output"
                  ],
                  "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
                  "args": {
                    "name": "Output Format",
                    "suggestions": [
                      "json",
                      "yaml",
                      "name",
                      "go-template",
                      "go-template-file",
                      "template",
                      "templatefile",
                      "jsonpath",
                      "jsonpath-file"
                    ]
                  }
                },
                {
                  "names": [
                    "--template"
                  ],
                  "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
                },
                {
                  "names": [
                    "--clusterip"
                  ],
                  "description": "Assign your own ClusterIP or set to 'None' for a 'headless' service (no loadbalancing)",
                  "args": {
                    "name": "ClusterIP",
                    "suggestions": [
                      "None"
                    ]
                  }
                },
                {
                  "names": [
                    "--save-config"
                  ],
                  "description": "If true, the configuration of current object will be saved in its annotation. Otherwise, the annotation will be unchanged. This flag is useful when you want to perform kubectl apply on this object in the future"
                },
                {
                  "names": [
                    "--tcp"
                  ],
                  "description": "Port pairs can be specified as '<port>:<targetPort>'",
                  "args": {
                    "name": "<port>:<targetPort>"
                  }
                },
                {
                  "names": [
                    "--validate"
                  ],
                  "description": "If true, use a schema to validate the input before sending it"
                }
              ],
              "args": [
                {
                  "name": "NAME"
                }
              ]
            },
            {
              "name": "externalname",
              "description": "Create an ExternalName service with the specified name",
              "options": [
                {
                  "names": [
                    "--allow-missing-template-keys"
                  ],
                  "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
                },
                {
                  "names": [
                    "--dry-run"
                  ],
                  "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
                  "args": {
                    "name": "Strategy",
                    "suggestions": [
                      "none",
                      "server",
                      "client"
                    ]
                  }
                },
                {
                  "names": [
                    "-o",
                    "--output"
                  ],
                  "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
                  "args": {
                    "name": "Output Format",
                    "suggestions": [
                      "json",
                      "yaml",
                      "name",
                      "go-template",
                      "go-template-file",
                      "template",
                      "templatefile",
                      "jsonpath",
                      "jsonpath-file"
                    ]
                  }
                },
                {
                  "names": [
                    "--template"
                  ],
                  "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
                },
                {
                  "names": [
                    "--external-name"
                  ],
                  "description": "External name of service",
                  "args": {
                    "name": "External name"
                  }
                },
                {
                  "names": [
                    "--save-config"
                  ],
                  "description": "If true, the configuration of current object will be saved in its annotation. Otherwise, the annotation will be unchanged. This flag is useful when you want to perform kubectl apply on this object in the future"
                },
                {
                  "names": [
                    "--tcp"
                  ],
                  "description": "Port pairs can be specified as '<port>:<targetPort>'",
                  "args": {
                    "name": "<port>:<targetPort>"
                  }
                },
                {
                  "names": [
                    "--validate"
                  ],
                  "description": "If true, use a schema to validate the input before sending it"
                }
              ],
              "args": [
                {
                  "name": "NAME"
                }
              ]
            },
            {
              "name": "loadbalancer",
              "description": "Create a LoadBalancer service with the specified name",
              "options": [
                {
                  "names": [
                    "--allow-missing-template-keys"
                  ],
                  "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
                },
                {
                  "names": [
                    "--dry-run"
                  ],
                  "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
                  "args": {
                    "name": "Strategy",
                    "suggestions": [
                      "none",
                      "server",
                      "client"
                    ]
                  }
                },
                {
                  "names": [
                    "-o",
                    "--output"
                  ],
                  "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
                  "args": {
                    "name": "Output Format",
                    "suggestions": [
                      "json",
                      "yaml",
                      "name",
                      "go-template",
                      "go-template-file",
                      "template",
                      "templatefile",
                      "jsonpath",
                      "jsonpath-file"
                    ]
                  }
                },
                {
                  "names": [
                    "--template"
                  ],
                  "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
                },
                {
                  "names": [
                    "--save-config"
                  ],
                  "description": "If true, the configuration of current object will be saved in its annotation. Otherwise, the annotation will be unchanged. This flag is useful when you want to perform kubectl apply on this object in the future"
                },
                {
                  "names": [
                    "--tcp"
                  ],
                  "description": "Port pairs can be specified as '<port>:<targetPort>'",
                  "args": {
                    "name": "<port>:<targetPort>"
                  }
                },
                {
                  "names": [
                    "--validate"
                  ],
                  "description": "If true, use a schema to validate the input before sending it"
                }
              ],
              "args": [
                {
                  "name": "NAME"
                }
              ]
            },
            {
              "name": "nodeport",
              "description": "Create a NodePort service with the specified name",
              "options": [
                {
                  "names": [
                    "--allow-missing-template-keys"
                  ],
                  "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
                },
                {
                  "names": [
                    "--dry-run"
                  ],
                  "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
                  "args": {
                    "name": "Strategy",
                    "suggestions": [
                      "none",
                      "server",
                      "client"
                    ]
                  }
                },
                {
                  "names": [
                    "-o",
                    "--output"
                  ],
                  "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
                  "args": {
                    "name": "Output Format",
                    "suggestions": [
                      "json",
                      "yaml",
                      "name",
                      "go-template",
                      "go-template-file",
                      "template",
                      "templatefile",
                      "jsonpath",
                      "jsonpath-file"
                    ]
                  }
                },
                {
                  "names": [
                    "--template"
                  ],
                  "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
                },
                {
                  "names": [
                    "--node-port"
                  ],
                  "description": "Port used to expose the service on each node in a cluster",
                  "args": {
                    "name": "Port (INT)"
                  }
                },
                {
                  "names": [
                    "--save-config"
                  ],
                  "description": "If true, the configuration of current object will be saved in its annotation. Otherwise, the annotation will be unchanged. This flag is useful when you want to perform kubectl apply on this object in the future"
                },
                {
                  "names": [
                    "--tcp"
                  ],
                  "description": "Port pairs can be specified as '<port>:<targetPort>'",
                  "args": {
                    "name": "<port>:<targetPort>"
                  }
                },
                {
                  "names": [
                    "--validate"
                  ],
                  "description": "If true, use a schema to validate the input before sending it"
                }
              ],
              "args": [
                {
                  "name": "NAME"
                }
              ]
            }
          ]
        },
        {
          "name": "serviceaccount",
          "description": "Create a service account with the specified name",
          "options": [
            {
              "names": [
                "--allow-missing-template-keys"
              ],
              "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
            },
            {
              "names": [
                "--dry-run"
              ],
              "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
              "args": {
                "name": "Strategy",
                "suggestions": [
                  "none",
                  "server",
                  "client"
                ]
              }
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "--template"
              ],
              "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
            },
            {
              "names": [
                "--save-config"
              ],
              "description": "If true, the configuration of current object will be saved in its annotation. Otherwise, the annotation will be unchanged. This flag is useful when you want to perform kubectl apply on this object in the future"
            },
            {
              "names": [
                "--validate"
              ],
              "description": "If true, use a schema to validate the input before sending it"
            }
          ],
          "args": [
            {
              "name": "NAME"
            }
          ]
        }
      ],
      "options": [
        {
          "names": [
            "--allow-missing-template-keys"
          ],
          "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
        },
        {
          "names": [
            "--dry-run"
          ],
          "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
          "args": {
            "name": "Strategy",
            "suggestions": [
              "none",
              "server",
              "client"
            ]
          }
        },
        {
          "names": [
            "-f",
            "--filename"
          ],
          "description": "Filename, directory, or URL to files identifying the resource",
          "args": {
            "name": "File"
          }
        },
        {
          "names": [
            "-k",
            "--kustomize"
          ],
          "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
          "args": {
            "name": "Kustomize Dir"
          }
        },
        {
          "names": [
            "-o",
            "--output"
          ],
          "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
          "args": {
            "name": "Output Format",
            "suggestions": [
              "json",
              "yaml",
              "name",
              "go-template",
              "go-template-file",
              "template",
              "templatefile",
              "jsonpath",
              "jsonpath-file"
            ]
          }
        },
        {
          "names": [
            "-R",
            "--recursive"
          ],
          "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
        },
        {
          "names": [
            "-l",
            "--selector"
          ],
          "description": "Selector (label query) to filter on, not including uninitialized ones, supports '=', '==', and '!='.(e.g. -l key1=value1,key2=value2)"
        },
        {
          "names": [
            "--template"
          ],
          "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
        },
        {
          "names": [
            "--record"
          ],
          "description": "Record current kubectl command in the resource annotation. If set to false, do not record the command. If set to true, record the command. If not set, default to updating the existing annotation value only if one already exists"
        },
        {
          "names": [
            "--edit"
          ],
          "description": "Edit the API resource before creating"
        },
        {
          "names": [
            "--raw"
          ],
          "description": "Raw URI to POST to the server.  Uses the transport specified by the kubeconfig file"
        },
        {
          "names": [
            "--save-config"
          ],
          "description": "If true, the configuration of current object will be saved in its annotation. Otherwise, the annotation will be unchanged. This flag is useful when you want to perform kubectl apply on this object in the future"
        },
        {
          "names": [
            "--validate"
          ],
          "description": "If true, use a schema to validate the input before sending it"
        },
        {
          "names": [
            "--windows-line-endings"
          ],
          "description": "Only relevant if --edit=true. Defaults to the line ending native to your platform"
        }
      ]
    },
    {
      "name": "delete",
      "description": "Delete resources by filenames, stdin, resources and names, or by resources and label selector",
      "options": [
        {
          "names": [
            "--dry-run"
          ],
          "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
          "args": {
            "name": "Strategy",
            "suggestions": [
              "none",
              "server",
              "client"
            ]
          }
        },
        {
          "names": [
            "-f",
            "--filename"
          ],
          "description": "Filename, directory, or URL to files identifying the resource",
          "args": {
            "name": "File"
          }
        },
        {
          "names": [
            "-k",
            "--kustomize"
          ],
          "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
          "args": {
            "name": "Kustomize Dir"
          }
        },
        {
          "names": [
            "-o",
            "--output"
          ],
          "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
          "args": {
            "name": "Output Format",
            "suggestions": [
              "json",
              "yaml",
              "name",
              "go-template",
              "go-template-file",
              "template",
              "templatefile",
              "jsonpath",
              "jsonpath-file"
            ]
          }
        },
        {
          "names": [
            "-R",
            "--recursive"
          ],
          "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
        },
        {
          "names": [
            "-l",
            "--selector"
          ],
          "description": "Selector (label query) to filter on, not including uninitialized ones, supports '=', '==', and '!='.(e.g. -l key1=value1,key2=value2)"
        },
        {
          "names": [
            "--all"
          ],
          "description": "Select all resources, including uninitialized ones, in the namespace of the specified resource types"
        },
        {
          "names": [
            "--field-selector"
          ],
          "description": "Selector (field query) to filter on, supports '=', '==', and '!='.(e.g. --field-selector key1=value1,key2=value2). The server only supports a limited number of field queries per type"
        },
        {
          "names": [
            "-A",
            "--all-namespaces"
          ],
          "description": "If present, list the requested object(s) across all namespaces. Namespace in current context is ignored even if specified with --namespace"
        },
        {
          "names": [
            "--cascade"
          ],
          "description": "If true, cascade the deletion of the resources managed by this resource (e.g. Pods created by a ReplicationController).  Default true"
        },
        {
          "names": [
            "--force"
          ],
          "description": "If true, immediately remove resources from API and bypass graceful deletion. Note that immediate deletion of some resources may result in inconsistency or data loss and requires confirmation"
        },
        {
          "names": [
            "--grace-period"
          ],
          "description": "Period of time in seconds given to the resource to terminate gracefully. Ignored if negative. Set to 1 for immediate shutdown. Can only be set to 0 when --force is true (force deletion)",
          "args": {
            "name": "INT (Seconds)"
          }
        },
        {
          "names": [
            "--ignore-not-found"
          ],
          "description": "Treat \"resource not found\" as a successful delete. Defaults to \"true\" when --all is specified"
        },
        {
          "names": [
            "--now"
          ],
          "description": "If true, resources are signaled for immediate shutdown (same as --grace-period=1)"
        },
        {
          "names": [
            "--raw"
          ],
          "description": "Raw URI to DELETE to the server.  Uses the transport specified by the kubeconfig file"
        },
        {
          "names": [
            "--timeout"
          ],
          "description": "The length of time to wait before giving up on a delete, zero means determine a timeout from the size of the object",
          "args": {
            "name": "INT (Seconds)"
          }
        },
        {
          "names": [
            "--wait"
          ],
          "description": "If true, wait for resources to be gone before returning. This waits for finalizers"
        }
      ],
      "args": [
        {
          "name": "TYPE | TYPE/NAME"
        },
        {
          "name": "Resource",
          "isOptional": true
        }
      ]
    },
    {
      "name": "describe",
      "description": "Show details of a specific resource or group of resources",
      "options": [
        {
          "names": [
            "-f",
            "--filename"
          ],
          "description": "Filename, directory, or URL to files identifying the resource",
          "args": {
            "name": "File"
          }
        },
        {
          "names": [
            "-k",
            "--kustomize"
          ],
          "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
          "args": {
            "name": "Kustomize Dir"
          }
        },
        {
          "names": [
            "-R",
            "--recursive"
          ],
          "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
        },
        {
          "names": [
            "-l",
            "--selector"
          ],
          "description": "Selector (label query) to filter on, not including uninitialized ones, supports '=', '==', and '!='.(e.g. -l key1=value1,key2=value2)"
        },
        {
          "names": [
            "-A",
            "--all-namespaces"
          ],
          "description": "If present, list the requested object(s) across all namespaces. Namespace in current context is ignored even if specified with --namespace"
        },
        {
          "names": [
            "--show-events"
          ],
          "description": "If true, display events related to the described object"
        }
      ],
      "args": [
        {
          "name": "TYPE | TYPE/NAME"
        },
        {
          "name": "Resource",
          "isOptional": true
        }
      ]
    },
    {
      "name": "diff",
      "description": "Diff configurations specified by filename or stdin between the current online configuration, and the configuration as it would be if applied",
      "options": [
        {
          "names": [
            "-f",
            "--filename"
          ],
          "description": "Filename, directory, or URL to files identifying the resource",
          "args": {
            "name": "File"
          }
        },
        {
          "names": [
            "-k",
            "--kustomize"
          ],
          "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
          "args": {
            "name": "Kustomize Dir"
          }
        },
        {
          "names": [
            "-R",
            "--recursive"
          ],
          "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
        },
        {
          "names": [
            "--field-manager"
          ],
          "description": "Name of the manager used to track field ownership",
          "args": {
            "name": "Field Manager"
          }
        },
        {
          "names": [
            "--force-conflicts"
          ],
          "description": "If true, server-side apply will force the changes against conflicts"
        },
        {
          "names": [
            "--server-side"
          ],
          "description": "If true, apply runs in the server instead of the client"
        }
      ]
    },
    {
      "name": "drain",
      "description": "Drain node in preparation for maintenance",
      "options": [
        {
          "names": [
            "--dry-run"
          ],
          "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
          "args": {
            "name": "Strategy",
            "suggestions": [
              "none",
              "server",
              "client"
            ]
          }
        },
        {
          "names": [
            "-l",
            "--selector"
          ],
          "description": "Selector (label query) to filter on, not including uninitialized ones, supports '=', '==', and '!='.(e.g. -l key1=value1,key2=value2)"
        },
        {
          "names": [
            "--delete-local-data"
          ],
          "description": "Continue even if there are pods using emptyDir (local data that will be deleted when the node is drained)"
        },
        {
          "names": [
            "--disable-eviction"
          ],
          "description": "Force drain to use delete, even if eviction is supported. This will bypass checking PodDisruptionBudgets, use with caution"
        },
        {
          "names": [
            "--force"
          ],
          "description": "Continue even if there are pods not managed by a ReplicationController, ReplicaSet, Job, DaemonSet or StatefulSet"
        },
        {
          "names": [
            "--grace-period"
          ],
          "description": "Period of time in seconds given to each pod to terminate gracefully. If negative, the default value specified in the pod will be used",
          "args": {
            "name": "INT (Seconds)"
          }
        },
        {
          "names": [
            "--ignore-daemonsets"
          ],
          "description": "Ignore DaemonSet-managed pods"
        },
        {
          "names": [
            "--pod-selector"
          ],
          "description": "Label selector to filter pods on the node"
        },
        {
          "names": [
            "--skip-wait-for-delete-timeout"
          ],
          "description": "If pod DeletionTimestamp older than N seconds, skip waiting for the pod.  Seconds must be greater than 0 to skip"
        },
        {
          "names": [
            "--timeout"
          ],
          "description": "The length of time to wait before giving up, zero means infinite",
          "args": {
            "name": "INT (Seconds)"
          }
        }
      ],
      "args": [
        {
          "name": "Node",
          "generators": [
            {
              "kind": "script",
              "script": [
                "kubectl",
                "get",
                "nodes",
                "-o",
                "custom-columns=:.metadata.name"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "edit",
      "description": "Edit a resource from the default editor",
      "options": [
        {
          "names": [
            "-f",
            "--filename"
          ],
          "description": "Filename, directory, or URL to files identifying the resource",
          "args": {
            "name": "File"
          }
        },
        {
          "names": [
            "-k",
            "--kustomize"
          ],
          "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
          "args": {
            "name": "Kustomize Dir"
          }
        },
        {
          "names": [
            "-o",
            "--output"
          ],
          "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
          "args": {
            "name": "Output Format",
            "suggestions": [
              "json",
              "yaml",
              "name",
              "go-template",
              "go-template-file",
              "template",
              "templatefile",
              "jsonpath",
              "jsonpath-file"
            ]
          }
        },
        {
          "names": [
            "-R",
            "--recursive"
          ],
          "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
        },
        {
          "names": [
            "--allow-missing-template-keys"
          ],
          "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
        },
        {
          "names": [
            "--template"
          ],
          "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
        },
        {
          "names": [
            "--record"
          ],
          "description": "Record current kubectl command in the resource annotation. If set to false, do not record the command. If set to true, record the command. If not set, default to updating the existing annotation value only if one already exists"
        },
        {
          "names": [
            "--output-patch"
          ],
          "description": "Output the patch if the resource is edited"
        },
        {
          "names": [
            "--save-config"
          ],
          "description": "If true, the configuration of current object will be saved in its annotation. Otherwise, the annotation will be unchanged. This flag is useful when you want to perform kubectl apply on this object in the future"
        },
        {
          "names": [
            "--validate"
          ],
          "description": "If true, use a schema to validate the input before sending it"
        },
        {
          "names": [
            "--windows-line-endings"
          ],
          "description": "Defaults to the line ending native to your platform"
        }
      ],
      "args": [
        {
          "name": "TYPE | TYPE/NAME"
        },
        {
          "name": "Resource",
          "isOptional": true
        }
      ]
    },
    {
      "name": "exec",
      "description": "Execute a command in a container",
      "options": [
        {
          "names": [
            "-f",
            "--filename"
          ],
          "description": "Filename, directory, or URL to files identifying the resource",
          "args": {
            "name": "File"
          }
        },
        {
          "names": [
            "-c",
            "--container"
          ],
          "description": "Container name. If omitted, the first container in the pod will be chosen",
          "args": {
            "name": "Container"
          }
        },
        {
          "names": [
            "--pod-running-timeout"
          ],
          "description": "The length of time (like 5s, 2m, or 3h, higher than zero) to wait until at least one pod is running"
        },
        {
          "names": [
            "-i",
            "--stdin"
          ],
          "description": "Pass stdin to the container"
        },
        {
          "names": [
            "-t",
            "--tty"
          ],
          "description": "Stdin is a TTY"
        }
      ],
      "args": [
        {
          "name": "Running Pods",
          "generators": [
            {
              "kind": "script",
              "script": [
                "kubectl",
                "get",
                "pods",
                "--field-selector=status.phase=Running",
                "-o",
                "name"
              ]
            }
          ]
        },
        {
          "name": "COMMAND"
        }
      ]
    },
    {
      "name": "explain",
      "description": "List the fields for supported resources",
      "options": [
        {
          "names": [
            "--api-version"
          ],
          "description": "Get different explanations for particular API version"
        },
        {
          "names": [
            "--recursive"
          ],
          "description": "Print the fields of fields (Currently only 1 level deep)"
        }
      ],
      "args": [
        {
          "name": "Resource Type",
          "generators": [
            {
              "kind": "script",
              "script": [
                "kubectl",
                "api-resources",
                "-o",
                "name"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "expose",
      "description": "Expose a resource as a new Kubernetes service",
      "options": [
        {
          "names": [
            "--allow-missing-template-keys"
          ],
          "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
        },
        {
          "names": [
            "--dry-run"
          ],
          "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
          "args": {
            "name": "Strategy",
            "suggestions": [
              "none",
              "server",
              "client"
            ]
          }
        },
        {
          "names": [
            "-f",
            "--filename"
          ],
          "description": "Filename, directory, or URL to files identifying the resource",
          "args": {
            "name": "File"
          }
        },
        {
          "names": [
            "-k",
            "--kustomize"
          ],
          "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
          "args": {
            "name": "Kustomize Dir"
          }
        },
        {
          "names": [
            "-o",
            "--output"
          ],
          "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
          "args": {
            "name": "Output Format",
            "suggestions": [
              "json",
              "yaml",
              "name",
              "go-template",
              "go-template-file",
              "template",
              "templatefile",
              "jsonpath",
              "jsonpath-file"
            ]
          }
        },
        {
          "names": [
            "--record"
          ],
          "description": "Record current kubectl command in the resource annotation. If set to false, do not record the command. If set to true, record the command. If not set, default to updating the existing annotation value only if one already exists"
        },
        {
          "names": [
            "-R",
            "--recursive"
          ],
          "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
        },
        {
          "names": [
            "-l",
            "--selector"
          ],
          "description": "Selector (label query) to filter on, not including uninitialized ones, supports '=', '==', and '!='.(e.g. -l key1=value1,key2=value2)"
        },
        {
          "names": [
            "--template"
          ],
          "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
        },
        {
          "names": [
            "--cluster-ip"
          ],
          "description": "ClusterIP to be assigned to the service. Leave empty to auto-allocate, or set to 'None' to create a headless service"
        },
        {
          "names": [
            "--external-ip"
          ],
          "description": "Additional external IP address (not managed by Kubernetes) to accept for the service. If this IP is routed to a node, the service can be accessed by this IP in addition to its generated service IP"
        },
        {
          "names": [
            "--generator"
          ],
          "description": "The name of the API generator to use. There are 2 generators: 'service/v1' and 'service/v2'. The only difference between them is that service port in v1 is named 'default', while it is left unnamed in v2. Default is 'service/v2'"
        },
        {
          "names": [
            "-l",
            "--labels"
          ],
          "description": "Labels to apply to the service created by this call"
        },
        {
          "names": [
            "--load-balancer-ip"
          ],
          "description": "IP to assign to the LoadBalancer. If empty, an ephemeral IP will be created and used (cloud-provider specific)"
        },
        {
          "names": [
            "--name"
          ],
          "description": "The name for the newly created object"
        },
        {
          "names": [
            "--overrides"
          ],
          "description": "An inline JSON override for the generated object. If this is non-empty, it is used to override the generated object. Requires that the object supply a valid apiVersion field"
        },
        {
          "names": [
            "--port"
          ],
          "description": "The port that the service should serve on. Copied from the resource being exposed, if unspecified"
        },
        {
          "names": [
            "--protocol"
          ],
          "description": "The network protocol for the service to be created. Default is 'TCP'",
          "args": {
            "suggestions": [
              "TCP",
              "UDP",
              "SCTP"
            ]
          }
        },
        {
          "names": [
            "--save-config"
          ],
          "description": "If true, the configuration of current object will be saved in its annotation. Otherwise, the annotation will be unchanged. This flag is useful when you want to perform kubectl apply on this object in the future"
        },
        {
          "names": [
            "--session-affinity"
          ],
          "description": "If non-empty, set the session affinity for the service to this; legal values: 'None', 'ClientIP'"
        },
        {
          "names": [
            "--target-port"
          ],
          "description": "Name or number for the port on the container that the service should direct traffic to. Optional"
        },
        {
          "names": [
            "--type"
          ],
          "description": "Type for this service: ClusterIP, NodePort, LoadBalancer, or ExternalName. Default is 'ClusterIP'",
          "args": {
            "suggestions": [
              "ClusterIP",
              "NodePort",
              "LoadBalancer",
              "ExternalName"
            ]
          }
        }
      ],
      "args": [
        {
          "name": "TYPE | TYPE/NAME"
        },
        {
          "name": "Resource",
          "isOptional": true
        }
      ]
    },
    {
      "name": "get",
      "description": "Display one or many resources",
      "options": [
        {
          "names": [
            "--allow-missing-template-keys"
          ],
          "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
        },
        {
          "names": [
            "--field-selector"
          ],
          "description": "Selector (field query) to filter on, supports '=', '==', and '!='.(e.g. --field-selector key1=value1,key2=value2). The server only supports a limited number of field queries per type"
        },
        {
          "names": [
            "-f",
            "--filename"
          ],
          "description": "Filename, directory, or URL to files identifying the resource",
          "args": {
            "name": "File"
          }
        },
        {
          "names": [
            "-k",
            "--kustomize"
          ],
          "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
          "args": {
            "name": "Kustomize Dir"
          }
        },
        {
          "names": [
            "-o",
            "--output"
          ],
          "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
          "args": {
            "name": "Output Format",
            "suggestions": [
              "json",
              "yaml",
              "name",
              "go-template",
              "go-template-file",
              "template",
              "templatefile",
              "jsonpath",
              "jsonpath-file"
            ]
          }
        },
        {
          "names": [
            "-R",
            "--recursive"
          ],
          "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
        },
        {
          "names": [
            "-l",
            "--selector"
          ],
          "description": "Selector (label query) to filter on, not including uninitialized ones, supports '=', '==', and '!='.(e.g. -l key1=value1,key2=value2)"
        },
        {
          "names": [
            "--template"
          ],
          "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
        },
        {
          "names": [
            "-A",
            "--all-namespaces"
          ],
          "description": "If present, list the requested object(s) across all namespaces. Namespace in current context is ignored even if specified with --namespace"
        },
        {
          "names": [
            "--chunk-size"
          ],
          "description": "Return large lists in chunks rather than all at once. Pass 0 to disable. This flag is beta and may change in the future"
        },
        {
          "names": [
            "--ignore-not-found"
          ],
          "description": "If the requested object does not exist the command will return exit code 0"
        },
        {
          "names": [
            "-L",
            "--label-columns"
          ],
          "description": "Accepts a comma separated list of labels that are going to be presented as columns. Names are case-sensitive. You can also use multiple flag options like -L label1 -L label2"
        },
        {
          "names": [
            "--no-headers"
          ],
          "description": "When using the default or custom-column output format, don't print headers (default print headers)"
        },
        {
          "names": [
            "--output-watch-events"
          ],
          "description": "Output watch event objects when --watch or --watch-only is used. Existing objects are output as initial ADDED events"
        },
        {
          "names": [
            "--raw"
          ],
          "description": "Raw URI to request from the server.  Uses the transport specified by the kubeconfig file"
        },
        {
          "names": [
            "--server-print"
          ],
          "description": "If true, have the server return the appropriate table output. Supports extension APIs and CRDs"
        },
        {
          "names": [
            "--show-kind"
          ],
          "description": "If present, list the resource type for the requested object(s)"
        },
        {
          "names": [
            "--show-labels"
          ],
          "description": "When printing, show all labels as the last column (default hide labels column)"
        },
        {
          "names": [
            "--sort-by"
          ],
          "description": "If non-empty, sort list types using this field specification.  The field specification is expressed as a JSONPath expression (e.g. '{.metadata.name}'). The field in the API resource specified by this JSONPath expression must be an integer or a string"
        },
        {
          "names": [
            "-w",
            "--watch"
          ],
          "description": "After listing/getting the requested object, watch for changes. Uninitialized objects are excluded if no object name is provided"
        },
        {
          "names": [
            "--watch-only"
          ],
          "description": "Watch for changes to the requested object(s), without listing/getting first"
        }
      ],
      "args": [
        {
          "name": "TYPE | TYPE/NAME"
        },
        {
          "name": "Resource",
          "isOptional": true
        }
      ]
    },
    {
      "name": "kustomize",
      "description": "Print a set of API resources generated from instructions in a kustomization.yaml file",
      "options": [
        {
          "names": [
            "-o",
            "--output"
          ],
          "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
          "args": {
            "name": "Output Format",
            "suggestions": [
              "json",
              "yaml",
              "name",
              "go-template",
              "go-template-file",
              "template",
              "templatefile",
              "jsonpath",
              "jsonpath-file"
            ]
          }
        },
        {
          "names": [
            "--allow-id-changes"
          ],
          "description": "Enable changes to a resourceId"
        },
        {
          "names": [
            "--enable-alpha-plugins"
          ],
          "description": "Enable kustomize plugins"
        },
        {
          "names": [
            "--enable-managedby-label"
          ],
          "description": "Enable adding app.kubernetes.io/managed-by"
        },
        {
          "names": [
            "--env",
            "-e"
          ],
          "description": "A list of environment variables to be used by functions"
        },
        {
          "names": [
            "--load-restrictor"
          ],
          "description": "If set to 'LoadRestrictionsNone', local kustomizations may load files from outside their root. This does, however, break the relocatability of the kustomization"
        },
        {
          "names": [
            "--mount"
          ],
          "description": "A list of storage options read from the filesystem"
        },
        {
          "names": [
            "--network"
          ],
          "description": "Enable network access for functions that declare it"
        },
        {
          "names": [
            "--network-name"
          ],
          "description": "The docker network to run the container in"
        },
        {
          "names": [
            "--reorder"
          ],
          "description": "Reorder the resources just before output. Use 'legacy' to apply a legacy reordering (Namespaces first, Webhooks last, etc). Use 'none' to suppress a final reordering"
        }
      ],
      "args": [
        {
          "name": "DIR"
        }
      ]
    },
    {
      "name": "label",
      "description": "Update the labels on a resource",
      "options": [
        {
          "names": [
            "--allow-missing-template-keys"
          ],
          "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
        },
        {
          "names": [
            "--dry-run"
          ],
          "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
          "args": {
            "name": "Strategy",
            "suggestions": [
              "none",
              "server",
              "client"
            ]
          }
        },
        {
          "names": [
            "--field-selector"
          ],
          "description": "Selector (field query) to filter on, supports '=', '==', and '!='.(e.g. --field-selector key1=value1,key2=value2). The server only supports a limited number of field queries per type"
        },
        {
          "names": [
            "-f",
            "--filename"
          ],
          "description": "Filename, directory, or URL to files identifying the resource",
          "args": {
            "name": "File"
          }
        },
        {
          "names": [
            "-k",
            "--kustomize"
          ],
          "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
          "args": {
            "name": "Kustomize Dir"
          }
        },
        {
          "names": [
            "--local"
          ],
          "description": "If true, annotation will NOT contact api-server but run locally"
        },
        {
          "names": [
            "-o",
            "--output"
          ],
          "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
          "args": {
            "name": "Output Format",
            "suggestions": [
              "json",
              "yaml",
              "name",
              "go-template",
              "go-template-file",
              "template",
              "templatefile",
              "jsonpath",
              "jsonpath-file"
            ]
          }
        },
        {
          "names": [
            "--record"
          ],
          "description": "Record current kubectl command in the resource annotation. If set to false, do not record the command. If set to true, record the command. If not set, default to updating the existing annotation value only if one already exists"
        },
        {
          "names": [
            "-R",
            "--recursive"
          ],
          "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
        },
        {
          "names": [
            "-l",
            "--selector"
          ],
          "description": "Selector (label query) to filter on, not including uninitialized ones, supports '=', '==', and '!='.(e.g. -l key1=value1,key2=value2)"
        },
        {
          "names": [
            "--template"
          ],
          "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
        },
        {
          "names": [
            "--resource-version"
          ],
          "description": "If non-empty, the annotation update will only succeed if this is the current resource-version for the object. Only valid when specifying a single resource"
        },
        {
          "names": [
            "--all"
          ],
          "description": "Select all resources, including uninitialized ones, in the namespace of the specified resource types"
        },
        {
          "names": [
            "--list"
          ],
          "description": "If true, display the labels for a given resource"
        },
        {
          "names": [
            "--overwrite"
          ],
          "description": "If true, allow labels to be overwritten, otherwise reject label updates that overwrite existing labels"
        }
      ],
      "args": [
        {
          "name": "TYPE | TYPE/NAME"
        },
        {
          "name": "Resource",
          "isOptional": true
        }
      ]
    },
    {
      "name": "logs",
      "description": "Print the logs for a container in a pod or specified resource. If the pod has only one container, the container name is optional",
      "options": [
        {
          "names": [
            "-l",
            "--selector"
          ],
          "description": "Selector (label query) to filter on, not including uninitialized ones, supports '=', '==', and '!='.(e.g. -l key1=value1,key2=value2)"
        },
        {
          "names": [
            "--all-containers"
          ],
          "description": "Get all containers' logs in the pod(s)"
        },
        {
          "names": [
            "-c",
            "--container"
          ],
          "description": "Print the logs of this container"
        },
        {
          "names": [
            "-f",
            "--follow"
          ],
          "description": "Specify if the logs should be streamed"
        },
        {
          "names": [
            "--ignore-errors"
          ],
          "description": "If watching / following pod logs, allow for any errors that occur to be non-fatal"
        },
        {
          "names": [
            "--insecure-skip-tls-verify-backend"
          ],
          "description": "Skip verifying the identity of the kubelet that logs are requested from.  In theory, an attacker could provide invalid log content back. You might want to use this if your kubelet serving certificates have expired"
        },
        {
          "names": [
            "--limit-bytes"
          ],
          "description": "Maximum bytes of logs to return. Defaults to no limit"
        },
        {
          "names": [
            "--max-log-requests"
          ],
          "description": "Specify maximum number of concurrent logs to follow when using by a selector. Defaults to 5"
        },
        {
          "names": [
            "--pod-running-timeout"
          ],
          "description": "The length of time (like 5s, 2m, or 3h, higher than zero) to wait until at least one pod is running"
        },
        {
          "names": [
            "--prefix"
          ],
          "description": "Prefix each log line with the log source (pod name and container name)"
        },
        {
          "names": [
            "-p",
            "--previous"
          ],
          "description": "If true, print the logs for the previous instance of the container in a pod if it exists"
        },
        {
          "names": [
            "--since"
          ],
          "description": "Only return logs newer than a relative duration like 5s, 2m, or 3h. Defaults to all logs. Only one of since-time / since may be used"
        },
        {
          "names": [
            "--since-time"
          ],
          "description": "Only return logs after a specific date (RFC3339). Defaults to all logs. Only one of since-time / since may be used"
        },
        {
          "names": [
            "--tail"
          ],
          "description": "Lines of recent log file to display. Defaults to -1 with no selector, showing all log lines otherwise 10, if a selector is provided"
        },
        {
          "names": [
            "--timestamps"
          ],
          "description": "Include timestamps on each line in the log output"
        }
      ],
      "args": [
        {
          "name": "TYPE | TYPE/NAME"
        },
        {
          "name": "Resource",
          "isOptional": true
        }
      ]
    },
    {
      "name": "patch",
      "description": "Update field(s) of a resource using strategic merge patch, a JSON merge patch, or a JSON patch",
      "options": [
        {
          "names": [
            "--allow-missing-template-keys"
          ],
          "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
        },
        {
          "names": [
            "--dry-run"
          ],
          "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
          "args": {
            "name": "Strategy",
            "suggestions": [
              "none",
              "server",
              "client"
            ]
          }
        },
        {
          "names": [
            "-f",
            "--filename"
          ],
          "description": "Filename, directory, or URL to files identifying the resource",
          "args": {
            "name": "File"
          }
        },
        {
          "names": [
            "-k",
            "--kustomize"
          ],
          "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
          "args": {
            "name": "Kustomize Dir"
          }
        },
        {
          "names": [
            "--local"
          ],
          "description": "If true, annotation will NOT contact api-server but run locally"
        },
        {
          "names": [
            "-o",
            "--output"
          ],
          "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
          "args": {
            "name": "Output Format",
            "suggestions": [
              "json",
              "yaml",
              "name",
              "go-template",
              "go-template-file",
              "template",
              "templatefile",
              "jsonpath",
              "jsonpath-file"
            ]
          }
        },
        {
          "names": [
            "--record"
          ],
          "description": "Record current kubectl command in the resource annotation. If set to false, do not record the command. If set to true, record the command. If not set, default to updating the existing annotation value only if one already exists"
        },
        {
          "names": [
            "-R",
            "--recursive"
          ],
          "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
        },
        {
          "names": [
            "--template"
          ],
          "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
        },
        {
          "names": [
            "-p",
            "--patch"
          ],
          "description": "The patch to be applied to the resource JSON file"
        },
        {
          "names": [
            "--type"
          ],
          "description": "The type of patch being provided; one of [json merge strategic]",
          "args": {
            "suggestions": [
              "json",
              "merge",
              "strategic"
            ]
          }
        }
      ],
      "args": [
        {
          "name": "TYPE | TYPE/NAME"
        },
        {
          "name": "Resource",
          "isOptional": true
        }
      ]
    },
    {
      "name": "plugin",
      "description": "Provides utilities for interacting with plugins"
    },
    {
      "name": "port-forward",
      "description": "Forward one or more local ports to a pod. This command requires the node to have 'socat' installed",
      "options": [
        {
          "names": [
            "--address"
          ],
          "description": "Addresses to listen on (comma separated). Only accepts IP addresses or localhost as a value. When localhost is supplied, kubectl will try to bind on both 127.0.0.1 and ::1 and will fail if neither of these addresses are available to bind"
        },
        {
          "names": [
            "--pod-running-timeout"
          ],
          "description": "The length of time (like 5s, 2m, or 3h, higher than zero) to wait until at least one pod is running"
        }
      ],
      "args": [
        {
          "name": "TYPE | TYPE/NAME"
        },
        {
          "name": "Resource",
          "isOptional": true
        },
        {
          "name": "[LOCAL_PORT:REMOTE_PORT]",
          "isVariadic": true
        }
      ]
    },
    {
      "name": "proxy",
      "description": "Creates a proxy server or application-level gateway between localhost and the Kubernetes API Server. It also allows serving static content over specified HTTP path. All incoming data enters through one port and gets forwarded to the remote kubernetes API Server port, except for the path matching the static content path",
      "options": [
        {
          "names": [
            "--accept-hosts"
          ],
          "description": "Regular expression for hosts that the proxy should accept"
        },
        {
          "names": [
            "--accept-paths"
          ],
          "description": "Regular expression for paths that the proxy should accept"
        },
        {
          "names": [
            "--address"
          ],
          "description": "The IP address on which to serve on"
        },
        {
          "names": [
            "--api-prefix"
          ],
          "description": "Prefix to serve the proxied API under"
        },
        {
          "names": [
            "--disable-filter"
          ],
          "description": "If true, disable request filtering in the proxy. This is dangerous, and can leave you vulnerable to XSRF attacks, when used with an accessible port"
        },
        {
          "names": [
            "--keepalive"
          ],
          "description": "Keepalive specifies the keep-alive period for an active network connection. Set to 0 to disable keepalive"
        },
        {
          "names": [
            "-p",
            "--port"
          ],
          "description": "The port on which to run the proxy. Set to 0 to pick a random port"
        },
        {
          "names": [
            "--reject-methods"
          ],
          "description": "Regular expression for HTTP methods that the proxy should reject (example --reject-methods='POST,PUT,PATCH')"
        },
        {
          "names": [
            "--reject-paths"
          ],
          "description": "Regular expression for paths that the proxy should reject. Paths specified here will be rejected even accepted by --accept-paths"
        },
        {
          "names": [
            "-u",
            "--unix-socket"
          ],
          "description": "Unix socket on which to run the proxy"
        },
        {
          "names": [
            "-w",
            "--www"
          ],
          "description": "Also serve static files from the given directory under the specified prefix"
        },
        {
          "names": [
            "-P",
            "--www-prefix"
          ],
          "description": "Prefix to serve static files under, if static file directory is specified"
        }
      ]
    },
    {
      "name": "replace",
      "description": "Replace a resource by filename or stdin",
      "options": [
        {
          "names": [
            "--allow-missing-template-keys"
          ],
          "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
        },
        {
          "names": [
            "--dry-run"
          ],
          "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
          "args": {
            "name": "Strategy",
            "suggestions": [
              "none",
              "server",
              "client"
            ]
          }
        },
        {
          "names": [
            "-f",
            "--filename"
          ],
          "description": "Filename, directory, or URL to files identifying the resource",
          "args": {
            "name": "File"
          }
        },
        {
          "names": [
            "-k",
            "--kustomize"
          ],
          "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
          "args": {
            "name": "Kustomize Dir"
          }
        },
        {
          "names": [
            "-o",
            "--output"
          ],
          "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
          "args": {
            "name": "Output Format",
            "suggestions": [
              "json",
              "yaml",
              "name",
              "go-template",
              "go-template-file",
              "template",
              "templatefile",
              "jsonpath",
              "jsonpath-file"
            ]
          }
        },
        {
          "names": [
            "-R",
            "--recursive"
          ],
          "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
        },
        {
          "names": [
            "--template"
          ],
          "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
        },
        {
          "names": [
            "--cascade"
          ],
          "description": "If true, cascade the deletion of the resources managed by this resource (e.g. Pods created by a ReplicationController).  Default true"
        },
        {
          "names": [
            "--force"
          ],
          "description": "If true, immediately remove resources from API and bypass graceful deletion. Note that immediate deletion of some resources may result in inconsistency or data loss and requires confirmation"
        },
        {
          "names": [
            "--grace-period"
          ],
          "description": "Period of time in seconds given to the resource to terminate gracefully. Ignored if negative. Set to 1 for immediate shutdown. Can only be set to 0 when --force is true (force deletion)"
        },
        {
          "names": [
            "--raw"
          ],
          "description": "Raw URI to PUT to the server.  Uses the transport specified by the kubeconfig file"
        },
        {
          "names": [
            "--save-config"
          ],
          "description": "If true, the configuration of current object will be saved in its annotation. Otherwise, the annotation will be unchanged. This flag is useful when you want to perform kubectl apply on this object in the future"
        },
        {
          "names": [
            "--timeout"
          ],
          "description": "The length of time to wait before giving up on a delete, zero means determine a timeout from the size of the object"
        },
        {
          "names": [
            "--validate"
          ],
          "description": "If true, use a schema to validate the input before sending it"
        },
        {
          "names": [
            "--wait"
          ],
          "description": "If true, wait for resources to be gone before returning. This waits for finalizers"
        }
      ]
    },
    {
      "name": "rollout",
      "description": "Manage the rollout of a resource",
      "subcommands": [
        {
          "name": "history",
          "description": "View previous rollout revisions and configurations",
          "options": [
            {
              "names": [
                "--allow-missing-template-keys"
              ],
              "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
            },
            {
              "names": [
                "-f",
                "--filename"
              ],
              "description": "Filename, directory, or URL to files identifying the resource",
              "args": {
                "name": "File"
              }
            },
            {
              "names": [
                "-k",
                "--kustomize"
              ],
              "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
              "args": {
                "name": "Kustomize Dir"
              }
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "-R",
                "--recursive"
              ],
              "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
            },
            {
              "names": [
                "--template"
              ],
              "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
            },
            {
              "names": [
                "--revision"
              ],
              "description": "See the details, including podTemplate of the revision specified"
            }
          ],
          "args": [
            {
              "name": "Deployments",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "kubectl",
                    "get",
                    "deployments",
                    "-o",
                    "custom-columns=:.metadata.name"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "pause",
          "description": "Mark the provided resource as paused",
          "options": [
            {
              "names": [
                "--allow-missing-template-keys"
              ],
              "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
            },
            {
              "names": [
                "-f",
                "--filename"
              ],
              "description": "Filename, directory, or URL to files identifying the resource",
              "args": {
                "name": "File"
              }
            },
            {
              "names": [
                "-k",
                "--kustomize"
              ],
              "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
              "args": {
                "name": "Kustomize Dir"
              }
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "-R",
                "--recursive"
              ],
              "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
            },
            {
              "names": [
                "--template"
              ],
              "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
            }
          ],
          "args": [
            {
              "name": "Deployments",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "kubectl",
                    "get",
                    "deployments",
                    "-o",
                    "custom-columns=:.metadata.name"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "restart",
          "description": "Restart a resource",
          "options": [
            {
              "names": [
                "--allow-missing-template-keys"
              ],
              "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
            },
            {
              "names": [
                "-f",
                "--filename"
              ],
              "description": "Filename, directory, or URL to files identifying the resource",
              "args": {
                "name": "File"
              }
            },
            {
              "names": [
                "-k",
                "--kustomize"
              ],
              "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
              "args": {
                "name": "Kustomize Dir"
              }
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "-R",
                "--recursive"
              ],
              "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
            },
            {
              "names": [
                "--template"
              ],
              "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
            }
          ],
          "args": [
            {
              "name": "Deployments",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "kubectl",
                    "get",
                    "deployments",
                    "-o",
                    "custom-columns=:.metadata.name"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "resume",
          "description": "Resume a paused resource",
          "options": [
            {
              "names": [
                "--allow-missing-template-keys"
              ],
              "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
            },
            {
              "names": [
                "-f",
                "--filename"
              ],
              "description": "Filename, directory, or URL to files identifying the resource",
              "args": {
                "name": "File"
              }
            },
            {
              "names": [
                "-k",
                "--kustomize"
              ],
              "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
              "args": {
                "name": "Kustomize Dir"
              }
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "-R",
                "--recursive"
              ],
              "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
            },
            {
              "names": [
                "--template"
              ],
              "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
            }
          ],
          "args": [
            {
              "name": "Deployments",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "kubectl",
                    "get",
                    "deployments",
                    "-o",
                    "custom-columns=:.metadata.name"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "status",
          "description": "Show the status of the rollout",
          "options": [
            {
              "names": [
                "-f",
                "--filename"
              ],
              "description": "Filename, directory, or URL to files identifying the resource",
              "args": {
                "name": "File"
              }
            },
            {
              "names": [
                "-k",
                "--kustomize"
              ],
              "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
              "args": {
                "name": "Kustomize Dir"
              }
            },
            {
              "names": [
                "-R",
                "--recursive"
              ],
              "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
            },
            {
              "names": [
                "--revision"
              ],
              "description": "Pin to a specific revision for showing its status. Defaults to 0 (last revision)"
            },
            {
              "names": [
                "--timeout"
              ],
              "description": "The length of time to wait before ending watch, zero means never. Any other values should contain a corresponding time unit (e.g. 1s, 2m, 3h)"
            },
            {
              "names": [
                "-w",
                "--watch"
              ],
              "description": "Watch the status of the rollout until it's done"
            }
          ],
          "args": [
            {
              "name": "Deployments",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "kubectl",
                    "get",
                    "deployments",
                    "-o",
                    "custom-columns=:.metadata.name"
                  ]
                }
              ]
            }
          ]
        },
        {
          "name": "undo",
          "description": "Rollback to a previous rollout",
          "options": [
            {
              "names": [
                "--allow-missing-template-keys"
              ],
              "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
            },
            {
              "names": [
                "-f",
                "--filename"
              ],
              "description": "Filename, directory, or URL to files identifying the resource",
              "args": {
                "name": "File"
              }
            },
            {
              "names": [
                "-k",
                "--kustomize"
              ],
              "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
              "args": {
                "name": "Kustomize Dir"
              }
            },
            {
              "names": [
                "-R",
                "--recursive"
              ],
              "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
            },
            {
              "names": [
                "--dry-run"
              ],
              "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
              "args": {
                "name": "Strategy",
                "suggestions": [
                  "none",
                  "server",
                  "client"
                ]
              }
            },
            {
              "names": [
                "--to_revision"
              ]
            },
            {
              "names": [
                "--timeout"
              ],
              "description": "The length of time to wait before ending watch, zero means never. Any other values should contain a corresponding time unit (e.g. 1s, 2m, 3h)"
            }
          ],
          "args": [
            {
              "name": "Deployments",
              "generators": [
                {
                  "kind": "script",
                  "script": [
                    "kubectl",
                    "get",
                    "deployments",
                    "-o",
                    "custom-columns=:.metadata.name"
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "run",
      "description": "Create and run a particular image in a pod",
      "options": [
        {
          "names": [
            "--allow-missing-template-keys"
          ],
          "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
        },
        {
          "names": [
            "-f",
            "--filename"
          ],
          "description": "Filename, directory, or URL to files identifying the resource",
          "args": {
            "name": "File"
          }
        },
        {
          "names": [
            "--dry-run"
          ],
          "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
          "args": {
            "name": "Strategy",
            "suggestions": [
              "none",
              "server",
              "client"
            ]
          }
        },
        {
          "names": [
            "-k",
            "--kustomize"
          ],
          "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
          "args": {
            "name": "Kustomize Dir"
          }
        },
        {
          "names": [
            "-R",
            "--recursive"
          ],
          "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
        },
        {
          "names": [
            "-o",
            "--output"
          ],
          "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
          "args": {
            "name": "Output Format",
            "suggestions": [
              "json",
              "yaml",
              "name",
              "go-template",
              "go-template-file",
              "template",
              "templatefile",
              "jsonpath",
              "jsonpath-file"
            ]
          }
        },
        {
          "names": [
            "--record"
          ],
          "description": "Record current kubectl command in the resource annotation. If set to false, do not record the command. If set to true, record the command. If not set, default to updating the existing annotation value only if one already exists"
        },
        {
          "names": [
            "--template"
          ],
          "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
        },
        {
          "names": [
            "--annotations"
          ],
          "description": "Annotations to apply to the pod"
        },
        {
          "names": [
            "--attach"
          ],
          "description": "If true, wait for the Pod to start running, and then attach to the Pod as if 'kubectl attach ...' were called.  Default false, unless '-i/--stdin' is set, in which case the default is true. With '--restart=Never' the exit code of the container process is returned"
        },
        {
          "names": [
            "--cascade"
          ],
          "description": "Must be \"background\", \"orphan\", or \"foreground\". Selects the deletion cascading strategy for the dependents (e.g. Pods created by a ReplicationController). Defaults to background",
          "args": {
            "suggestions": [
              "background",
              "orphan",
              "foreground"
            ]
          }
        },
        {
          "names": [
            "--command"
          ],
          "description": "If true and extra arguments are present, use them as the 'command' field in the container, rather than the 'args' field which is the default"
        },
        {
          "names": [
            "--env"
          ],
          "description": "Environment variables to set in the container"
        },
        {
          "names": [
            "--expose"
          ],
          "description": "If true, service is created for the container(s) which are run"
        },
        {
          "names": [
            "--force"
          ],
          "description": "If true, immediately remove resources from API and bypass graceful deletion. Note that immediate deletion of some resources may result in inconsistency or data loss and requires confirmation"
        },
        {
          "names": [
            "--grace-period"
          ],
          "description": "Period of time in seconds given to the resource to terminate gracefully. Ignored if negative. Set to 1 for immediate shutdown. Can only be set to 0 when --force is true (force deletion)"
        },
        {
          "names": [
            "--hostport"
          ],
          "description": "The host port mapping for the container port. To demonstrate a single-machine container"
        },
        {
          "names": [
            "--image"
          ],
          "description": "The image for the container to run"
        },
        {
          "names": [
            "--image-pull-policy"
          ],
          "description": "The image pull policy for the container. If left empty, this value will not be specified by the client and defaulted by the server"
        },
        {
          "names": [
            "-l",
            "--labels"
          ],
          "description": "Comma separated labels to apply to the pod(s). Will override previous values"
        },
        {
          "names": [
            "--leave-stdin-open"
          ],
          "description": "If the pod is started in interactive mode or with stdin, leave stdin open after the first attach completes. By default, stdin will be closed after the first attach completes"
        },
        {
          "names": [
            "--limits"
          ],
          "description": "The resource requirement limits for this container.  For example, 'cpu=200m,memory=512Mi'.  Note that server side components may assign limits depending on the server configuration, such as limit ranges"
        },
        {
          "names": [
            "--overrides"
          ],
          "description": "An inline JSON override for the generated object. If this is non-empty, it is used to override the generated object. Requires that the object supply a valid apiVersion field"
        },
        {
          "names": [
            "--pod-running-timeout"
          ],
          "description": "The length of time (like 5s, 2m, or 3h, higher than zero) to wait until at least one pod is running"
        },
        {
          "names": [
            "--port"
          ],
          "description": "The port that this container exposes"
        },
        {
          "names": [
            "--quiet"
          ],
          "description": "If true, suppress prompt messages"
        },
        {
          "names": [
            "--requests"
          ],
          "description": "The resource requirement requests for this container.  For example, 'cpu=100m,memory=256Mi'.  Note that server side components may assign requests depending on the server configuration, such as limit ranges"
        },
        {
          "names": [
            "--restart"
          ],
          "description": "The restart policy for this Pod.  Legal values [Always, OnFailure, Never].  If set to 'Always' a deployment is created, if set to 'OnFailure' a job is created, if set to 'Never', a regular pod is created. For the latter two --replicas must be 1.  Default 'Always', for CronJobs `Never`",
          "args": {
            "suggestions": [
              "Always",
              "OnFailure",
              "Never"
            ]
          }
        },
        {
          "names": [
            "--rm"
          ],
          "description": "If true, delete resources created in this command for attached containers"
        },
        {
          "names": [
            "--save-config"
          ],
          "description": "If true, the configuration of current object will be saved in its annotation. Otherwise, the annotation will be unchanged. This flag is useful when you want to perform kubectl apply on this object in the future"
        },
        {
          "names": [
            "--serviceaccount"
          ],
          "description": "Service account to set in the pod spec"
        },
        {
          "names": [
            "-i",
            "--stdin"
          ],
          "description": "Keep stdin open on the container(s) in the pod, even if nothing is attached"
        },
        {
          "names": [
            "--timeout"
          ],
          "description": "The length of time to wait before giving up on a delete, zero means determine a timeout from the size of the object"
        },
        {
          "names": [
            "-t",
            "--tty"
          ],
          "description": "Allocated a TTY for each container in the pod"
        },
        {
          "names": [
            "--wait"
          ],
          "description": "If true, wait for resources to be gone before returning. This waits for finalizers"
        }
      ],
      "args": [
        {
          "name": "NAME"
        }
      ]
    },
    {
      "name": "scale",
      "description": "Set a new size for a Deployment, ReplicaSet, Replication Controller, or StatefulSet",
      "options": [
        {
          "names": [
            "--allow-missing-template-keys"
          ],
          "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
        },
        {
          "names": [
            "-f",
            "--filename"
          ],
          "description": "Filename, directory, or URL to files identifying the resource",
          "args": {
            "name": "File"
          }
        },
        {
          "names": [
            "-k",
            "--kustomize"
          ],
          "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
          "args": {
            "name": "Kustomize Dir"
          }
        },
        {
          "names": [
            "-o",
            "--output"
          ],
          "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
          "args": {
            "name": "Output Format",
            "suggestions": [
              "json",
              "yaml",
              "name",
              "go-template",
              "go-template-file",
              "template",
              "templatefile",
              "jsonpath",
              "jsonpath-file"
            ]
          }
        },
        {
          "names": [
            "-R",
            "--recursive"
          ],
          "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
        },
        {
          "names": [
            "--record"
          ],
          "description": "Record current kubectl command in the resource annotation. If set to false, do not record the command. If set to true, record the command. If not set, default to updating the existing annotation value only if one already exists"
        },
        {
          "names": [
            "--resource-version"
          ],
          "description": "If non-empty, the annotation update will only succeed if this is the current resource-version for the object. Only valid when specifying a single resource"
        },
        {
          "names": [
            "-l",
            "--selector"
          ],
          "description": "Selector (label query) to filter on, not including uninitialized ones, supports '=', '==', and '!='.(e.g. -l key1=value1,key2=value2)"
        },
        {
          "names": [
            "--template"
          ],
          "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
        },
        {
          "names": [
            "--dry-run"
          ],
          "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
          "args": {
            "name": "Strategy",
            "suggestions": [
              "none",
              "server",
              "client"
            ]
          }
        },
        {
          "names": [
            "--all"
          ],
          "description": "Select all resources in the namespace of the specified resource types"
        },
        {
          "names": [
            "--current-replicas"
          ],
          "description": "Precondition for current size. Requires that the current size of the resource match this value in order to scale"
        },
        {
          "names": [
            "--replicas"
          ],
          "description": "The new desired number of replicas. Required"
        },
        {
          "names": [
            "--timeout"
          ],
          "description": "The length of time to wait before giving up on a scale operation, zero means don't wait. Any other values should contain a corresponding time unit (e.g. 1s, 2m, 3h)"
        }
      ],
      "args": [
        {
          "name": "TYPE | TYPE/NAME"
        },
        {
          "name": "Resource",
          "isOptional": true
        }
      ]
    },
    {
      "name": "set",
      "description": "Configure application resources",
      "subcommands": [
        {
          "name": "env",
          "description": "Update environment variables on a pod template",
          "options": [
            {
              "names": [
                "--allow-missing-template-keys"
              ],
              "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
            },
            {
              "names": [
                "--dry-run"
              ],
              "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
              "args": {
                "name": "Strategy",
                "suggestions": [
                  "none",
                  "server",
                  "client"
                ]
              }
            },
            {
              "names": [
                "-f",
                "--filename"
              ],
              "description": "Filename, directory, or URL to files identifying the resource",
              "args": {
                "name": "File"
              }
            },
            {
              "names": [
                "-k",
                "--kustomize"
              ],
              "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
              "args": {
                "name": "Kustomize Dir"
              }
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "--local"
              ],
              "description": "If true, annotation will NOT contact api-server but run locally"
            },
            {
              "names": [
                "-R",
                "--recursive"
              ],
              "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
            },
            {
              "names": [
                "-l",
                "--selector"
              ],
              "description": "Selector (label query) to filter on, not including uninitialized ones, supports '=', '==', and '!='.(e.g. -l key1=value1,key2=value2)"
            },
            {
              "names": [
                "--template"
              ],
              "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
            },
            {
              "names": [
                "--all"
              ],
              "description": "If true, select all resources in the namespace of the specified resource types"
            },
            {
              "names": [
                "-c",
                "--containers"
              ],
              "description": "The names of containers in the selected pod templates to change - may use wildcards"
            },
            {
              "names": [
                "-e",
                "--env"
              ],
              "description": "Specify a key-value pair for an environment variable to set into each container"
            },
            {
              "names": [
                "--from"
              ],
              "description": "The name of a resource from which to inject environment variables"
            },
            {
              "names": [
                "--keys"
              ],
              "description": "Comma-separated list of keys to import from specified resource"
            },
            {
              "names": [
                "--list"
              ],
              "description": "If true, display the environment and any changes in the standard format. this flag will removed when we have kubectl view env"
            },
            {
              "names": [
                "--overwrite"
              ],
              "description": "If true, allow environment to be overwritten, otherwise reject updates that overwrite existing environment"
            },
            {
              "names": [
                "--prefix"
              ],
              "description": "Prefix to append to variable names"
            },
            {
              "names": [
                "--resolve"
              ],
              "description": "If true, show secret or configmap references when listing variables"
            }
          ],
          "args": [
            {
              "name": "TYPE | TYPE/NAME"
            },
            {
              "name": "Resource",
              "isOptional": true
            },
            {
              "name": "KEY=VALUE",
              "isVariadic": true
            }
          ]
        },
        {
          "name": "image",
          "description": "Update existing container image(s) of resources",
          "options": [
            {
              "names": [
                "--allow-missing-template-keys"
              ],
              "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
            },
            {
              "names": [
                "--dry-run"
              ],
              "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
              "args": {
                "name": "Strategy",
                "suggestions": [
                  "none",
                  "server",
                  "client"
                ]
              }
            },
            {
              "names": [
                "-f",
                "--filename"
              ],
              "description": "Filename, directory, or URL to files identifying the resource",
              "args": {
                "name": "File"
              }
            },
            {
              "names": [
                "-k",
                "--kustomize"
              ],
              "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
              "args": {
                "name": "Kustomize Dir"
              }
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "--local"
              ],
              "description": "If true, annotation will NOT contact api-server but run locally"
            },
            {
              "names": [
                "-R",
                "--recursive"
              ],
              "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
            },
            {
              "names": [
                "-l",
                "--selector"
              ],
              "description": "Selector (label query) to filter on, not including uninitialized ones, supports '=', '==', and '!='.(e.g. -l key1=value1,key2=value2)"
            },
            {
              "names": [
                "--template"
              ],
              "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
            },
            {
              "names": [
                "--record"
              ],
              "description": "Record current kubectl command in the resource annotation. If set to false, do not record the command. If set to true, record the command. If not set, default to updating the existing annotation value only if one already exists"
            },
            {
              "names": [
                "--all"
              ],
              "description": "Select all resources, including uninitialized ones, in the namespace of the specified resource types"
            }
          ],
          "args": [
            {
              "name": "TYPE | TYPE/NAME"
            },
            {
              "name": "Resource",
              "isOptional": true
            },
            {
              "name": "CONTAINER_NAME=IMAGE_NAME",
              "isVariadic": true
            }
          ]
        },
        {
          "name": "resources",
          "description": "Specify compute resource requirements (cpu, memory) for any resource that defines a pod template.  If a pod is successfully scheduled, it is guaranteed the amount of resource requested, but may burst up to its specified limits",
          "options": [
            {
              "names": [
                "--allow-missing-template-keys"
              ],
              "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
            },
            {
              "names": [
                "--dry-run"
              ],
              "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
              "args": {
                "name": "Strategy",
                "suggestions": [
                  "none",
                  "server",
                  "client"
                ]
              }
            },
            {
              "names": [
                "-f",
                "--filename"
              ],
              "description": "Filename, directory, or URL to files identifying the resource",
              "args": {
                "name": "File"
              }
            },
            {
              "names": [
                "-k",
                "--kustomize"
              ],
              "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
              "args": {
                "name": "Kustomize Dir"
              }
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "--local"
              ],
              "description": "If true, annotation will NOT contact api-server but run locally"
            },
            {
              "names": [
                "-R",
                "--recursive"
              ],
              "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
            },
            {
              "names": [
                "-l",
                "--selector"
              ],
              "description": "Selector (label query) to filter on, not including uninitialized ones, supports '=', '==', and '!='.(e.g. -l key1=value1,key2=value2)"
            },
            {
              "names": [
                "--template"
              ],
              "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
            },
            {
              "names": [
                "--record"
              ],
              "description": "Record current kubectl command in the resource annotation. If set to false, do not record the command. If set to true, record the command. If not set, default to updating the existing annotation value only if one already exists"
            },
            {
              "names": [
                "--all"
              ],
              "description": "Select all resources, including uninitialized ones, in the namespace of the specified resource types"
            },
            {
              "names": [
                "-c",
                "--containers"
              ],
              "description": "The names of containers in the selected pod templates to change, all containers are selected by default - may use wildcards"
            },
            {
              "names": [
                "--limits"
              ],
              "description": "The resource requirement requests for this container.  For example, 'cpu=100m,memory=256Mi'.  Note that server side components may assign requests depending on the server configuration, such as limit ranges"
            },
            {
              "names": [
                "--requests"
              ],
              "description": "The resource requirement requests for this container.  For example, 'cpu=100m,memory=256Mi'.  Note that server side components may assign requests depending on the server configuration, such as limit ranges"
            }
          ],
          "args": [
            {
              "name": "TYPE | TYPE/NAME"
            },
            {
              "name": "Resource",
              "isOptional": true
            }
          ]
        },
        {
          "name": "selector",
          "description": "Set the selector on a resource. Note that the new selector will overwrite the old selector if the resource had one prior to the invocation of 'set selector'",
          "options": [
            {
              "names": [
                "--allow-missing-template-keys"
              ],
              "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
            },
            {
              "names": [
                "--dry-run"
              ],
              "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
              "args": {
                "name": "Strategy",
                "suggestions": [
                  "none",
                  "server",
                  "client"
                ]
              }
            },
            {
              "names": [
                "-f",
                "--filename"
              ],
              "description": "Filename, directory, or URL to files identifying the resource",
              "args": {
                "name": "File"
              }
            },
            {
              "names": [
                "-k",
                "--kustomize"
              ],
              "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
              "args": {
                "name": "Kustomize Dir"
              }
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "--local"
              ],
              "description": "If true, annotation will NOT contact api-server but run locally"
            },
            {
              "names": [
                "-R",
                "--recursive"
              ],
              "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
            },
            {
              "names": [
                "--template"
              ],
              "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
            },
            {
              "names": [
                "--record"
              ],
              "description": "Record current kubectl command in the resource annotation. If set to false, do not record the command. If set to true, record the command. If not set, default to updating the existing annotation value only if one already exists"
            },
            {
              "names": [
                "--resource-version"
              ],
              "description": "If non-empty, the annotation update will only succeed if this is the current resource-version for the object. Only valid when specifying a single resource"
            },
            {
              "names": [
                "--all"
              ],
              "description": "Select all resources in the namespace of the specified resource types"
            }
          ],
          "args": [
            {
              "name": "TYPE | TYPE/NAME"
            },
            {
              "name": "Resource",
              "isOptional": true
            },
            {
              "name": "EXPRESSIONS"
            }
          ]
        },
        {
          "name": "serviceaccount",
          "description": "Update ServiceAccount of pod template resources",
          "options": [
            {
              "names": [
                "--allow-missing-template-keys"
              ],
              "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
            },
            {
              "names": [
                "--dry-run"
              ],
              "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
              "args": {
                "name": "Strategy",
                "suggestions": [
                  "none",
                  "server",
                  "client"
                ]
              }
            },
            {
              "names": [
                "-f",
                "--filename"
              ],
              "description": "Filename, directory, or URL to files identifying the resource",
              "args": {
                "name": "File"
              }
            },
            {
              "names": [
                "-k",
                "--kustomize"
              ],
              "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
              "args": {
                "name": "Kustomize Dir"
              }
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "--local"
              ],
              "description": "If true, annotation will NOT contact api-server but run locally"
            },
            {
              "names": [
                "-R",
                "--recursive"
              ],
              "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
            },
            {
              "names": [
                "--template"
              ],
              "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
            },
            {
              "names": [
                "--record"
              ],
              "description": "Record current kubectl command in the resource annotation. If set to false, do not record the command. If set to true, record the command. If not set, default to updating the existing annotation value only if one already exists"
            },
            {
              "names": [
                "--all"
              ],
              "description": "Select all resources, including uninitialized ones, in the namespace of the specified resource types"
            }
          ],
          "args": [
            {
              "name": "TYPE | TYPE/NAME"
            },
            {
              "name": "Resource",
              "isOptional": true
            }
          ]
        },
        {
          "name": "subject",
          "description": "Update User, Group or ServiceAccount in a RoleBinding/ClusterRoleBinding",
          "options": [
            {
              "names": [
                "--allow-missing-template-keys"
              ],
              "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
            },
            {
              "names": [
                "--dry-run"
              ],
              "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
              "args": {
                "name": "Strategy",
                "suggestions": [
                  "none",
                  "server",
                  "client"
                ]
              }
            },
            {
              "names": [
                "-f",
                "--filename"
              ],
              "description": "Filename, directory, or URL to files identifying the resource",
              "args": {
                "name": "File"
              }
            },
            {
              "names": [
                "-k",
                "--kustomize"
              ],
              "description": "Process the kustomization directory. This flag can't be used together with -f or -R",
              "args": {
                "name": "Kustomize Dir"
              }
            },
            {
              "names": [
                "-o",
                "--output"
              ],
              "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
              "args": {
                "name": "Output Format",
                "suggestions": [
                  "json",
                  "yaml",
                  "name",
                  "go-template",
                  "go-template-file",
                  "template",
                  "templatefile",
                  "jsonpath",
                  "jsonpath-file"
                ]
              }
            },
            {
              "names": [
                "--local"
              ],
              "description": "If true, annotation will NOT contact api-server but run locally"
            },
            {
              "names": [
                "-R",
                "--recursive"
              ],
              "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
            },
            {
              "names": [
                "--template"
              ],
              "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
            },
            {
              "names": [
                "--record"
              ],
              "description": "Record current kubectl command in the resource annotation. If set to false, do not record the command. If set to true, record the command. If not set, default to updating the existing annotation value only if one already exists"
            },
            {
              "names": [
                "--all"
              ],
              "description": "Select all resources, including uninitialized ones, in the namespace of the specified resource types"
            },
            {
              "names": [
                "--group"
              ],
              "description": "Groups to bind to the role"
            },
            {
              "names": [
                "--serviceaccount"
              ],
              "description": "Service accounts to bind to the role"
            }
          ],
          "args": [
            {
              "name": "TYPE | TYPE/NAME"
            },
            {
              "name": "Resource",
              "isOptional": true
            }
          ]
        }
      ]
    },
    {
      "name": "taint",
      "description": "Update the taints on one or more nodes",
      "options": [
        {
          "names": [
            "--allow-missing-template-keys"
          ],
          "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
        },
        {
          "names": [
            "--dry-run"
          ],
          "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
          "args": {
            "name": "Strategy",
            "suggestions": [
              "none",
              "server",
              "client"
            ]
          }
        },
        {
          "names": [
            "-o",
            "--output"
          ],
          "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
          "args": {
            "name": "Output Format",
            "suggestions": [
              "json",
              "yaml",
              "name",
              "go-template",
              "go-template-file",
              "template",
              "templatefile",
              "jsonpath",
              "jsonpath-file"
            ]
          }
        },
        {
          "names": [
            "-l",
            "--selector"
          ],
          "description": "Selector (label query) to filter on, not including uninitialized ones, supports '=', '==', and '!='.(e.g. -l key1=value1,key2=value2)"
        },
        {
          "names": [
            "--template"
          ],
          "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
        },
        {
          "names": [
            "--all"
          ],
          "description": "Select all nodes in the cluster"
        },
        {
          "names": [
            "--overwrite"
          ],
          "description": "If true, allow taints to be overwritten, otherwise reject taint updates that overwrite existing taints"
        },
        {
          "names": [
            "--validate"
          ],
          "description": "If true, use a schema to validate the input before sending it"
        }
      ],
      "args": [
        {
          "name": "Node",
          "generators": [
            {
              "kind": "script",
              "script": [
                "kubectl",
                "get",
                "nodes",
                "-o",
                "custom-columns=:.metadata.name"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "top",
      "description": "Display Resource (CPU/Memory/Storage) usage"
    },
    {
      "name": "uncordon",
      "description": "Mark node as schedulable",
      "options": [
        {
          "names": [
            "--dry-run"
          ],
          "description": "Must be \"none\", \"server\", or \"client\". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource",
          "args": {
            "name": "Strategy",
            "suggestions": [
              "none",
              "server",
              "client"
            ]
          }
        },
        {
          "names": [
            "-l",
            "--selector"
          ],
          "description": "Selector (label query) to filter on, not including uninitialized ones, supports '=', '==', and '!='.(e.g. -l key1=value1,key2=value2)"
        }
      ],
      "args": [
        {
          "name": "Node",
          "generators": [
            {
              "kind": "script",
              "script": [
                "kubectl",
                "get",
                "nodes",
                "-o",
                "custom-columns=:.metadata.name"
              ]
            }
          ]
        }
      ]
    },
    {
      "name": "version",
      "description": "Print the client and server version information for the current context",
      "options": [
        {
          "names": [
            "-o",
            "--output"
          ],
          "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
          "args": {
            "name": "Output Format",
            "suggestions": [
              "json",
              "yaml",
              "name",
              "go-template",
              "go-template-file",
              "template",
              "templatefile",
              "jsonpath",
              "jsonpath-file"
            ]
          }
        },
        {
          "names": [
            "--client"
          ],
          "description": "If true, shows client version only (no server required)"
        }
      ]
    },
    {
      "name": "wait",
      "description": "Experimental: Wait for a specific condition on one or many resources",
      "options": [
        {
          "names": [
            "--allow-missing-template-keys"
          ],
          "description": "If true, ignore any errors in templates when a field or map key is missing in the template. Only applies to golang and jsonpath output formats"
        },
        {
          "names": [
            "--field-selector"
          ],
          "description": "Selector (field query) to filter on, supports '=', '==', and '!='.(e.g. --field-selector key1=value1,key2=value2). The server only supports a limited number of field queries per type"
        },
        {
          "names": [
            "-f",
            "--filename"
          ],
          "description": "Filename, directory, or URL to files identifying the resource",
          "args": {
            "name": "File"
          }
        },
        {
          "names": [
            "--local"
          ],
          "description": "If true, annotation will NOT contact api-server but run locally"
        },
        {
          "names": [
            "-o",
            "--output"
          ],
          "description": "Output format. One of: json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-file",
          "args": {
            "name": "Output Format",
            "suggestions": [
              "json",
              "yaml",
              "name",
              "go-template",
              "go-template-file",
              "template",
              "templatefile",
              "jsonpath",
              "jsonpath-file"
            ]
          }
        },
        {
          "names": [
            "-R",
            "--recursive"
          ],
          "description": "Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory"
        },
        {
          "names": [
            "-l",
            "--selector"
          ],
          "description": "Selector (label query) to filter on, not including uninitialized ones, supports '=', '==', and '!='.(e.g. -l key1=value1,key2=value2)"
        },
        {
          "names": [
            "--template"
          ],
          "description": "Template string or path to template file to use when -o=go-template, -o=go-template-file. The template format is golang templates [http://golang.org/pkg/text/template/#pkg-overview]"
        },
        {
          "names": [
            "--all"
          ],
          "description": "Select all resources in the namespace of the specified resource types"
        },
        {
          "names": [
            "-A",
            "--all-namespaces"
          ],
          "description": "If present, list the requested object(s) across all namespaces. Namespace in current context is ignored even if specified with --namespace"
        },
        {
          "names": [
            "--for"
          ],
          "description": "The condition to wait on: [delete|condition=condition-name]"
        },
        {
          "names": [
            "--timeout"
          ],
          "description": "The length of time to wait before giving up.  Zero means check once and don't wait, negative means wait for a week"
        }
      ]
    }
  ],
  "options": [
    {
      "names": [
        "-n",
        "--namespace"
      ],
      "description": "If present, the namespace scope for this CLI request",
      "args": {
        "name": "namespace"
      }
    }
  ]
};
