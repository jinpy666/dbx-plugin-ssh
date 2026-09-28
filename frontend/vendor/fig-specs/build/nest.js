//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/nest.ts
var options = [
	{
		name: ["-d", "--dry-run"],
		description: "Report actions that would be taken without writing out results"
	},
	{
		name: ["-p", "--project"],
		description: "Project in which to generate files",
		args: {
			name: "project",
			description: "Project in which to generate files"
		}
	},
	{
		name: "--flat",
		description: "Enforce flat structure of generated element"
	},
	{
		name: "--spec",
		description: "Enforce spec files generation (default: true)",
		exclusiveOn: ["--no-spec"]
	},
	{
		name: "--no-spec",
		description: "Disable spec files generation",
		exclusiveOn: ["--spec"]
	},
	{
		name: ["-c", "--collection"],
		description: "Schematics collection to use",
		args: {
			name: "collection",
			description: "The collection name"
		}
	}
];
var completionSpec = {
	name: "nest",
	description: "Nest CLI",
	subcommands: [
		{
			name: ["new", "n"],
			description: "Creates a new nest project",
			args: {
				name: "project",
				description: "The name of the project"
			}
		},
		{
			name: ["generate", "g"],
			description: "Generate and/or modifies files based on a schematic",
			subcommands: [
				{
					name: "application",
					description: "Generate a new application workspace",
					args: {
						name: "application",
						description: "The name of the application"
					},
					options
				},
				{
					name: ["class", "cl"],
					description: "Generate a new class",
					args: {
						name: "class",
						description: "The name of the class"
					},
					options
				},
				{
					name: ["configuration", "config"],
					description: "Generate a CLI configuration file",
					args: {
						name: "configuration",
						description: "The name of the configuration"
					},
					options
				},
				{
					name: ["controller", "co"],
					description: "Generate a controller declaration",
					args: {
						name: "controller",
						description: "The name of the controller"
					},
					options
				},
				{
					name: ["decorator", "d"],
					description: "Generate a custom decorator",
					args: {
						name: "decorator",
						description: "The name of the decorator"
					},
					options
				},
				{
					name: ["filter", "f"],
					description: "Generate a filter declaration",
					args: {
						name: "filter",
						description: "The name of the filter"
					},
					options
				},
				{
					name: ["gateway", "ga"],
					description: "Generate a gateway declaration",
					args: {
						name: "gateway",
						description: "The name of the gateway"
					},
					options
				},
				{
					name: ["guard", "gu"],
					description: "Generate a guard declaration",
					args: {
						name: "guard",
						description: "The name of the guard"
					},
					options
				},
				{
					name: ["interceptor", "in"],
					description: "Generate an interceptor declaration",
					args: {
						name: "interceptor",
						description: "The name of the interceptor"
					},
					options
				},
				{
					name: "interface",
					description: "Generate an interface",
					args: {
						name: "interface",
						description: "The name of the interface"
					},
					options
				},
				{
					name: ["middleware", "mi"],
					description: "Generate a middleware declaration",
					args: {
						name: "middleware",
						description: "The name of the middleware"
					},
					options
				},
				{
					name: ["module", "mo"],
					description: "Generate a module declaration",
					args: {
						name: "module",
						description: "The name of the module"
					},
					options
				},
				{
					name: ["pipe", "p"],
					description: "Generate a pipe declaration",
					args: {
						name: "pipe",
						description: "The name of the pipe"
					},
					options
				},
				{
					name: ["provider", "pr"],
					description: "Generate a provider declaration",
					args: {
						name: "provider",
						description: "The name of the provider"
					},
					options
				},
				{
					name: ["resolver", "r"],
					description: "Generate a GraphQL resolver declaration",
					args: {
						name: "resolver",
						description: "The name of the resolver"
					},
					options
				},
				{
					name: ["service", "s"],
					description: "Generate a service declaration",
					args: {
						name: "service",
						description: "The name of the service"
					},
					options
				},
				{
					name: ["library", "lib"],
					description: "Generate a new library within a monorepo",
					args: {
						name: "library",
						description: "The name of the library"
					},
					options
				},
				{
					name: ["sub-app", "app"],
					description: "Generate a new application within a monorepo",
					args: {
						name: "sub-app",
						description: "The name of the sub-app"
					},
					options
				},
				{
					name: ["resource", "res"],
					description: "Generate a new CRUD resource",
					args: {
						name: "resource",
						description: "The name of the resource"
					},
					options
				}
			]
		},
		{
			name: "build",
			description: "Builds Nest application",
			options,
			args: {
				name: "app",
				description: "The name of the app",
				isOptional: true
			}
		},
		{
			name: "start",
			description: "Run Nest application",
			options,
			args: {
				name: "app",
				description: "The name of the app",
				isOptional: true
			}
		},
		{
			name: ["info", "i"],
			description: "Display Nest project details"
		},
		{
			name: ["update", "u"],
			description: "Update Nest dependencies",
			options
		}
	],
	options: [{
		name: ["--help", "-h"],
		description: "Show help for nest"
	}]
};
//#endregion
export { completionSpec as default };
