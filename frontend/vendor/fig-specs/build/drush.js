//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/drush.ts
var completionSpec = {
	name: "drush",
	description: "Drush is a command line shell and Unix scripting interface for Drupal",
	generateSpec: async (tokens, executeShellCommand) => {
		const { stdout: jsonList } = await executeShellCommand({
			command: "drush",
			args: ["--format=json"]
		});
		const subcommands = [];
		try {
			const data = JSON.parse(jsonList);
			for (const command of data.commands) subcommands.push({
				name: command.name,
				description: command.description,
				args: Object.keys(command.definition.arguments).map((argKey) => {
					const arg = command.definition.arguments[argKey];
					const argDefault = arg.default ? Array.isArray(arg.default) ? arg.default[0] : arg.default : void 0;
					return {
						name: arg.name,
						description: arg.description,
						isOptional: !arg.is_required,
						default: argDefault,
						isVariadic: arg.is_array
					};
				}),
				options: Object.keys(command.definition.options).map((optionKey) => {
					const option = command.definition.options[optionKey];
					const names = [option.name];
					const shortCut = option.shortcut;
					if (shortCut.trim().length > 0) names.push(shortCut);
					return {
						name: names,
						description: option.description,
						isRequired: option.is_value_required,
						args: option.accept_value ? {} : void 0,
						isRepeatable: option.is_multiple
					};
				})
			});
		} catch (err) {
			console.error(err);
		}
		return {
			name: "drush",
			subcommands
		};
	}
};
//#endregion
export { completionSpec as default };
