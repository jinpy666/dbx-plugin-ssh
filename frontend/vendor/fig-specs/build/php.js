//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/php.ts
var fileExists = async (executeCommand, file) => {
	return (await executeCommand({
		command: "ls",
		args: [file]
	})).status === 0;
};
var completionSpec = {
	name: "php",
	description: "Run the PHP interpreter",
	generateSpec: async (tokens, executeShellCommand) => {
		const subcommands = [];
		await Promise.all([
			(async () => {
				if (await fileExists(executeShellCommand, "artisan")) subcommands.push({
					name: "artisan",
					loadSpec: "php/artisan"
				});
			})(),
			(async () => {
				if (await fileExists(executeShellCommand, "please")) subcommands.push({
					name: "please",
					loadSpec: "php/please"
				});
			})(),
			(async () => {
				if (await fileExists(executeShellCommand, "bin/console")) subcommands.push({
					name: "bin/console",
					loadSpec: "php/bin-console"
				});
			})()
		]);
		return {
			name: "php",
			subcommands,
			args: { generators: {
				template: "filepaths",
				filterTemplateSuggestions: function(suggestions) {
					return suggestions.filter((suggestion) => {
						return suggestion.name.indexOf(".") === -1;
					});
				}
			} }
		};
	}
};
//#endregion
export { completionSpec as default };
