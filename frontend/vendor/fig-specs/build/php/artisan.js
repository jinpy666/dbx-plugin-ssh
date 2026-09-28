//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/php/artisan.ts
var completionSpec = {
	name: "artisan",
	description: "Laravel Artisan Command",
	generateSpec: async (_, executeShellCommand) => {
		var { stdout } = await executeShellCommand({
			command: "php",
			args: [
				"artisan",
				"list",
				"--format=json"
			]
		});
		const subcommands = [];
		try {
			JSON.parse(stdout).commands.filter((command) => command.name !== "_complete").map((command) => {
				subcommands.push({
					name: command.name,
					description: command.description,
					icon: "https://web.tinkerwell.app/img/laravel.3cab6a56.png",
					args: Object.keys(command.definition.arguments).map((argumentKey) => {
						const argument = command.definition.arguments[argumentKey];
						return {
							name: argument.name,
							description: argument.description,
							isOptional: !argument.is_required
						};
					}),
					options: Object.keys(command.definition.options).map((optionKey) => {
						const option = command.definition.options[optionKey];
						const names = [option.name];
						if (option.shortcut !== "") names.push(option.shortcut);
						return {
							name: names,
							description: option.description
						};
					})
				});
			});
		} catch (err) {}
		return {
			name: "artisan",
			debounce: true,
			subcommands
		};
	}
};
//#endregion
export { completionSpec as default };
