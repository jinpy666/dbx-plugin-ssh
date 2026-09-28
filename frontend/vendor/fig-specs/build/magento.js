//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/magento.ts
var getEnvConfig = async (executeShellCommand) => {
	const out = await executeShellCommand("php -r 'print(json_encode(require \"app/etc/env.php\"));'");
	return JSON.parse(out);
};
var getCacheTypes = async (executeShellCommand) => {
	const env = await getEnvConfig(executeShellCommand);
	return Object.keys(env.cache_types);
};
var completionSpec = {
	name: "magento",
	description: "Open-source E-commerce",
	generateSpec: async (tokens, executeShellCommand) => {
		const { stdout } = await executeShellCommand({
			command: "bin/magento",
			args: [
				"list",
				"--format=json",
				"--raw"
			]
		});
		const magento = JSON.parse(stdout);
		const cacheTypes = await getCacheTypes(executeShellCommand);
		return {
			name: "magento",
			description: "Open-source E-commerce",
			subcommands: magento.commands.map((command) => {
				return {
					name: command.name,
					description: command.description,
					args: Object.values(command.definition.arguments).map((argument) => {
						const suggestions = [];
						if (command.name.startsWith("cache:") && argument.name === "types") suggestions.push(...cacheTypes);
						return {
							name: argument.name,
							description: argument.description,
							isOptional: !argument.is_required,
							default: argument.default?.toString() ?? "",
							isVariadic: argument.is_array,
							suggestions
						};
					}),
					options: Object.values(command.definition.options).map((option) => {
						return {
							name: [option.name, ...option.shortcut.split("|") || []],
							description: option.description,
							isRequired: option.is_value_required,
							requiresEquals: option.accept_value
						};
					})
				};
			})
		};
	}
};
//#endregion
export { completionSpec as default };
