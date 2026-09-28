//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/php/please.ts
var completionSpec = {
	name: "please",
	description: "Statamic Please command",
	generateSpec: async (tokens, executeShellCommand) => {
		const { stdout } = await executeShellCommand({
			command: "php",
			args: [
				"please",
				"list",
				"--format=json"
			]
		});
		const subcommands = [];
		try {
			JSON.parse(stdout).commands.map((command) => {
				subcommands.push({
					name: command.name,
					description: command.description,
					args: Object.values(command.definition.arguments).map((argument) => {
						return {
							name: argument.name,
							description: argument.description,
							isOptional: !argument.is_required
						};
					}),
					options: Object.values(command.definition.options).map((option) => {
						const names = [option.name];
						if (option.shortcut !== "") names.push(option.shortcut);
						return {
							name: names,
							description: option.description
						};
					})
				});
			});
		} catch (err) {
			console.error(err);
		}
		return {
			name: "please",
			debounce: true,
			subcommands
		};
	}
};
//#endregion
export { completionSpec as default };
