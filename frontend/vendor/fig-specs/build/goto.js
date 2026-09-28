//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/goto.ts
var listTargets = { custom: async (tokens, executeShellCommand, context) => {
	const { stdout } = await executeShellCommand({
		command: "cat",
		args: [`${context.environmentVariables["HOME"]}/.config/goto`]
	});
	const targetSuggestions = /* @__PURE__ */ new Map();
	for (const target of stdout.split("\n")) {
		const splits = target.split(" ");
		targetSuggestions.set(target, {
			name: splits[0],
			description: "Goto " + splits[1],
			icon: "🔖",
			priority: 80
		});
	}
	return [...targetSuggestions.values()];
} };
var completionSpec = {
	name: "goto",
	displayName: "Goto a Folder by alias",
	options: [
		{
			name: ["--help", "-h"],
			description: "Show help for goto"
		},
		{
			name: ["--register", "-r"],
			description: "Registers an alias",
			isPersistent: true,
			args: [{ name: "alias" }, {
				name: "target",
				template: "folders"
			}]
		},
		{
			name: ["--unregister", "-u"],
			description: "Unregister an alias",
			isPersistent: true,
			args: {
				name: "alias",
				isDangerous: true,
				generators: listTargets,
				filterStrategy: "prefix"
			}
		},
		{
			name: ["--push", "-p"],
			description: "Pushes the current directory onto the stack, then performs goto"
		},
		{
			name: ["--pop", "-o"],
			description: "Pops the top directory from the stack, then changes to that directory"
		},
		{
			name: ["--list", "-l"],
			description: "Pops the top directory from the stack, then changes to that directory"
		},
		{
			name: ["--expand", "-x"],
			description: "Expands an alias",
			args: {
				name: "alias",
				generators: listTargets
			}
		},
		{
			name: ["--cleanup", "-c"],
			description: "Cleans up non existent directory aliases"
		},
		{
			name: ["--version", "-v"],
			description: "Displays the version of the goto script"
		}
	],
	args: {
		name: "alias",
		generators: listTargets
	}
};
//#endregion
export { completionSpec as default };
