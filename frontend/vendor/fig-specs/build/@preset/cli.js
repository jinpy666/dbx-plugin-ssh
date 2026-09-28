//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/@preset/cli.ts
var applyOptions = [
	{
		name: ["--path", "-p"],
		description: "Path to a sub-directory in which to look for a preset",
		args: { name: "path" }
	},
	{
		name: ["--tag", "-t"],
		description: "Branch or tag to use if the preset is a repository",
		args: { name: "tag" }
	},
	{
		name: "--no-ssh",
		description: "Do not use SSH when cloning repositories"
	},
	{
		name: "--no-cache",
		description: "Do not use the cached repository if it exists"
	}
];
var applyArguments = [{
	name: "resolvable",
	description: "Repository identifier or path to the preset",
	template: [
		"folders",
		"filepaths",
		"history"
	]
}, {
	name: "target-directory",
	description: "Directory in which to apply the preset",
	template: "folders",
	isOptional: true
}];
var completionSpec = {
	name: "preset",
	description: "Elegant, ecosystem-agnostic scaffolding tool",
	subcommands: [{
		name: "apply",
		description: "Apply a preset",
		options: applyOptions,
		args: applyArguments
	}, {
		name: "init",
		description: "Create a new preset",
		args: {
			name: "target-directory",
			description: "Directory in which to apply the preset",
			template: "folders",
			isOptional: true
		}
	}],
	options: [
		...applyOptions,
		{
			name: ["--help", "-h"],
			description: "Show help for preset"
		},
		{
			name: ["--version", "-v"],
			description: "Show the version number"
		},
		{
			name: "--no-interaction",
			description: "Disable interactions",
			isPersistent: true
		},
		{
			name: "--debug",
			description: "Display debug information instead of standard output",
			isPersistent: true
		},
		{
			name: "--silent",
			description: "Do not print anything",
			isPersistent: true
		}
	],
	args: applyArguments
};
//#endregion
export { completionSpec as default };
