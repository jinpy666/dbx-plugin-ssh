//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/env.ts
var completionSpec = {
	name: "env",
	description: "Set environment and execute command, or print environment",
	options: [
		{
			name: "-0",
			description: "End each output line with NUL, not newline"
		},
		{
			name: ["-i", "-"],
			description: "Start with an empty environment"
		},
		{
			name: "-v",
			description: "Print verbose logs"
		},
		{
			name: "-u",
			description: "Remove variable from the environment",
			args: {
				name: "name",
				generators: { custom: async (_tokens, _executeCommand, generatorContext) => {
					return Object.values(generatorContext.environmentVariables).map((envVar) => ({
						name: envVar,
						description: "Environment variable",
						icon: "🌎"
					}));
				} }
			}
		},
		{
			name: "-P",
			description: "Search the given directories for the utility, rather than the PATH",
			args: {
				name: "altpath",
				template: "folders"
			}
		},
		{
			name: "-S",
			description: "Split the given string into separate arguments",
			args: { name: "string" }
		}
	],
	args: [{
		name: "name=value ...",
		description: "Set environment variables",
		isOptional: true
	}, {
		name: "utility",
		description: "Utility to run",
		isOptional: true,
		isCommand: true
	}]
};
//#endregion
export { completionSpec as default };
