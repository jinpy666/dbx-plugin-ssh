//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/ssh.ts
var knownHostRegex = /(?:[a-zA-Z0-9-]+\.)+[a-zA-Z0-9]+/;
var resolveAbsolutePath = (path, basePath, home) => {
	if (path.startsWith("/") || path.startsWith("~/") || path === "~") return path.replace("~", home);
	if (basePath.startsWith("/") || basePath.startsWith("~/") || basePath === "~") return basePath.replace("~", home) + (basePath.replace("~", home).endsWith("/") ? "" : "/") + path;
	return basePath + (basePath.endsWith("/") ? "" : "/") + path;
};
var getConfigLines = async (file, executeShellCommand, home, basePath) => {
	const { stdout } = await executeShellCommand({
		command: "cat",
		args: [resolveAbsolutePath(file, basePath, home)]
	});
	const configLines = stdout.split("\n").map((line) => line.trim());
	const includes = configLines.filter((line) => line.toLowerCase().startsWith("include ")).map((line) => line.split(" ")[1]);
	const includeLines = await Promise.all(includes.map((file) => getConfigLines(file, executeShellCommand, home, basePath)));
	return [...configLines, ...includeLines.flat()];
};
//#endregion
//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/mosh.ts
var completionSpec = {
	name: "mosh",
	description: "",
	args: {
		name: "user@hostname",
		description: "Address of remote machine to log into",
		generators: [
			{
				custom: async (tokens, executeCommand, context) => {
					const { stdout } = await executeCommand({
						command: "cat",
						args: [`${context.environmentVariables["HOME"]}/.ssh/known_hosts`]
					});
					return stdout.split("\n").map((line) => {
						const match = knownHostRegex.exec(line);
						if (match) return String(match);
					}).filter((value, index, self) => value && self.indexOf(value) === index).map((knownHost) => ({
						name: (tokens[1].endsWith("@") ? tokens[1] : "") + knownHost,
						description: "SSH host"
					}));
				},
				trigger: "@"
			},
			{ custom: async (tokens, executeShellCommand, context) => {
				return (await getConfigLines("config", executeShellCommand, context.environmentVariables["HOME"], "~/.ssh")).filter((line) => line.trim().toLowerCase().startsWith("host ") && !line.includes("*")).map((host) => ({
					name: host.split(" ")[1],
					description: "SSH host",
					priority: 90
				}));
			} },
			{ template: "history" }
		]
	},
	options: [
		{
			name: ["--help", "-h"],
			description: "Show help for mosh"
		},
		{
			name: "--client",
			description: "Mosh client on local machine (default: \"mosh-client\")"
		},
		{
			name: "--server",
			description: "Mosh server on remote machine (default: \"mosh-server\")"
		},
		{
			name: "--predict",
			description: "Local echo options",
			requiresEquals: true,
			args: { suggestions: [
				{
					name: "adaptive",
					description: "Local echo for slower links [default]"
				},
				{
					name: "always",
					description: "Use local echo even on fast links"
				},
				{
					name: "never",
					description: "Never use local echo"
				},
				{
					name: "experimental",
					description: "Aggressively echo even when incorrect"
				}
			] }
		},
		{
			name: "-4",
			description: "Use IPv4 only"
		},
		{
			name: "-6",
			description: "Use IPv6 only"
		},
		{
			name: "--family",
			description: "Network Type",
			requiresEquals: true,
			args: { suggestions: [
				{
					name: "inet",
					description: "Use IPv4 only"
				},
				{
					name: "ine6",
					description: "Use IPv6 only"
				},
				{
					name: "auto",
					description: "Autodetect network type for single-family hosts only"
				},
				{
					name: "all",
					description: "Try all network types"
				},
				{
					name: "prefer-inet4",
					description: "Use all network types, but try IPv4 first [default]"
				},
				{
					name: "prefer-inet6",
					description: "Use all network types, but try IPv6 first"
				}
			] }
		},
		{
			name: ["--port", "-p"],
			description: "Server-side UDP port or range, (No effect on server-side SSH port)"
		},
		{
			name: "--bind-server",
			description: "{ssh|any|IP}, ask the server to reply from an IP address, (default: \"ssh\")"
		},
		{
			name: "--ssh",
			requiresSeparator: true,
			args: {
				name: "command",
				isCommand: true
			},
			description: "Ssh command to run when setting up session, (example: \"ssh -p 2222\")"
		},
		{
			name: "--no-ssh-pty",
			description: "Do not allocate a pseudo tty on ssh connection"
		},
		{
			name: "--no-init",
			description: "Do not send terminal initialization string"
		},
		{
			name: "--local",
			description: "Run mosh-server locally without using ssh"
		},
		{
			name: "--experimental-remote-ip",
			description: "Select the method for discovering the remote IP address to use for mosh",
			requiresSeparator: true,
			args: {
				name: "method",
				suggestions: [
					"local",
					"remote",
					"proxy"
				],
				default: "proxy"
			}
		},
		{
			name: "--version",
			description: "Version and copyright information"
		}
	]
};
//#endregion
export { completionSpec as default };
