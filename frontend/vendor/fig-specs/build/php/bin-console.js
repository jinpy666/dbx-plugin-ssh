//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/php/bin-console.ts
var completionSpec = {
	name: "bin-console",
	description: "Symfony bin/console command",
	generateSpec: async (_, executeShellCommand) => {
		const { stdout } = await executeShellCommand({
			command: "php",
			args: [
				"bin/console",
				"list",
				"--format=json"
			]
		});
		let subcommands = [];
		try {
			subcommands = JSON.parse(stdout).commands.map((command) => ({
				name: command.name,
				description: command.description,
				icon: "https://cdn.iconscout.com/icon/free/png-128/symfony-282493.png",
				hidden: command.hidden || false,
				args: Object.values(command.definition.arguments).map((argument) => {
					return {
						name: argument.name,
						description: argument.description,
						isOptional: !argument.is_required
					};
				}),
				options: Object.values(command.definition.options).map((option) => {
					const name = [option.name];
					if (option.shortcut !== "") name.push(option.shortcut);
					const args = [];
					if (option.accept_value) args.push({
						name: "arg",
						isVariadic: option.is_multiple,
						isOptional: !option.is_value_required
					});
					return {
						name,
						args,
						description: option.description
					};
				})
			}));
		} catch (err) {
			console.error(err);
		}
		return {
			name: "bin-console",
			subcommands
		};
	}
};
//#endregion
export { completionSpec as default };
