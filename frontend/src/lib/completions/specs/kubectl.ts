// kubectl 结构化补全数据。
//
// 数据来源：kubernetes.io/docs/reference/kubectl 官方速查常用项，格式借鉴
// fig 完成规范的 command/option/args 三层思路。
// 裁剪原则：常用子命令与 flag；资源类型（pods/deployments/…）与 -o 取值做
// 静态枚举；namespace/pod 名等动态值用 dynamic 提示。
import type { SpecCommand } from "../spec";

const KUBE_RESOURCES = ["pods", "services", "deployments", "replicasets", "statefulsets", "daemonsets", "jobs", "cronjobs", "nodes", "namespaces", "configmaps", "secrets", "events", "ingresses", "endpoints", "persistentvolumes", "persistentvolumeclaims", "serviceaccounts"];

const NAMESPACE_FLAG = { name: "namespace", short: "n", description: "Target namespace", arg: "namespace" };

export const kubectlSpec: SpecCommand = {
  name: "kubectl",
  description: "Kubernetes cluster control",
  flags: [
    { name: "kubeconfig", description: "Path to the kubeconfig file", arg: "path" },
    { name: "context", description: "Target kubeconfig context", arg: "name" },
    { name: "namespace", short: "n", description: "Target namespace", arg: "namespace" },
    { name: "v", description: "Log verbosity level", arg: "level" },
  ],
  subcommands: [
    {
      name: "get",
      description: "Display one or many resources",
      flags: [
        { name: "output", short: "o", description: "Output format", arg: "format", values: ["json", "yaml", "wide", "name", "jsonpath", "custom-columns", "table"] },
        { name: "watch", short: "w", description: "Watch for changes" },
        { name: "all-namespaces", short: "A", description: "List across all namespaces" },
        { name: "selector", short: "l", description: "Label selector", arg: "selector" },
        { name: "field-selector", description: "Field selector", arg: "selector" },
        { name: "show-labels", description: "Show all labels" },
        { name: "sort-by", description: "Sort by a JSONPath expression", arg: "jsonpath" },
      ],
      positional: { name: "resource", values: KUBE_RESOURCES },
    },
    {
      name: "describe",
      description: "Show details of a resource",
      flags: [NAMESPACE_FLAG, { name: "show-events", description: "Include events" }],
      positional: { name: "resource", values: KUBE_RESOURCES },
    },
    {
      name: "logs",
      description: "Print container logs",
      flags: [
        { name: "follow", short: "f", description: "Stream logs" },
        { name: "tail", description: "Lines from the end", arg: "lines" },
        { name: "since", description: "Logs newer than a duration", arg: "duration" },
        { name: "previous", short: "p", description: "Logs of the previous instance" },
        { name: "timestamps", description: "Include timestamps" },
        { name: "container", short: "c", description: "Container name", arg: "container" },
      ],
      positional: { name: "pod", dynamic: true },
    },
    {
      name: "apply",
      description: "Apply a configuration to a resource",
      flags: [
        { name: "filename", short: "f", description: "File or URL to apply", arg: "file" },
        { name: "recursive", short: "R", description: "Process directories recursively" },
        { name: "kustomize", short: "k", description: "Kustomize directory", arg: "dir" },
        { name: "dry-run", description: "Simulate the apply", arg: "mode", values: ["none", "server", "client"] },
        { name: "server-side", description: "Server-side apply" },
        { name: "prune", description: "Delete resources no longer configured" },
      ],
    },
    {
      name: "delete",
      description: "Delete resources",
      flags: [
        { name: "filename", short: "f", description: "File or URL", arg: "file" },
        { name: "selector", short: "l", description: "Label selector", arg: "selector" },
        { name: "all", description: "Delete all resources of the type" },
        { name: "force", description: "Immediate deletion" },
        { name: "grace-period", description: "Seconds to wait", arg: "seconds" },
        NAMESPACE_FLAG,
      ],
      positional: { name: "resource", values: KUBE_RESOURCES },
    },
    { name: "edit", description: "Edit a resource on the server", flags: [NAMESPACE_FLAG], positional: { name: "resource", values: KUBE_RESOURCES } },
    { name: "create", description: "Create a resource from a file or stdin", flags: [{ name: "filename", short: "f", description: "File or URL", arg: "file" }, { name: "dry-run", description: "Simulate creation", arg: "mode", values: ["none", "server", "client"] }] },
    { name: "replace", description: "Replace a resource by filename or stdin", flags: [{ name: "filename", short: "f", description: "File or URL", arg: "file" }, { name: "force", description: "Delete then re-create" }] },
    { name: "expose", description: "Expose a resource as a service", flags: [{ name: "port", description: "Service port", arg: "port" }, { name: "type", description: "Service type", arg: "type", values: ["ClusterIP", "NodePort", "LoadBalancer", "ExternalName"] }] },
    { name: "scale", description: "Set a new size for a deployment", flags: [{ name: "replicas", description: "Number of replicas", arg: "count" }, { name: "current-replicas", description: "Only scale if current matches", arg: "count" }] },
    { name: "port-forward", description: "Forward ports to a pod or service", flags: [NAMESPACE_FLAG], positional: { name: "pod ports", dynamic: true } },
    { name: "exec", description: "Execute a command in a container", flags: [{ name: "stdin", short: "i", description: "Pass STDIN" }, { name: "tty", short: "t", description: "Allocate a TTY" }, { name: "container", short: "c", description: "Container name", arg: "container" }], positional: { name: "pod", dynamic: true } },
    { name: "cp", description: "Copy files to and from containers", positional: { name: "src dst", dynamic: true } },
    { name: "top", description: "Resource usage of nodes or pods", subcommands: [{ name: "node", description: "Node resource usage" }, { name: "pod", description: "Pod resource usage", flags: [{ name: "all-namespaces", short: "A", description: "All namespaces" }, { name: "selector", short: "l", description: "Label selector", arg: "selector" }] }] },
    {
      name: "rollout",
      description: "Manage the rollout of resources",
      subcommands: [
        { name: "status", description: "Show rollout status" },
        { name: "history", description: "View revision history" },
        { name: "undo", description: "Undo a previous rollout", flags: [{ name: "to-revision", description: "Target revision", arg: "revision" }] },
        { name: "restart", description: "Restart resources" },
        { name: "pause", description: "Mark a resource as paused" },
        { name: "resume", description: "Resume a paused resource" },
      ],
      positional: { name: "resource", values: ["deployments", "statefulsets", "daemonsets"] },
    },
    { name: "auth", description: "Inspect authorization", subcommands: [{ name: "can-i", description: "Check an action is allowed" }, { name: "whoami", description: "Experimental: current subject" }] },
    { name: "config", description: "Modify kubeconfig files", subcommands: [{ name: "current-context", description: "Show current context" }, { name: "use-context", description: "Switch context", positional: { name: "context", dynamic: true } }, { name: "get-contexts", description: "List contexts" }, { name: "get-clusters", description: "List clusters" }, { name: "set-context", description: "Modify a context entry" }] },
    { name: "api-resources", description: "List supported API resources", flags: [{ name: "namespaced", description: "Only namespaced resources" }, { name: "verbs", description: "Filter by supported verbs", arg: "verbs" }] },
    { name: "api-versions", description: "List supported API versions" },
    { name: "version", description: "Print client and server version", flags: [{ name: "output", short: "o", description: "Output format", arg: "format", values: ["json", "yaml"] }, { name: "short", description: "Print just the version numbers" }] },
    { name: "explain", description: "Documentation of resources", positional: { name: "resource", values: KUBE_RESOURCES } },
  ],
};
