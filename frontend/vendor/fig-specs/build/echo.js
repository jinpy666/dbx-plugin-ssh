//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/echo.ts
var completionSpec = {
	name: "echo",
	description: "Write arguments to the standard output",
	args: {
		name: "string",
		isVariadic: true,
		optionsCanBreakVariadicArg: false,
		suggestCurrentToken: true,
		generators: {
			custom: async (tokens, _, context) => {
				if (tokens.length < 3 || tokens[tokens.length - 1].startsWith("$")) return Object.keys(context.environmentVariables).map((suggestion) => ({
					name: `$${suggestion}`,
					type: "arg",
					description: "Environment Variable"
				}));
				else return [];
			},
			trigger: "$"
		}
	},
	options: [
		{
			name: "-n",
			description: "Do not print the trailing newline character"
		},
		{
			name: "-e",
			description: "Interpret escape sequences"
		},
		{
			name: "-E",
			description: "Disable escape sequences"
		}
	]
};
//#endregion
export { completionSpec as default };
