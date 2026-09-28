//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/twiggy.ts
var completionSpec = {
	name: "twiggy",
	description: "A code-size profiler for WebAssembly",
	icon: "🌱",
	subcommands: [
		{
			name: "diff",
			description: "Diff the old and new versions of a binary to see what sizes changed"
		},
		{
			name: "dominators",
			icon: "🌲",
			description: "Compute and display the dominator tree for a binary's call graph"
		},
		{
			name: "garbage",
			icon: "🗑️",
			description: "Find and display code and data that is not transitively referenced by any exports or public functions"
		},
		{
			name: "help",
			description: "Prints this message or the help of the given subcommand(s)",
			args: {
				name: "subcommand",
				template: "help"
			}
		},
		{
			name: "monos",
			icon: "📈",
			description: "List the generic function monomorphizations that are contributing to code bloat"
		},
		{
			name: "paths",
			icon: "📁",
			description: "Find and display the call paths to a function in the given binary's call graph"
		},
		{
			name: "top",
			icon: "📈",
			description: "List the top code size offenders in a binary"
		}
	],
	options: [{
		name: ["--help", "-h"],
		description: "Prints help information"
	}, {
		name: ["--version", "-v"],
		description: "Prints version information"
	}]
};
//#endregion
export { completionSpec as default };
