var workspaceGenerator = { custom: async (tokens, executeShellCommand) => {
	const { stdout: npmPrefix } = await executeShellCommand({
		command: "npm",
		args: ["prefix"]
	});
	const { stdout: out } = await executeShellCommand({
		command: "cat",
		args: [`${npmPrefix}/package.json`]
	});
	const suggestions = [];
	try {
		if (out.trim() == "") return suggestions;
		const workspaces = JSON.parse(out)["workspaces"];
		if (workspaces) for (const workspace of workspaces) suggestions.push({
			name: workspace,
			description: "Workspaces"
		});
	} catch (e) {
		console.log(e);
	}
	return suggestions;
} };
/** Generator that lists package.json scripts (with the respect to the `fig` field) */
var npmScriptsGenerator = {
	cache: {
		strategy: "stale-while-revalidate",
		cacheByDirectory: true
	},
	script: [
		"bash",
		"-c",
		"until [[ -f package.json ]] || [[ $PWD = '/' ]]; do cd ..; done; cat package.json"
	],
	postProcess: function(out, [npmClient]) {
		if (out.trim() == "") return [];
		try {
			const packageContent = JSON.parse(out);
			const scripts = packageContent["scripts"];
			const figCompletions = packageContent["fig"] || {};
			if (scripts) return Object.entries(scripts).map(([scriptName, scriptContents]) => {
				return {
					name: scriptName,
					icon: npmClient === "yarn" ? "fig://icon?type=yarn" : "fig://icon?type=npm",
					description: scriptContents,
					priority: 51,
					/**
					* If there are custom definitions for the scripts
					* we want to override the default values
					* */
					...figCompletions[scriptName]
				};
			});
		} catch (e) {
			console.error(e);
		}
		return [];
	}
};
var workSpaceOptions = [{
	name: ["-w", "--workspace"],
	description: "Enable running a command in the context of the configured workspaces of the current project",
	args: {
		name: "workspace",
		generators: workspaceGenerator,
		isVariadic: true
	}
}, {
	name: ["-ws", "--workspaces"],
	description: "Enable running a command in the context of all the configured workspaces"
}];
[...workSpaceOptions];
[...workSpaceOptions];
[...workSpaceOptions], [...workSpaceOptions], [...workSpaceOptions], [...workSpaceOptions], [...workSpaceOptions], [...workSpaceOptions], [...workSpaceOptions], [...workSpaceOptions], [...workSpaceOptions], [...workSpaceOptions], [...workSpaceOptions], [...workSpaceOptions], [...workSpaceOptions], [...workSpaceOptions], [...workSpaceOptions], [...workSpaceOptions], [...workSpaceOptions], [...workSpaceOptions];
//#endregion
//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/yarn.ts
var yarnScriptParserDirectives = { alias: async (token, executeShellCommand) => {
	const npmPrefix = await executeShellCommand({
		command: "npm",
		args: ["prefix"]
	});
	if (npmPrefix.status !== 0) throw new Error("npm prefix command failed");
	const packageJson = await executeShellCommand({
		command: "cat",
		args: [`${npmPrefix.stdout.trim()}/package.json`]
	});
	const script = JSON.parse(packageJson.stdout).scripts?.[token];
	if (!script) throw new Error(`Script not found: '${token}'`);
	return script;
} };
var commonOptions = [
	{
		name: ["-s", "--silent"],
		description: "Skip Yarn console logs"
	},
	{
		name: "--no-default-rc",
		description: "Prevent Yarn from automatically detecting yarnrc and npmrc files"
	},
	{
		name: "--use-yarnrc",
		description: "Specifies a yarnrc file that Yarn should use (.yarnrc only, not .npmrc) (default: )",
		args: {
			name: "path",
			template: "filepaths"
		}
	},
	{
		name: "--verbose",
		description: "Output verbose messages on internal operations"
	},
	{
		name: "--offline",
		description: "Trigger an error if any required dependencies are not available in local cache"
	},
	{
		name: "--prefer-offline",
		description: "Use network only if dependencies are not available in local cache"
	},
	{
		name: ["--enable-pnp", "--pnp"],
		description: "Enable the Plug'n'Play installation"
	},
	{
		name: "--json",
		description: "Format Yarn log messages as lines of JSON"
	},
	{
		name: "--ignore-scripts",
		description: "Don't run lifecycle scripts"
	},
	{
		name: "--har",
		description: "Save HAR output of network traffic"
	},
	{
		name: "--ignore-platform",
		description: "Ignore platform checks"
	},
	{
		name: "--ignore-engines",
		description: "Ignore engines check"
	},
	{
		name: "--ignore-optional",
		description: "Ignore optional dependencies"
	},
	{
		name: "--force",
		description: "Install and build packages even if they were built before, overwrite lockfile"
	},
	{
		name: "--skip-integrity-check",
		description: "Run install without checking if node_modules is installed"
	},
	{
		name: "--check-files",
		description: "Install will verify file tree of packages for consistency"
	},
	{
		name: "--no-bin-links",
		description: "Don't generate bin links when setting up packages"
	},
	{
		name: "--flat",
		description: "Only allow one version of a package"
	},
	{
		name: ["--prod", "--production"],
		description: "Instruct Yarn to ignore NODE_ENV and take its production-or-not status from this flag instead"
	},
	{
		name: "--no-lockfile",
		description: "Don't read or generate a lockfile"
	},
	{
		name: "--pure-lockfile",
		description: "Don't generate a lockfile"
	},
	{
		name: "--frozen-lockfile",
		description: "Don't generate a lockfile and fail if an update is needed"
	},
	{
		name: "--update-checksums",
		description: "Update package checksums from current repository"
	},
	{
		name: "--link-duplicates",
		description: "Create hardlinks to the repeated modules in node_modules"
	},
	{
		name: "--link-folder",
		description: "Specify a custom folder to store global links",
		args: {
			name: "path",
			template: "folders"
		}
	},
	{
		name: "--global-folder",
		description: "Specify a custom folder to store global packages",
		args: {
			name: "path",
			template: "folders"
		}
	},
	{
		name: "--modules-folder",
		description: "Rather than installing modules into the node_modules folder relative to the cwd, output them here",
		args: {
			name: "path",
			template: "folders"
		}
	},
	{
		name: "--preferred-cache-folder",
		description: "Specify a custom folder to store the yarn cache if possible",
		args: {
			name: "path",
			template: "folders"
		}
	},
	{
		name: "--cache-folder",
		description: "Specify a custom folder that must be used to store the yarn cache",
		args: {
			name: "path",
			template: "folders"
		}
	},
	{
		name: "--mutex",
		description: "Use a mutex to ensure only one yarn instance is executing",
		args: { name: "type[:specifier]" }
	},
	{
		name: "--emoji",
		description: "Enables emoji in output",
		args: {
			default: "true",
			suggestions: ["true", "false"]
		}
	},
	{
		name: "--cwd",
		description: "Working directory to use",
		args: {
			name: "cwd",
			template: "folders"
		}
	},
	{
		name: ["--proxy", "--https-proxy"],
		description: "",
		args: { name: "host" }
	},
	{
		name: "--registry",
		description: "Override configuration registry",
		args: { name: "url" }
	},
	{
		name: "--no-progress",
		description: "Disable progress bar"
	},
	{
		name: "--network-concurrency",
		description: "Maximum number of concurrent network requests",
		args: { name: "number" }
	},
	{
		name: "--network-timeout",
		description: "TCP timeout for network requests",
		args: { name: "milliseconds" }
	},
	{
		name: "--non-interactive",
		description: "Do not show interactive prompts"
	},
	{
		name: "--scripts-prepend-node-path",
		description: "Prepend the node executable dir to the PATH in scripts"
	},
	{
		name: "--no-node-version-check",
		description: "Do not warn when using a potentially unsupported Node version"
	},
	{
		name: "--focus",
		description: "Focus on a single workspace by installing remote copies of its sibling workspaces"
	},
	{
		name: "--otp",
		description: "One-time password for two factor authentication",
		args: { name: "otpcode" }
	}
];
[...commonOptions], [...commonOptions], [...commonOptions], [...commonOptions], [...commonOptions], [...commonOptions], [...commonOptions], [...commonOptions], [...commonOptions], [...commonOptions], [...commonOptions], [...commonOptions], [...commonOptions], [...commonOptions], [...commonOptions], [...commonOptions], [...commonOptions];
//#endregion
//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/rushx.ts
var completionSpec = {
	name: "rushx",
	description: "Run arbitrary package scripts for rush project. analogous to npm run",
	args: {
		name: "Scripts",
		description: "Script to run from your package.json",
		filterStrategy: "fuzzy",
		generators: npmScriptsGenerator,
		parserDirectives: yarnScriptParserDirectives,
		isCommand: true
	},
	options: [{
		name: ["-h", "--help"],
		description: "Show this help message and exit"
	}, {
		name: ["-q", "--quiet"],
		description: "Hide rushx startup information"
	}]
};
//#endregion
export { completionSpec as default };
