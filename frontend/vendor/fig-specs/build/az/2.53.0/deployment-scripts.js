//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/az/2.53.0/deployment-scripts.ts
var completion = {
	name: "deployment-scripts",
	description: "Manage deployment scripts at subscription or resource group scope",
	subcommands: [
		{
			name: "delete",
			description: "Delete a deployment script",
			options: [
				{
					name: "--name",
					description: "Deployment script resource name",
					args: { name: "name" },
					isRequired: true
				},
				{
					name: ["--resource-group", "-g"],
					description: "Name of resource group. You can configure the default group using az configure --defaults group=<name>",
					args: { name: "resource-group" },
					isRequired: true
				},
				{
					name: ["--yes", "-y"],
					description: "Do not prompt for confirmation"
				}
			]
		},
		{
			name: "list",
			description: "List all deployment scripts",
			options: [{
				name: ["--resource-group", "-g"],
				description: "Name of resource group. You can configure the default group using az configure --defaults group=<name>",
				args: { name: "resource-group" }
			}]
		},
		{
			name: "show",
			description: "Retrieve a deployment script",
			options: [{
				name: "--name",
				description: "Deployment script resource name",
				args: { name: "name" },
				isRequired: true
			}, {
				name: ["--resource-group", "-g"],
				description: "Name of resource group. You can configure the default group using az configure --defaults group=<name>",
				args: { name: "resource-group" },
				isRequired: true
			}]
		},
		{
			name: "show-log",
			description: "Show deployment script logs",
			options: [{
				name: "--name",
				description: "Deployment script resource name",
				args: { name: "name" },
				isRequired: true
			}, {
				name: ["--resource-group", "-g"],
				description: "Name of resource group. You can configure the default group using az configure --defaults group=<name>",
				args: { name: "resource-group" },
				isRequired: true
			}]
		}
	]
};
//#endregion
export { completion as default };
