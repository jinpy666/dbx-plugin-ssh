//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/fnm.ts
var versionGenerator = {
	script: ["fnm", "list"],
	postProcess: function(out) {
		return out.split("\n").reverse().map((line) => ({
			name: line.slice(2).split(" ")[0],
			displayName: line.slice(2),
			description: `Node.js ${line.slice(2)}`
		}));
	}
};
var NODE_VERSION_REGEX = /v(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?: \((?<ltsName>\w+)\))?/iu;
var parseNodejsVersion = (raw) => {
	const { major, minor, patch, ltsName } = NODE_VERSION_REGEX.exec(raw)?.groups ?? {};
	return {
		major: Number(major),
		minor: Number(minor),
		patch: Number(patch),
		original: raw,
		ltsName
	};
};
var uniqBy = (arr, callback) => arr.reduce((acc, v) => {
	if (!acc.some((x) => callback(v, x))) acc.push(v);
	return acc;
}, []);
/**
* This generator will output the following Node.js' versions:
* - Every version of the latest LTS;
* - Latest release of all named LTS;
* - Latest release of the beta right before the last LTS, or the
*   beta right after it if it exists;
* - Every other version, sorted;
*/
var remoteVersionGenerator = {
	script: ["fnm", "list-remote"],
	postProcess: function(out) {
		const parsed = out.split("\n").reverse().filter(Boolean).map(parseNodejsVersion);
		const lastLtsMajor = parsed.find((version) => version.major % 2 === 0).major;
		const latests = /* @__PURE__ */ new Map();
		return uniqBy([...parsed.map((version) => {
			const latestRelease = latests.get(version.major);
			if (!latestRelease || latestRelease.minor < version.minor) latests.set(version.major, version);
			return version;
		}).filter((version) => {
			if (version.major === lastLtsMajor) return true;
			const isLatestRelease = version.original === latests.get(version.major).original;
			if (version.major % 2 === 0) return isLatestRelease;
			return (version.major === lastLtsMajor - 1 || version.major === lastLtsMajor + 1) && isLatestRelease;
		}), ...parsed], (a, b) => a.original === b.original).map((version) => version.ltsName && latests.get(version.major).original === version.original ? {
			name: `lts/${version.ltsName}`,
			displayName: version.original,
			description: `Node.js ${version.original}`
		} : {
			name: version.original.split(" ").shift(),
			description: `Node.js ${version.original}`
		});
	},
	cache: { ttl: 86400 }
};
var version = {
	name: "version",
	description: "A version string. Can be a partial semver or a LTS version name by the format lts/NAME",
	isOptional: true
};
var command = {
	name: "command",
	isCommand: true,
	isVariadic: true
};
var lts = {
	name: "--lts",
	description: "Install latest LTS"
};
var installIfMissing = {
	name: "--install-if-missing",
	description: "Install the version if it isn't installed yet"
};
var shell = {
	name: "shell",
	description: "The shell syntax to use. Infers when missing",
	args: {
		name: "shell",
		suggestions: [
			"zsh",
			"bash",
			"fish",
			"powershell",
			"elvish"
		]
	}
};
var baseOptions = [
	{
		name: ["--help", "-h"],
		description: "Prints help information"
	},
	{
		name: ["--version", "-V"],
		description: "Prints version information"
	},
	{
		name: "--arch",
		description: "Override the architecture of the installed Node binary. Defaults to arch of fnm binary",
		args: {
			name: "arch",
			default: "x64",
			suggestions: [
				"x86",
				"x64",
				"arm64",
				"armv7l",
				"ppc64le",
				"ppc64",
				"s390x"
			]
		}
	},
	{
		name: "--fnm-dir",
		description: "The root directory of fnm installations",
		args: {
			name: "dir",
			template: "folders"
		}
	},
	{
		name: "--log-level",
		description: "The log level of fnm commands",
		args: {
			name: "logLevel",
			default: "info",
			suggestions: [
				"quiet",
				"info",
				"error"
			]
		}
	},
	{
		name: "--node-dist-mirror",
		description: "Mirror of https://nodejs.org/dist",
		args: {
			name: "nodeDistMirror",
			default: "https://nodejs.org/dist"
		}
	},
	{
		name: "--version-file-strategy",
		description: "Strategy for how to resolve the Node version",
		args: {
			name: "strategy",
			default: "local",
			suggestions: ["local", "recursive"]
		}
	}
];
var completionSpec = {
	name: "fnm",
	description: "Fast Node Manager",
	options: baseOptions,
	subcommands: [
		{
			name: "install",
			description: "Install a new Node.js version",
			args: {
				...version,
				generators: remoteVersionGenerator
			},
			options: [lts, ...baseOptions],
			priority: 61
		},
		{
			name: "uninstall",
			description: "Uninstall a Node.js version",
			args: {
				...version,
				generators: versionGenerator
			},
			options: [lts, ...baseOptions]
		},
		{
			name: "use",
			description: "Change Node.js version",
			args: {
				...version,
				generators: versionGenerator
			},
			options: [
				installIfMissing,
				lts,
				...baseOptions
			],
			priority: 62
		},
		{
			name: "exec",
			description: "Run a command within fnm context",
			args: command,
			options: [
				{
					name: "--using",
					description: "Either an explicit version, or a filename with the version written in it",
					args: { ...version }
				},
				lts,
				...baseOptions
			]
		},
		{
			name: "current",
			description: "Print the current Node.js version",
			options: baseOptions,
			priority: 60
		},
		{
			name: ["list", "ls"],
			description: "List all locally installed Node.js versions",
			options: baseOptions
		},
		{
			name: ["list-remote", "ls-remote"],
			description: "List all remote Node.js versions",
			options: baseOptions
		},
		{
			name: "alias",
			description: "Alias a version to a common name",
			args: [{
				...version,
				generators: versionGenerator
			}, {
				name: "name",
				description: "Alias name"
			}],
			options: baseOptions
		},
		{
			name: "unalias",
			description: "Deletes the alias named <name>",
			args: {
				name: "requested-alias",
				description: "Alias name"
			},
			options: baseOptions
		},
		{
			name: "completions",
			description: "Print shell completions to stdout",
			options: [shell, ...baseOptions]
		},
		{
			name: "default",
			description: "Set a version as the default version. This is a shorthand for 'fnm alias VERSION default'",
			args: {
				...version,
				generators: versionGenerator
			},
			options: baseOptions
		},
		{
			name: "env",
			description: "Print and set up required environment variables for fnm",
			options: [
				{
					name: "--use-on-cd",
					description: "Print the script to change Node versions every directory change"
				},
				shell,
				...baseOptions
			]
		},
		{
			name: "help",
			description: "Prints the help page or the help of the given subcommand(s)",
			args: {
				name: "command",
				isOptional: true,
				template: "help"
			},
			options: baseOptions
		}
	]
};
//#endregion
export { completionSpec as default };
