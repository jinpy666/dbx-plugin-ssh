//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/az/2.53.0/cli-translator.ts
var completion = {
	name: "cli-translator",
	description: "Translate ARM template or REST API to CLI scripts",
	subcommands: [{
		name: "arm",
		description: "Translate ARM template to CLI scripts(Currently only support Compute, Network and Storage)",
		subcommands: [{
			name: "translate",
			description: "Translate ARM template to CLI scripts(Currently only support Compute, Network and Storage)",
			options: [
				{
					name: "--parameters",
					description: "The local path or url of parameters.json file",
					args: { name: "parameters" },
					isRequired: true
				},
				{
					name: ["--resource-group", "-g"],
					description: "Name of resource group. You can configure the default group using az configure --defaults group=<name>",
					args: { name: "resource-group" },
					isRequired: true
				},
				{
					name: "--template",
					description: "The local path or url of template.json file",
					args: { name: "template" },
					isRequired: true
				},
				{
					name: "--target-subscription",
					description: "The target subscription id. If omit, the current subscription id will be used",
					args: { name: "target-subscription" }
				}
			]
		}]
	}]
};
//#endregion
export { completion as default };
