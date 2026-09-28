//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/projj.ts
var repoGenerator = { custom: async (_, executeCommand, context) => {
	const { stdout } = await executeCommand({
		command: "cat",
		args: [`${context.environmentVariables["HOME"]}/.projj/cache.json`]
	});
	const cache = JSON.parse(stdout);
	return Object.keys(cache).map((key) => ({
		name: key.split("/").pop(),
		description: cache[key].repo
	}));
} };
var hookGenerator = { custom: async (_, executeCommand, context) => {
	const { stdout } = await executeCommand({
		command: "cat",
		args: [`${context.environmentVariables["HOME"]}/.projj/config.json`]
	});
	const hooks = JSON.parse(stdout).hooks;
	return Object.keys(hooks).map((key) => ({
		name: key,
		description: hooks[key]
	}));
} };
var completionSpec = {
	name: "projj",
	description: "Manage repository easily",
	subcommands: [
		{
			name: "completion",
			description: "Generate completion script"
		},
		{
			name: "add",
			description: "Add repository",
			args: { name: "repository url" }
		},
		{
			name: "find",
			description: "Find repository",
			args: {
				name: "repository name",
				generators: repoGenerator
			}
		},
		{
			name: "import",
			description: "Import repositories from existing directory",
			args: {
				name: "directory",
				template: "folders"
			}
		},
		{
			name: "init",
			description: "Initialize configuration"
		},
		{
			name: "remove",
			description: "Remove repository",
			args: {
				name: "repository name",
				generators: repoGenerator
			}
		},
		{
			name: "run",
			description: "Run hook in current directory",
			args: {
				name: "hook name",
				generators: hookGenerator
			}
		},
		{
			name: "runall",
			description: "Run hook in every repository",
			args: {
				name: "hook name",
				generators: hookGenerator
			}
		},
		{
			name: "sync",
			description: "Sync data from directory",
			args: {
				name: "directory",
				template: "folders"
			}
		}
	],
	options: [{
		name: ["--help", "-h"],
		description: "Show help for projj"
	}, {
		name: ["--version", "-v"],
		description: "Show version number"
	}]
};
//#endregion
export { completionSpec as default };
