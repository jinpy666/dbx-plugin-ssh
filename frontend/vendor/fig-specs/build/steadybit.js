//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/steadybit.ts
var configCommand = {
	name: "config",
	description: "Show/modify the CLI configuration and authentication profiles",
	subcommands: [{
		name: "show",
		description: "Show the active CLI configuration. Warning: Prints secrets!"
	}, {
		name: "profile",
		description: "Configure authentication profiles",
		subcommands: [
			{
				name: "add",
				description: "Interactively configure a new profile"
			},
			{
				name: ["list", "ls"],
				description: "List all configured profiles"
			},
			{
				name: "remove",
				description: "Interactively remove an existing profile"
			},
			{
				name: "select",
				description: "Interactively change the currently active profile"
			}
		]
	}]
};
var directoryOptionForTaskAndPolicyFiles = {
	name: ["-d", "--directory"],
	description: "The directory to search for task and policy files",
	args: {
		name: "directory",
		template: "folders"
	}
};
var defRepoCommand = {
	name: "def-repo",
	description: "Change versions and verify a task/policy definition repository state",
	subcommands: [{
		name: "set-version",
		description: "Set the versions in policies and task references",
		options: [{
			name: ["-v", "--version"],
			description: "Version to set",
			isRequired: true,
			args: { name: "version" }
		}, directoryOptionForTaskAndPolicyFiles]
	}, {
		name: "check",
		description: "Checks that the tasks and policies are valid",
		options: [{
			name: ["-v", "--version"],
			description: "The version to check",
			args: { name: "version" }
		}, directoryOptionForTaskAndPolicyFiles]
	}]
};
var fileOptionForServiceDefinitions = {
	name: ["-f", "--file"],
	description: "Path to the service definition file",
	args: {
		name: "file",
		template: "filepaths"
	}
};
var completionSpec = {
	name: "steadybit",
	description: "Command-line interface to interact with the Steadybit API",
	subcommands: [
		configCommand,
		defRepoCommand,
		{
			name: ["service", "service-definition"],
			description: "Configure or verify service definitions",
			subcommands: [
				{
					name: "apply",
					description: "Upload a service definition",
					options: [fileOptionForServiceDefinitions]
				},
				{
					name: "delete",
					description: "Delete a service definition",
					options: [fileOptionForServiceDefinitions, {
						name: ["-i", "--id"],
						description: "ID of the service definition to delete",
						args: { name: "id" }
					}]
				},
				{
					name: "init",
					description: "Initialize a service definition file"
				},
				{
					name: "open",
					description: "Open the service in the Steadybit UI",
					options: [fileOptionForServiceDefinitions]
				},
				{
					name: "verify",
					description: "Read the current service definition and state",
					options: [
						fileOptionForServiceDefinitions,
						{
							name: ["-pp", "--print-parameters"],
							description: "Print task parameters when listing tasks"
						},
						{
							name: ["-pm", "--print-matrix-context"],
							description: "Print the matrix execution context information when listing tasks"
						}
					]
				},
				{
					name: "show",
					description: "Show a list of tasks and policies referenced by this service",
					options: [
						fileOptionForServiceDefinitions,
						{
							name: ["-n", "--name"],
							description: "Optional task name to filter the result list",
							args: { name: "name" }
						},
						{
							name: ["-v", "--version"],
							description: "Optional task version to filter the result list",
							args: { name: "version" }
						}
					]
				}
			]
		}
	],
	options: [{
		name: ["--help", "-h"],
		description: "Display usage information"
	}]
};
//#endregion
export { completionSpec as default };
