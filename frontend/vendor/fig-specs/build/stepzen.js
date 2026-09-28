//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/stepzen.ts
var completionSpec = {
	name: "StepZen",
	description: "The StepZen CLI is the primary way to build, deploy and test your schemas on StepZen",
	subcommands: [
		{
			name: "help",
			description: "Display help for StepZen",
			args: {
				name: "command",
				description: "Command name for which to display help"
			}
		},
		{
			name: "login",
			description: "Login to StepZen"
		},
		{
			name: "logout",
			description: "Logout of StepZen"
		},
		{
			name: "start",
			description: "Deploy, watch and develop your API",
			options: [
				{
					name: "--dir",
					description: "The working directory for StepZen assets",
					requiresSeparator: true,
					args: {
						name: "path",
						description: "Path to StepZen directory",
						template: "folders"
					}
				},
				{
					name: "--endpoint",
					description: "The folder/endpoint to deploy to",
					requiresSeparator: true,
					args: {
						name: "endpoint",
						description: "The StepZen endpoint",
						generators: {
							script: [
								"stepzen",
								"list",
								"schemas"
							],
							postProcess: (output) => {
								try {
									return JSON.parse(output).map((endpoint) => {
										return {
											name: endpoint,
											description: "StepZen endpoint"
										};
									});
								} catch (e) {
									return [];
								}
							}
						}
					}
				},
				{
					name: "--port",
					description: "The port number to use for the GraphiQL explorer",
					requiresSeparator: true,
					args: {
						name: "port",
						description: "A port to run on"
					}
				}
			]
		},
		{
			name: "import",
			description: "Import pre-configured schemas to Your API",
			args: {
				name: "name",
				description: "The name of the generator to import",
				generators: {
					script: ["curl", "https://api.github.com/repos/steprz/stepzen-schemas/contents"],
					postProcess: (output) => {
						try {
							return JSON.parse(output).filter((repo) => {
								return repo.type == "dir" && !repo.name.startsWith(".");
							}).map((repo) => {
								return {
									name: repo.name,
									description: "Stepzen schema",
									icon: "📦"
								};
							});
						} catch (e) {
							return [];
						}
					}
				}
			},
			options: [{
				name: "--dir",
				description: "The directory to which the schema will be imported",
				requiresSeparator: true,
				args: {
					name: "path",
					description: "Path to directory",
					template: "folders"
				}
			}]
		},
		{
			name: "list",
			description: "List the assets of a specified type that are linked to the StepZen account",
			args: {
				name: "type",
				description: "The type of asset to list (schemas or configurationsets)",
				suggestions: ["schemas", "configurationsets"]
			}
		}
	]
};
//#endregion
export { completionSpec as default };
