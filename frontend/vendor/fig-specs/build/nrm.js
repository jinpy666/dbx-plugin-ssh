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
/** Generator that lists package.json dependencies */
var dependenciesGenerator = {
	trigger: (newToken) => newToken === "-g" || newToken === "--global",
	custom: async function(tokens, executeShellCommand) {
		if (!tokens.includes("-g") && !tokens.includes("--global")) {
			const { stdout: npmPrefix } = await executeShellCommand({
				command: "npm",
				args: ["prefix"]
			});
			const { stdout: out } = await executeShellCommand({
				command: "cat",
				args: [`${npmPrefix}/package.json`]
			});
			const packageContent = JSON.parse(out);
			const dependencies = packageContent["dependencies"] ?? {};
			const devDependencies = packageContent["devDependencies"];
			const optionalDependencies = packageContent["optionalDependencies"] ?? {};
			Object.assign(dependencies, devDependencies, optionalDependencies);
			return Object.keys(dependencies).filter((pkgName) => {
				return !tokens.some((current) => current === pkgName);
			}).map((pkgName) => ({
				name: pkgName,
				icon: "📦",
				description: dependencies[pkgName] ? "dependency" : optionalDependencies[pkgName] ? "optionalDependency" : "devDependency"
			}));
		} else {
			const { stdout } = await executeShellCommand({
				command: "bash",
				args: ["-c", "ls -1 `npm root -g`"]
			});
			return stdout.split("\n").map((name) => ({
				name,
				icon: "📦",
				description: "Global dependency"
			}));
		}
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
//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/nrm.ts
var completionSpec = {
	name: "nrm",
	description: "Use the right package manage - remove",
	options: [
		{
			name: "-g",
			description: "Operates in 'global' mode, so that packages are removed from the prefix folder instead of the current working directory"
		},
		{
			name: "-D",
			description: "Package will be removed from your `devDependencies`"
		},
		{
			name: "-P",
			description: "Remove package from your `peerDependencies`"
		},
		{
			name: "-O",
			description: "Remove package from your `optionalDependencies`"
		},
		{
			name: "--frozen",
			description: "Don't generate a lockfile and fail if an update is needed"
		},
		{
			name: ["-h", "--help"],
			description: "Output usage information"
		}
	],
	args: {
		name: "package",
		filterStrategy: "fuzzy",
		generators: dependenciesGenerator,
		isVariadic: true
	}
};
//#endregion
export { completionSpec as default };
