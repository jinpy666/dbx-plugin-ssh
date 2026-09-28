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
//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/nr.ts
var completionSpec = {
	name: "nr",
	description: "Use the right package manager - run",
	options: [{
		name: ["-h", "--help"],
		description: "Output usage information"
	}],
	args: {
		name: "script",
		description: "The script to run",
		filterStrategy: "fuzzy",
		generators: npmScriptsGenerator
	},
	additionalSuggestions: [{
		name: "-",
		insertValue: "-\n",
		description: "Run the last command",
		type: "shortcut"
	}]
};
//#endregion
export { completionSpec as default };
