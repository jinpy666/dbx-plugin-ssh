var atsInStr = (s) => (s.match(/@/g) || []).length;
var createNpmSearchHandler = (keywords) => async (context, executeShellCommand, shellContext) => {
	const searchTerm = context[context.length - 1];
	if (searchTerm === "") return [];
	const keywordParameter = keywords && keywords.length > 0 ? `+keywords:${keywords.join(",")}` : "";
	const queryPackages = [
		"-s",
		"-H",
		"Accept: application/json",
		keywordParameter ? `https://api.npms.io/v2/search?size=20&q=${searchTerm}${keywordParameter}` : `https://api.npms.io/v2/search/suggestions?q=${searchTerm}&size=20`
	];
	const queryVersions = [
		"-s",
		"-H",
		"Accept: application/vnd.npm.install-v1+json",
		`https://registry.npmjs.org/${searchTerm.slice(0, -1)}`
	];
	const out = (query) => executeShellCommand({
		command: "curl",
		args: query[query.length - 1] === "@" ? queryVersions : queryPackages
	});
	const shouldGetVersion = searchTerm.startsWith("@") ? atsInStr(searchTerm) > 1 : searchTerm.includes("@");
	try {
		const data = JSON.parse((await out(searchTerm)).stdout);
		if (shouldGetVersion) {
			const versions = Object.entries(data["dist-tags"] || {}).map(([key, value]) => ({
				name: key,
				description: value
			}));
			versions.push(...Object.keys(data.versions).map((version) => ({ name: version })).reverse());
			return versions;
		}
		return (keywordParameter ? data.results : data).map((item) => ({
			name: item.package.name,
			description: item.package.description
		}));
	} catch (error) {
		console.error({ error });
		return [];
	}
};
var npmSearchGenerator = {
	trigger: (newToken, oldToken) => {
		if (oldToken.startsWith("@")) return !(atsInStr(oldToken) > 1 && atsInStr(newToken) > 1);
		return !(oldToken.includes("@") && newToken.includes("@"));
	},
	getQueryTerm: "@",
	cache: { ttl: 1728e5 },
	custom: createNpmSearchHandler()
};
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
var nodeClis = /* @__PURE__ */ new Set([
	"vue",
	"vite",
	"nuxt",
	"react-native",
	"degit",
	"expo",
	"jest",
	"next",
	"electron",
	"prisma",
	"eslint",
	"prettier",
	"tsc",
	"typeorm",
	"babel",
	"remotion",
	"autocomplete-tools",
	"redwood",
	"rw",
	"create-completion-spec",
	"publish-spec-to-team",
	"capacitor",
	"cap"
]);
var getGlobalPackagesGenerator = { custom: async (tokens, executeCommand, generatorContext) => {
	const { stdout: yarnGlobalDir } = await executeCommand({
		command: "yarn",
		args: ["global", "dir"]
	});
	const { stdout } = await executeCommand({
		command: "cat",
		args: [`${yarnGlobalDir.trim()}/package.json`]
	});
	if (stdout.trim() == "") return [];
	try {
		const packageContent = JSON.parse(stdout);
		const dependencyScripts = packageContent["dependencies"] || {};
		const devDependencyScripts = packageContent["devDependencies"] || {};
		return [...Object.keys(dependencyScripts), ...Object.keys(devDependencyScripts)].filter((dependency) => !tokens.includes(dependency)).map((dependencyName) => ({
			name: dependencyName,
			icon: "📦"
		}));
	} catch (e) {}
	return [];
} };
var allDependenciesGenerator = {
	script: [
		"yarn",
		"list",
		"--depth=0",
		"--json"
	],
	postProcess: (out) => {
		if (out.trim() == "") return [];
		try {
			return JSON.parse(out).data.trees.map((dependency) => ({
				name: dependency.name.split("@")[0],
				icon: "📦"
			}));
		} catch (e) {}
		return [];
	}
};
var configList = {
	script: [
		"yarn",
		"config",
		"list"
	],
	postProcess: function(out) {
		if (out.trim() == "") return [];
		try {
			const startIndex = out.indexOf("{");
			const endIndex = out.indexOf("}");
			let output = out.substring(startIndex, endIndex + 1);
			output = output.replace(/\'/gi, "\"").replace("lastUpdateCheck", "\"lastUpdateCheck\"").replace("registry", "\"lastUpdateCheck\"");
			const configObject = JSON.parse(output);
			if (configObject) return Object.keys(configObject).map((key) => ({ name: key }));
		} catch (e) {}
		return [];
	}
};
var dependenciesGenerator = {
	script: [
		"bash",
		"-c",
		"until [[ -f package.json ]] || [[ $PWD = '/' ]]; do cd ..; done; cat package.json"
	],
	postProcess: function(out, context = []) {
		if (out.trim() === "") return [];
		try {
			const packageContent = JSON.parse(out);
			const dependencies = packageContent["dependencies"] ?? {};
			const devDependencies = packageContent["devDependencies"];
			const optionalDependencies = packageContent["optionalDependencies"] ?? {};
			Object.assign(dependencies, devDependencies, optionalDependencies);
			return Object.keys(dependencies).filter((pkgName) => {
				return !context.some((current) => current === pkgName);
			}).map((pkgName) => ({
				name: pkgName,
				icon: "📦",
				description: dependencies[pkgName] ? "dependency" : optionalDependencies[pkgName] ? "optionalDependency" : "devDependency"
			}));
		} catch (e) {
			console.error(e);
			return [];
		}
	}
};
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
var createCLIsGenerator = {
	script: function(context) {
		if (context[context.length - 1] === "") return void 0;
		return [
			"curl",
			"-s",
			"-H",
			"Accept: application/json",
			`https://api.npms.io/v2/search?q=${"create-" + context[context.length - 1]}&size=20`
		];
	},
	cache: { ttl: 2592e4 },
	postProcess: function(out) {
		try {
			return JSON.parse(out).results.map((item) => ({
				name: item.package.name.substring(7),
				description: item.package.description
			}));
		} catch (e) {
			return [];
		}
	}
};
var completionSpec = {
	name: "yarn",
	description: "Manage packages and run scripts",
	generateSpec: async (tokens, executeShellCommand) => {
		return {
			name: "yarn",
			subcommands: (await executeShellCommand({
				command: "bash",
				args: ["-c", `until [[ -d node_modules/ ]] || [[ $PWD = '/' ]]; do cd ..; done; ls -1 node_modules/.bin/`]
			})).stdout.split("\n").filter((name) => nodeClis.has(name)).map((name) => ({
				name,
				loadSpec: name === "rw" ? "redwood" : name,
				icon: "fig://icon?type=package"
			}))
		};
	},
	args: {
		generators: npmScriptsGenerator,
		filterStrategy: "fuzzy",
		parserDirectives: yarnScriptParserDirectives,
		isOptional: true,
		isCommand: true
	},
	options: [
		{
			name: "--disable-pnp",
			description: "Disable the Plug'n'Play installation"
		},
		{
			name: "--emoji",
			description: "Enable emoji in output (default: true)",
			args: {
				name: "bool",
				suggestions: [{ name: "true" }, { name: "false" }]
			}
		},
		{
			name: ["--enable-pnp", "--pnp"],
			description: "Enable the Plug'n'Play installation"
		},
		{
			name: "--flat",
			description: "Only allow one version of a package"
		},
		{
			name: "--focus",
			description: "Focus on a single workspace by installing remote copies of its sibling workspaces"
		},
		{
			name: "--force",
			description: "Install and build packages even if they were built before, overwrite lockfile"
		},
		{
			name: "--frozen-lockfile",
			description: "Don't generate a lockfile and fail if an update is needed"
		},
		{
			name: "--global-folder",
			description: "Specify a custom folder to store global packages",
			args: { template: "folders" }
		},
		{
			name: "--har",
			description: "Save HAR output of network traffic"
		},
		{
			name: "--https-proxy",
			description: "",
			args: {
				name: "path",
				suggestions: [{ name: "https://" }]
			}
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
			name: "--ignore-platform",
			description: "Ignore platform checks"
		},
		{
			name: "--ignore-scripts",
			description: "Don't run lifecycle scripts"
		},
		{
			name: "--json",
			description: "Format Yarn log messages as lines of JSON (see jsonlines.org)"
		},
		{
			name: "--link-duplicates",
			description: "Create hardlinks to the repeated modules in node_modules"
		},
		{
			name: "--link-folder",
			description: "Specify a custom folder to store global links",
			args: { template: "folders" }
		},
		{
			name: "--modules-folder",
			description: "Rather than installing modules into the node_modules folder relative to the cwd, output them here",
			args: { template: "folders" }
		},
		{
			name: "--mutex",
			description: "Use a mutex to ensure only one yarn instance is executing",
			args: [{
				name: "type",
				suggestions: [{ name: ":" }]
			}, {
				name: "specifier",
				suggestions: [{ name: ":" }]
			}]
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
			name: "--no-bin-links",
			description: "Don't generate bin links when setting up packages"
		},
		{
			name: "--no-default-rc",
			description: "Prevent Yarn from automatically detecting yarnrc and npmrc files"
		},
		{
			name: "--no-lockfile",
			description: "Don't read or generate a lockfile"
		},
		{
			name: "--non-interactive",
			description: "Do not show interactive prompts"
		},
		{
			name: "--no-node-version-check",
			description: "Do not warn when using a potentially unsupported Node version"
		},
		{
			name: "--no-progress",
			description: "Disable progress bar"
		},
		{
			name: "--offline",
			description: "Trigger an error if any required dependencies are not available in local cache"
		},
		{
			name: "--otp",
			description: "One-time password for two factor authentication",
			args: { name: "otpcode" }
		},
		{
			name: "--prefer-offline",
			description: "Use network only if dependencies are not available in local cache"
		},
		{
			name: "--preferred-cache-folder",
			description: "Specify a custom folder to store the yarn cache if possible",
			args: { template: "folders" }
		},
		{
			name: ["--prod", "--production"],
			description: "",
			args: {}
		},
		{
			name: "--proxy",
			description: "",
			args: { name: "host" }
		},
		{
			name: "--pure-lockfile",
			description: "Don't generate a lockfile"
		},
		{
			name: "--registry",
			description: "Override configuration registry",
			args: { name: "url" }
		},
		{
			name: ["-s", "--silent"],
			description: "Skip Yarn console logs, other types of logs (script output) will be printed"
		},
		{
			name: "--scripts-prepend-node-path",
			description: "Prepend the node executable dir to the PATH in scripts",
			args: { suggestions: [{ name: "true" }, { name: "false" }] }
		},
		{
			name: "--skip-integrity-check",
			description: "Run install without checking if node_modules is installed"
		},
		{
			name: "--strict-semver",
			description: ""
		},
		...commonOptions,
		{
			name: ["-v", "--version"],
			description: "Output the version number"
		},
		{
			name: ["-h", "--help"],
			description: "Output usage information"
		}
	],
	subcommands: [
		{
			name: "add",
			description: "Installs a package and any packages that it depends on",
			args: {
				name: "package",
				generators: npmSearchGenerator,
				debounce: true,
				isVariadic: true
			},
			options: [
				...commonOptions,
				{
					name: ["-W", "--ignore-workspace-root-check"],
					description: "Required to run yarn add inside a workspace root"
				},
				{
					name: ["-D", "--dev"],
					description: "Save package to your `devDependencies`"
				},
				{
					name: ["-P", "--peer"],
					description: "Save package to your `peerDependencies`"
				},
				{
					name: ["-O", "--optional"],
					description: "Save package to your `optionalDependencies`"
				},
				{
					name: ["-E", "--exact"],
					description: "Install exact version",
					dependsOn: ["--latest"]
				},
				{
					name: ["-T", "--tilde"],
					description: "Install most recent release with the same minor version"
				},
				{
					name: ["-A", "--audit"],
					description: "Run vulnerability audit on installed packages"
				},
				{
					name: ["-h", "--help"],
					description: "Output usage information"
				}
			]
		},
		{
			name: "audit",
			description: "Perform a vulnerability audit against the installed packages",
			options: [
				{
					name: "--summary",
					description: "Only print the summary"
				},
				{
					name: "--groups",
					description: "Only audit dependencies from listed groups. Default: devDependencies, dependencies, optionalDependencies",
					args: {
						name: "group_name",
						isVariadic: true
					}
				},
				{
					name: "--level",
					description: "Only print advisories with severity greater than or equal to one of the following: info|low|moderate|high|critical. Default: info",
					args: {
						name: "severity",
						suggestions: [
							{ name: "info" },
							{ name: "low" },
							{ name: "moderate" },
							{ name: "high" },
							{ name: "critical" }
						]
					}
				},
				{
					name: ["-h", "--help"],
					description: "Output usage information"
				}
			]
		},
		{
			name: "autoclean",
			description: "Cleans and removes unnecessary files from package dependencies",
			options: [
				{
					name: ["-h", "--help"],
					description: "Output usage information"
				},
				{
					name: ["-i", "--init"],
					description: "Creates the .yarnclean file if it does not exist, and adds the default entries"
				},
				{
					name: ["-f", "--force"],
					description: "If a .yarnclean file exists, run the clean process"
				}
			]
		},
		{
			name: "bin",
			description: "Displays the location of the yarn bin folder",
			options: [{
				name: ["-h", "--help"],
				description: "Output usage information"
			}]
		},
		{
			name: "cache",
			description: "Yarn cache list will print out every cached package",
			options: [...commonOptions, {
				name: ["-h", "--help"],
				description: "Output usage information"
			}],
			subcommands: [
				{
					name: "clean",
					description: "Clear global cache"
				},
				{
					name: "dir",
					description: "Print yarn’s global cache path"
				},
				{
					name: "list",
					description: "Print out every cached package",
					options: [{
						name: "--pattern",
						description: "Filter cached packages by pattern",
						args: { name: "pattern" }
					}]
				}
			]
		},
		{
			name: "config",
			description: "Configure yarn",
			options: [{
				name: ["-h", "--help"],
				description: "Output usage information"
			}],
			subcommands: [
				{
					name: "set",
					description: "Sets the config key to a certain value",
					options: [{
						name: ["-g", "--global"],
						description: "Set global config"
					}]
				},
				{
					name: "get",
					description: "Print the value for a given key",
					args: { generators: configList }
				},
				{
					name: "delete",
					description: "Deletes a given key from the config",
					args: { generators: configList }
				},
				{
					name: "list",
					description: "Displays the current configuration"
				}
			]
		},
		{
			name: "create",
			description: "Creates new projects from any create-* starter kits",
			args: {
				name: "cli",
				generators: createCLIsGenerator,
				loadSpec: async (token) => ({
					name: "create-" + token,
					type: "global"
				}),
				isCommand: true
			},
			options: [...commonOptions, {
				name: ["-h", "--help"],
				description: "Output usage information"
			}]
		},
		{
			name: "exec",
			description: "",
			options: [{
				name: ["-h", "--help"],
				description: "Output usage information"
			}]
		},
		{
			name: "generate-lock-entry",
			description: "Generates a lock file entry",
			options: [
				{
					name: "--use-manifest",
					description: "Specify which manifest file to use for generating lock entry",
					args: { template: "filepaths" }
				},
				{
					name: "--resolved",
					description: "Generate from <*.tgz>#<hash>",
					args: { template: "filepaths" }
				},
				{
					name: ["-h", "--help"],
					description: "Output usage information"
				}
			]
		},
		{
			name: "global",
			description: "Manage yarn globally",
			subcommands: [
				{
					name: "add",
					description: "Install globally packages on your operating system",
					args: {
						name: "package",
						generators: npmSearchGenerator,
						debounce: true,
						isVariadic: true
					}
				},
				{
					name: "bin",
					description: "Displays the location of the yarn global bin folder"
				},
				{
					name: "dir",
					description: "Displays the location of the global installation folder"
				},
				{
					name: "ls",
					description: "List globally installed packages (deprecated)"
				},
				{
					name: "list",
					description: "List globally installed packages"
				},
				{
					name: "remove",
					description: "Remove globally installed packages",
					args: {
						name: "package",
						filterStrategy: "fuzzy",
						generators: getGlobalPackagesGenerator,
						isVariadic: true
					},
					options: [
						...commonOptions,
						{
							name: ["-W", "--ignore-workspace-root-check"],
							description: "Required to run yarn remove inside a workspace root"
						},
						{
							name: ["-h", "--help"],
							description: "Output usage information"
						}
					]
				},
				{
					name: "upgrade",
					description: "Upgrade globally installed packages",
					options: [
						...commonOptions,
						{
							name: ["-S", "--scope"],
							description: "Upgrade packages under the specified scope",
							args: { name: "scope" }
						},
						{
							name: ["-L", "--latest"],
							description: "List the latest version of packages"
						},
						{
							name: ["-E", "--exact"],
							description: "Install exact version. Only used when --latest is specified",
							dependsOn: ["--latest"]
						},
						{
							name: ["-P", "--pattern"],
							description: "Upgrade packages that match pattern",
							args: { name: "pattern" }
						},
						{
							name: ["-T", "--tilde"],
							description: "Install most recent release with the same minor version. Only used when --latest is specified"
						},
						{
							name: ["-C", "--caret"],
							description: "Install most recent release with the same major version. Only used when --latest is specified",
							dependsOn: ["--latest"]
						},
						{
							name: ["-A", "--audit"],
							description: "Run vulnerability audit on installed packages"
						},
						{
							name: ["-h", "--help"],
							description: "Output usage information"
						}
					]
				},
				{
					name: "upgrade-interactive",
					description: "Display the outdated packages before performing any upgrade",
					options: [{
						name: "--latest",
						description: "Use the version tagged latest in the registry"
					}]
				}
			],
			options: [
				...commonOptions,
				{
					name: "--prefix",
					description: "Bin prefix to use to install binaries",
					args: { name: "prefix" }
				},
				{
					name: "--latest",
					description: "Bin prefix to use to install binaries"
				},
				{
					name: ["-h", "--help"],
					description: "Output usage information"
				}
			]
		},
		{
			name: "help",
			description: "Output usage information"
		},
		{
			name: "import",
			description: "Generates yarn.lock from an npm package-lock.json file"
		},
		{
			name: "info",
			description: "Show information about a package"
		},
		{
			name: "init",
			description: "Interactively creates or updates a package.json file",
			options: [
				...commonOptions,
				{
					name: ["-y", "--yes"],
					description: "Use default options"
				},
				{
					name: ["-p", "--private"],
					description: "Use default options and private true"
				},
				{
					name: ["-i", "--install"],
					description: "Install a specific Yarn release",
					args: { name: "version" }
				},
				{
					name: "-2",
					description: "Generates the project using Yarn 2"
				},
				{
					name: ["-h", "--help"],
					description: "Output usage information"
				}
			]
		},
		{
			name: "install",
			description: "Install all the dependencies listed within package.json",
			options: [
				...commonOptions,
				{
					name: ["-A", "--audit"],
					description: "Run vulnerability audit on installed packages"
				},
				{
					name: ["-h", "--help"],
					description: "Output usage information"
				}
			]
		},
		{
			name: "licenses",
			description: "",
			subcommands: [{
				name: "list",
				description: "List licenses for installed packages"
			}, {
				name: "generate-disclaimer",
				description: "List of licenses from all the packages"
			}]
		},
		{
			name: "link",
			description: "Symlink a package folder during development",
			args: {
				isOptional: true,
				name: "package"
			},
			options: [...commonOptions, {
				name: ["-h", "--help"],
				description: "Output usage information"
			}]
		},
		{
			name: "list",
			description: "Lists all dependencies for the current working directory",
			options: [{
				name: "--depth",
				description: "Restrict the depth of the dependencies"
			}, {
				name: "--pattern",
				description: "Filter the list of dependencies by the pattern"
			}]
		},
		{
			name: "login",
			description: "Store registry username and email"
		},
		{
			name: "logout",
			description: "Clear registry username and email"
		},
		{
			name: "node",
			description: ""
		},
		{
			name: "outdated",
			description: "Checks for outdated package dependencies",
			options: [...commonOptions, {
				name: ["-h", "--help"],
				description: "Output usage information"
			}]
		},
		{
			name: "owner",
			description: "Manage package owners",
			subcommands: [
				{
					name: "list",
					description: "Lists all of the owners of a package",
					args: { name: "package" }
				},
				{
					name: "add",
					description: "Adds the user as an owner of the package",
					args: { name: "package" }
				},
				{
					name: "remove",
					description: "Removes the user as an owner of the package",
					args: [{ name: "user" }, { name: "package" }]
				}
			]
		},
		{
			name: "pack",
			description: "Creates a compressed gzip archive of package dependencies",
			options: [{
				name: "--filename",
				description: "Creates a compressed gzip archive of package dependencies and names the file filename"
			}]
		},
		{
			name: "policies",
			description: "Defines project-wide policies for your project",
			subcommands: [{
				name: "set-version",
				description: "Will download the latest stable release",
				options: [{
					name: "--rc",
					description: "Download the latest rc release"
				}]
			}]
		},
		{
			name: "publish",
			description: "Publishes a package to the npm registry",
			args: {
				name: "Tarball or Folder",
				template: "folders"
			},
			options: [
				...commonOptions,
				{
					name: ["-h", "--help"],
					description: "Output usage information"
				},
				{
					name: "--major",
					description: "Auto-increment major version number"
				},
				{
					name: "--minor",
					description: "Auto-increment minor version number"
				},
				{
					name: "--patch",
					description: "Auto-increment patch version number"
				},
				{
					name: "--premajor",
					description: "Auto-increment premajor version number"
				},
				{
					name: "--preminor",
					description: "Auto-increment preminor version number"
				},
				{
					name: "--prepatch",
					description: "Auto-increment prepatch version number"
				},
				{
					name: "--prerelease",
					description: "Auto-increment prerelease version number"
				},
				{
					name: "--preid",
					description: "Add a custom identifier to the prerelease",
					args: { name: "preid" }
				},
				{
					name: "--message",
					description: "Message",
					args: { name: "message" }
				},
				{
					name: "--no-git-tag-version",
					description: "No git tag version"
				},
				{
					name: "--no-commit-hooks",
					description: "Bypass git hooks when committing new version"
				},
				{
					name: "--access",
					description: "Access",
					args: { name: "access" }
				},
				{
					name: "--tag",
					description: "Tag",
					args: { name: "tag" }
				}
			]
		},
		{
			name: "remove",
			description: "Remove installed package",
			args: {
				filterStrategy: "fuzzy",
				generators: dependenciesGenerator,
				isVariadic: true
			},
			options: [
				...commonOptions,
				{
					name: ["-W", "--ignore-workspace-root-check"],
					description: "Required to run yarn remove inside a workspace root"
				},
				{
					name: ["-h", "--help"],
					description: "Output usage information"
				}
			]
		},
		{
			name: "run",
			description: "Runs a defined package script",
			options: [...commonOptions, {
				name: ["-h", "--help"],
				description: "Output usage information"
			}],
			args: [{
				name: "script",
				description: "Script to run from your package.json",
				generators: npmScriptsGenerator,
				filterStrategy: "fuzzy",
				parserDirectives: yarnScriptParserDirectives,
				isCommand: true
			}, {
				name: "env",
				suggestions: ["env"],
				description: "Lists environment variables available to scripts",
				isOptional: true
			}]
		},
		{
			name: "tag",
			description: "Add, remove, or list tags on a package"
		},
		{
			name: "team",
			description: "Maintain team memberships",
			subcommands: [
				{
					name: "create",
					description: "Create a new team",
					args: { name: "<scope:team>" }
				},
				{
					name: "destroy",
					description: "Destroys an existing team",
					args: { name: "<scope:team>" }
				},
				{
					name: "add",
					description: "Add a user to an existing team",
					args: [{ name: "<scope:team>" }, { name: "<user>" }]
				},
				{
					name: "remove",
					description: "Remove a user from a team they belong to",
					args: { name: "<scope:team> <user>" }
				},
				{
					name: "list",
					description: "If performed on an organization name, will return a list of existing teams under that organization. If performed on a team, it will instead return a list of all users belonging to that particular team",
					args: { name: "<scope>|<scope:team>" }
				}
			]
		},
		{
			name: "unlink",
			description: "Unlink a previously created symlink for a package"
		},
		{
			name: "unplug",
			description: ""
		},
		{
			name: "upgrade",
			description: "Upgrades packages to their latest version based on the specified range",
			args: {
				name: "package",
				generators: dependenciesGenerator,
				filterStrategy: "fuzzy",
				isVariadic: true,
				isOptional: true
			},
			options: [
				...commonOptions,
				{
					name: ["-S", "--scope"],
					description: "Upgrade packages under the specified scope",
					args: { name: "scope" }
				},
				{
					name: ["-L", "--latest"],
					description: "List the latest version of packages"
				},
				{
					name: ["-E", "--exact"],
					description: "Install exact version. Only used when --latest is specified",
					dependsOn: ["--latest"]
				},
				{
					name: ["-P", "--pattern"],
					description: "Upgrade packages that match pattern",
					args: { name: "pattern" }
				},
				{
					name: ["-T", "--tilde"],
					description: "Install most recent release with the same minor version. Only used when --latest is specified"
				},
				{
					name: ["-C", "--caret"],
					description: "Install most recent release with the same major version. Only used when --latest is specified",
					dependsOn: ["--latest"]
				},
				{
					name: ["-A", "--audit"],
					description: "Run vulnerability audit on installed packages"
				},
				{
					name: ["-h", "--help"],
					description: "Output usage information"
				}
			]
		},
		{
			name: "upgrade-interactive",
			description: "Upgrades packages in interactive mode",
			options: [{
				name: "--latest",
				description: "Use the version tagged latest in the registry"
			}]
		},
		{
			name: "version",
			description: "Update version of your package",
			options: [
				...commonOptions,
				{
					name: ["-h", "--help"],
					description: "Output usage information"
				},
				{
					name: "--new-version",
					description: "New version",
					args: { name: "version" }
				},
				{
					name: "--major",
					description: "Auto-increment major version number"
				},
				{
					name: "--minor",
					description: "Auto-increment minor version number"
				},
				{
					name: "--patch",
					description: "Auto-increment patch version number"
				},
				{
					name: "--premajor",
					description: "Auto-increment premajor version number"
				},
				{
					name: "--preminor",
					description: "Auto-increment preminor version number"
				},
				{
					name: "--prepatch",
					description: "Auto-increment prepatch version number"
				},
				{
					name: "--prerelease",
					description: "Auto-increment prerelease version number"
				},
				{
					name: "--preid",
					description: "Add a custom identifier to the prerelease",
					args: { name: "preid" }
				},
				{
					name: "--message",
					description: "Message",
					args: { name: "message" }
				},
				{
					name: "--no-git-tag-version",
					description: "No git tag version"
				},
				{
					name: "--no-commit-hooks",
					description: "Bypass git hooks when committing new version"
				},
				{
					name: "--access",
					description: "Access",
					args: { name: "access" }
				},
				{
					name: "--tag",
					description: "Tag",
					args: { name: "tag" }
				}
			]
		},
		{
			name: "versions",
			description: "Displays version information of the currently installed Yarn, Node.js, and its dependencies"
		},
		{
			name: "why",
			description: "Show information about why a package is installed",
			args: {
				name: "package",
				filterStrategy: "fuzzy",
				generators: allDependenciesGenerator
			},
			options: [
				...commonOptions,
				{
					name: ["-h", "--help"],
					description: "Output usage information"
				},
				{
					name: "--peers",
					description: "Print the peer dependencies that match the specified name"
				},
				{
					name: ["-R", "--recursive"],
					description: "List, for each workspace, what are all the paths that lead to the dependency"
				}
			]
		},
		{
			name: "workspace",
			description: "Manage workspace",
			filterStrategy: "fuzzy",
			generateSpec: async (_tokens, executeShellCommand) => {
				const isYarnV1 = (await executeShellCommand({
					command: "yarn",
					args: ["--version"]
				})).stdout.startsWith("1.");
				const getWorkspacesDefinitionsV1 = async () => {
					const { stdout } = await executeShellCommand({
						command: "yarn",
						args: ["workspaces", "info"]
					});
					const startJson = stdout.indexOf("{");
					const endJson = stdout.lastIndexOf("}");
					return Object.entries(JSON.parse(stdout.slice(startJson, endJson + 1))).map(([name, { location }]) => ({
						name,
						location
					}));
				};
				const getWorkspacesDefinitionsVOther = async () => {
					return (await executeShellCommand({
						command: "yarn",
						args: [
							"workspaces",
							"list",
							"--json"
						]
					})).stdout.split("\n").map((line) => JSON.parse(line.trim()));
				};
				try {
					return {
						name: "workspace",
						subcommands: (isYarnV1 ? await getWorkspacesDefinitionsV1() : await getWorkspacesDefinitionsVOther()).map(({ name, location }) => ({
							name,
							description: "Workspaces",
							args: {
								name: "script",
								generators: {
									cache: {
										strategy: "stale-while-revalidate",
										ttl: 6e4
									},
									script: ["cat", `${location}/package.json`],
									postProcess: function(out) {
										if (out.trim() == "") return [];
										try {
											const scripts = JSON.parse(out)["scripts"];
											if (scripts) return Object.keys(scripts).map((script) => ({ name: script }));
										} catch (e) {}
										return [];
									}
								}
							}
						}))
					};
				} catch (e) {
					console.error(e);
				}
				return { name: "workspaces" };
			}
		},
		{
			name: "workspaces",
			description: "Show information about your workspaces",
			options: [{
				name: "subcommand",
				description: "",
				args: { suggestions: [{ name: "info" }, { name: "run" }] }
			}, {
				name: "flags",
				description: ""
			}]
		},
		{
			name: "set",
			description: "Set global Yarn options",
			subcommands: [{
				name: "resolution",
				description: "Enforce a package resolution",
				args: [{
					name: "descriptor",
					description: "A descriptor for the package, in the form of 'lodash@npm:^1.2.3'"
				}, {
					name: "resolution",
					description: "The version of the package to resolve"
				}],
				options: [{
					name: ["-s", "--save"],
					description: "Persist the resolution inside the top-level manifest"
				}]
			}, {
				name: "version",
				description: "Lock the Yarn version used by the project",
				args: {
					name: "version",
					description: "Use the specified version, which can also be a Yarn 2 build (e.g 2.0.0-rc.30) or a Yarn 1 build (e.g 1.22.1)",
					template: "filepaths",
					suggestions: [
						{
							name: "from-sources",
							insertValue: "from sources"
						},
						"latest",
						"canary",
						"classic",
						"self"
					]
				},
				options: [{
					name: "--only-if-needed",
					description: "Only lock the Yarn version if it isn't already locked"
				}]
			}]
		}
	]
};
//#endregion
export { createCLIsGenerator, completionSpec as default, dependenciesGenerator, nodeClis, yarnScriptParserDirectives };
