//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/wd.ts
var warpPointsGenerator = { custom: async (_, executeCommand, context) => {
	const { stdout } = await executeCommand({
		command: "cat",
		args: [`${context.environmentVariables["HOME"]}/.warprc`]
	});
	const iter = stdout.matchAll(/^(\w+)/gm);
	const suggestions = [];
	for (const [point] of iter) suggestions.push({
		name: point,
		description: "Warp point",
		icon: "🔘",
		priority: 76
	});
	return suggestions;
} };
var completionSpec = {
	name: "wd",
	description: "Warp to directories without using cd",
	args: [{
		name: "point",
		description: "Warp point to the specified directory",
		generators: warpPointsGenerator
	}, {
		name: "path",
		description: "Appended path",
		isOptional: true
	}],
	subcommands: [
		{
			name: "add",
			description: "Adds the current working directory to your warp points",
			args: {
				name: "point",
				description: "Name of the warp point to be created",
				isOptional: true
			}
		},
		{
			name: "rm",
			description: "Removes the given warp point",
			args: {
				name: "point",
				description: "Name of the warp point to be removed",
				isOptional: true,
				generators: warpPointsGenerator
			}
		},
		{
			name: "show",
			description: "Print path to given warp point",
			args: {
				name: "point",
				description: "Name of the warp point",
				isOptional: true,
				generators: warpPointsGenerator
			}
		},
		{
			name: "list",
			description: "Print all stored warp points"
		},
		{
			name: "ls",
			description: "Show files from given warp point (ls)",
			args: {
				name: "point",
				description: "Name of the warp point",
				generators: warpPointsGenerator
			}
		},
		{
			name: "path",
			description: "Show the path to given warp point (pwd)",
			args: {
				name: "point",
				description: "Name of the warp point",
				generators: warpPointsGenerator
			}
		},
		{
			name: "clean",
			description: "Remove points warping to nonexistent directories (will prompt unless --force is used)"
		},
		{
			name: "help",
			description: "Shows help for wd"
		}
	],
	options: [
		{
			name: ["-v", "--version"],
			description: "Print version"
		},
		{
			name: ["-d", "--debug"],
			description: "Exit after execution with exit codes (for testing)"
		},
		{
			name: ["-c", "--config"],
			description: "Specify config file (default ~/.warprc)",
			args: { name: "file" }
		},
		{
			name: ["-q", "--quiet"],
			description: "Suppress all output"
		},
		{
			name: ["-f", "--force"],
			description: "Allows overwriting without warning (for add & clean)"
		}
	]
};
//#endregion
export { completionSpec as default };
