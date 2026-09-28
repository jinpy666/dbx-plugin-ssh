//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/prisma.ts
var commonOptions$1 = {
	name: ["-h", "--help"],
	description: "Display this help message"
};
var schemaOptions = {
	name: "--schema",
	description: "Custom path to your Prisma schema",
	args: {
		name: "Schema path",
		template: "filepaths"
	}
};
var skipOptions = [{
	name: "--skip-seed",
	description: "Skip triggering seed"
}, {
	name: "--skip-generate",
	description: "Skip triggering generators (e.g. Prisma Client)"
}];
//#endregion
//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/blitz.ts
var prismaCommands = {
	name: "prisma",
	description: "Prisma is a modern DB toolkit to query, migrate and model your database",
	icon: "https://raw.githubusercontent.com/prisma/docs/main/src/images/favicon-16x16.png",
	subcommands: [
		{
			name: "init",
			description: "Setup Prisma for your app",
			options: [
				commonOptions$1,
				{
					name: "--datasource-provider",
					description: "Define the datasource provider to use",
					args: {
						description: "Choose provider",
						suggestions: [
							"PostgreSQL",
							"MySQL",
							"SQLite",
							"SQLServer",
							"MongoDB",
							"CockroachDB"
						],
						default: "PostgreSQL"
					}
				},
				{
					name: "--url",
					description: "Define a custom datasource url",
					args: {
						name: "full url",
						template: "filepaths"
					}
				}
			]
		},
		{
			name: "generate",
			description: "Generate artifacts (e.g. Prisma Client)",
			options: [
				commonOptions$1,
				schemaOptions,
				{
					name: "--data-proxy",
					description: "Enable the Data Proxy in the Prisma Client"
				},
				{
					name: "--no-hints",
					description: "Hides the hint messages but still outputs errors and warnings"
				},
				{
					name: "--no-engine",
					description: "Generate a client for use with Accelerate only"
				},
				{
					name: "--watch",
					description: "Watch the Prisma schema and rerun after a change"
				},
				{
					name: "--allow-no-models",
					description: "Allow generating a client without models"
				}
			]
		},
		{
			name: "studio",
			description: "Open Prisma Studio",
			options: [
				commonOptions$1,
				schemaOptions,
				{
					name: ["-p", "--port"],
					description: "Port to start Studio on",
					args: { name: "port" }
				},
				{
					name: ["-b", "--browser"],
					description: "Browser to open Studio in",
					args: {
						name: "Browser choice",
						suggestions: [
							"firefox",
							"chrome",
							"safari",
							"none"
						]
					}
				},
				{
					name: ["-n", "--hostname"],
					description: "Hostname to bind the Express server to",
					args: { name: "port" }
				}
			]
		},
		{
			name: "format",
			description: "Format your schema",
			options: [commonOptions$1, schemaOptions]
		},
		{
			name: "migrate",
			description: "Migrate your database",
			subcommands: [
				{
					name: "dev",
					icon: "💻",
					description: "The migrate dev command updates your database using migrations files during development",
					options: [
						commonOptions$1,
						schemaOptions,
						...skipOptions,
						{
							name: "--create-only",
							description: "Create a new migration but do not apply it. The migration will be empty if there are no changes in Prisma schema"
						},
						{
							name: ["-n", "--name"],
							description: "The name of the migration. If no name is provided, the CLI will prompt you",
							args: {
								name: "filename",
								isOptional: true
							}
						}
					]
				},
				{
					name: "reset",
					icon: "🔃",
					description: "Reset your database and apply all migrations, all data will be lost",
					options: [
						commonOptions$1,
						schemaOptions,
						...skipOptions,
						{
							name: ["-f", "--force"],
							description: "Skip the confirmation prompt",
							isDangerous: true
						}
					]
				},
				{
					name: "deploy",
					icon: "🚀",
					description: "Apply pending migrations to update the database schema in production/staging",
					options: [commonOptions$1, schemaOptions]
				},
				{
					name: "resolve",
					description: "Resolve issues with database migrations in deployment databases",
					options: [
						commonOptions$1,
						schemaOptions,
						{
							name: "--applied",
							description: "Record a specific migration as applied",
							args: {
								name: "migration file path",
								template: "filepaths"
							}
						},
						{
							name: "--rolled-back",
							description: "Record a specific migration as rolled back",
							args: {
								name: "migration file path",
								template: "filepaths"
							}
						}
					]
				},
				{
					name: "status",
					description: "Check the status of your database migrations",
					options: [commonOptions$1, schemaOptions]
				},
				{
					name: "diff",
					description: "Compares the database schema from two arbitrary sources, and outputs the differences either as a human-readable summary (by default) or an executable script",
					options: [
						commonOptions$1,
						{
							name: "--from-url",
							description: "A datasource url",
							args: {
								name: "full url",
								template: "filepaths"
							}
						},
						{
							name: "--to-url",
							description: "A datasource url",
							args: {
								name: "full url",
								template: "filepaths"
							}
						},
						{
							name: "--from-empty",
							description: "Flag to assume from is an empty datamodel"
						},
						{
							name: "--to-empty",
							description: "Flag to assume to is an empty datamodel"
						},
						{
							name: "--from-schema-datamodel",
							description: "Path to a Prisma schema file, uses the 'datamodel' for the diff",
							args: {
								name: "filepath",
								template: "filepaths"
							}
						},
						{
							name: "--to-schema-datamodel",
							description: "Path to a Prisma schema file, uses the 'datamodel' for the diff",
							args: {
								name: "filepath",
								template: "filepaths"
							}
						},
						{
							name: "--from-schema-datasource",
							description: "Path to a Prisma schema file, uses the 'datasource url' for the diff",
							args: {
								name: "filepath",
								template: "filepaths"
							}
						},
						{
							name: "--to-schema-datasource",
							description: "Path to a Prisma schema file, uses the 'datasource url' for the diff",
							args: {
								name: "filepath",
								template: "filepaths"
							}
						},
						{
							name: "--from-migrations",
							description: "Path to the Prisma Migrate migrations directory",
							args: {
								name: "folder",
								template: "folders"
							}
						},
						{
							name: "--to-migrations",
							description: "Path to the Prisma Migrate migrations directory",
							args: {
								name: "folder",
								template: "folders"
							}
						},
						{
							name: "--shadow-database-url",
							description: "URL for the shadow database. Only required if using --from-migrations or --to-migrations",
							args: {
								name: "full url",
								template: "filepaths"
							}
						},
						{
							name: "--script",
							description: "Render a SQL script to stdout instead of the default human readable summary (not supported on MongoDB)",
							args: {
								name: "filepath",
								template: "filepaths"
							}
						},
						{
							name: "--exit-code",
							description: "Change the exit code behavior to signal if the diff is empty or not (Empty: 0, Error: 1, Not empty: 2). Default behavior is Success: 0, Error: 1.`"
						}
					]
				}
			]
		},
		{
			name: "db",
			description: "Manage your database schema and lifecycle (Preview)",
			subcommands: [
				{
					name: "pull",
					options: [
						commonOptions$1,
						schemaOptions,
						{
							name: "--force",
							description: "Ignore current Prisma schema file",
							isDangerous: true
						},
						{
							name: "--print",
							description: "Print the introspected Prisma schema to stdout"
						},
						{
							name: "--url",
							description: "The datasource url",
							args: {
								name: "full url",
								template: "filepaths"
							}
						},
						{
							name: "--composite-type-depth",
							description: "Specify the depth for introspecting composite types (e.g. Embedded Documents in MongoDB). Number, default is -1 for infinite depth, 0 = off",
							args: { name: "number" }
						}
					]
				},
				{
					name: "push",
					description: "This command pushes the state of your Prisma schema file to the database without using migrations files",
					options: [
						commonOptions$1,
						schemaOptions,
						{
							name: "--skip-generate",
							description: "Skip generation of artifacts such as Prisma Client"
						},
						{
							name: "--force-reset",
							description: "Resets the database and then updates the schema - useful if you need to start from scratch due to unexecutable migrations",
							isDangerous: true
						},
						{
							name: "--accept-data-loss",
							description: "Ignore data loss warnings. This option is required if as a result of making the schema changes, data may be lost",
							isDangerous: true
						}
					]
				},
				{
					name: "seed",
					isDangerous: true,
					description: "Seed your database",
					options: [commonOptions$1, schemaOptions]
				},
				{
					name: "execute",
					isDangerous: true,
					description: "Execute native commands to your database",
					options: [
						commonOptions$1,
						schemaOptions,
						{
							name: "--url",
							description: "The datasource url",
							args: {
								name: "full url",
								template: "filepaths"
							}
						},
						{
							name: "--file",
							description: "Path to a file. The content will be sent as the script to be executed",
							args: {
								name: "filepath",
								template: "filepaths"
							}
						},
						{
							name: "--stdin",
							description: "Use the terminal standard input as the script to be executed"
						}
					]
				}
			]
		},
		{
			name: ["version", "-v"],
			description: "Print current version of Prisma components",
			subcommands: [{
				name: "--json",
				description: "Output JSON"
			}]
		}
	]
}.subcommands;
var commonOptions = [{
	name: ["--help", "-h"],
	description: "Show help for command",
	priority: 1
}];
var icon = "https://raw.githubusercontent.com/blitz-js/art/master/square-logo-600.png";
var completionSpec = {
	name: "blitz",
	description: "Blitz.js CLI is your single access point for interacting with your app, from database management to code generation",
	subcommands: [
		{
			name: ["build", "b"],
			description: "Creates a production build",
			icon,
			options: commonOptions
		},
		{
			name: ["codegen", "cg"],
			description: "Generates Routes Manifest",
			icon,
			options: commonOptions
		},
		{
			name: ["console", "c"],
			description: "Run the Blitz console REPL",
			icon,
			options: commonOptions
		},
		{
			name: "db",
			description: "Run database commands",
			icon,
			options: commonOptions,
			args: {
				name: "command",
				description: "Run specific db command",
				suggestions: [{
					name: "seed",
					description: "Generates seeded data in database via Prisma 2. You need db/seeds.ts or db/seeds/index.ts"
				}]
			}
		},
		{
			name: ["dev", "d"],
			description: "Start a development server",
			icon,
			options: [
				...commonOptions,
				{
					name: ["-p", "--port"],
					description: "Set port number",
					args: { name: "port" }
				},
				{
					name: ["-H", "--hostname"],
					description: "Set server hostname",
					args: { name: "hostname" }
				},
				{
					name: "--inspect",
					description: "Enable the Node.js inspector"
				},
				{
					name: "--no-incremental-build",
					description: "Disable incremental build and start from a fresh cache"
				}
			]
		},
		{
			name: ["export", "e"],
			description: "Exports a static page",
			icon,
			options: [...commonOptions, {
				name: ["-o", "--outdir"],
				description: "Set the output dir (defaults to 'out')",
				args: { name: "outdir" }
			}]
		},
		{
			name: ["generate", "g"],
			description: "Generate new files for your Blitz project",
			isDangerous: true,
			icon,
			options: [
				...commonOptions,
				{
					name: ["-c", "--context"],
					description: "Provide a context folder within which we'll place the generated files for better code organization. You can also supply this in the name of the model to be generated (e.g. `blitz generate query admin/projects`). Combining the `--context` flags and supplying context via the model name in the same command is not supported",
					args: { name: "context" }
				},
				{
					name: ["-p", "--parent"],
					description: "Specify a parent model to be used for generating nested routes for dependent data when generating pages, or to create hierarchical validation in queries and mutations. The code will be generated with the nested data model in mind. Most often this should be used in conjunction with 'blitz generate all'",
					args: { name: "parent" }
				},
				{
					name: ["-d", "--dry-run"],
					description: "Show what files will be created without writing them to disk"
				}
			],
			args: [{
				name: "type",
				description: "What files to generate",
				suggestions: [
					"all",
					"crud",
					"model",
					"pages",
					"queries",
					"query",
					"mutations",
					"mutation",
					"resource"
				].map((suggestion) => ({
					name: suggestion,
					insertValue: `${suggestion} `,
					priority: 100
				}))
			}, {
				name: "model",
				description: "The name of your model, like \"user\". Can be singular or plural - same result"
			}]
		},
		{
			name: ["help", "h"],
			description: "Display help for <%= config.bin %>",
			options: [{
				name: "--all",
				description: "See all commands in CLI"
			}],
			args: {
				name: "command",
				description: "Command to show help for",
				isOptional: true
			}
		},
		{
			name: ["install", "i"],
			description: "Install a Recipe into your Blitz app",
			icon,
			options: commonOptions,
			args: [{
				name: "recipe",
				description: "Name of a Blitz recipe from @blitzjs/blitz/recipes, or a file path to a local recipe definition"
			}, {
				name: "recipe-flags",
				description: "A list of flags to pass to the recipe. Blitz will only parse these in the form key=value",
				isOptional: true
			}]
		},
		{
			name: "new",
			description: "Create a new Blitz project",
			icon,
			options: [
				...commonOptions,
				{
					name: "--npm",
					description: "Use npm as the package manager"
				},
				{
					name: "--yarn",
					description: "Use yarn as the package manager"
				},
				{
					name: "--form",
					description: "A form library",
					args: {
						name: "form",
						suggestions: [
							"react-final-form",
							"react-hook-form",
							"formik"
						]
					}
				},
				{
					name: ["-d", "--dry-run"],
					description: "Show what files will be created without writing them to disk"
				},
				{
					name: "--no-git",
					description: "Skip git repository creation"
				},
				{
					name: "--skip-upgrade",
					description: "Skip blitz upgrade if outdated"
				}
			],
			args: {
				name: "name",
				description: "Name of your new project"
			}
		},
		{
			name: ["prisma", "p"],
			description: "Loads env variables then proxies all args to Prisma CLI",
			subcommands: prismaCommands
		},
		{
			name: ["routes", "r"],
			description: "Display all Blitz URL Routes",
			icon,
			options: commonOptions
		},
		{
			name: ["start", "s"],
			description: "Start the production server",
			icon,
			options: [
				...commonOptions,
				{
					name: ["-p", "--port"],
					description: "Set port number",
					args: { name: "port" }
				},
				{
					name: ["-H", "--hostname"],
					description: "Set server hostname",
					args: { name: "hostname" }
				},
				{
					name: "--inspect",
					description: "Enable the Node.js inspector"
				}
			]
		},
		{
			name: "autocomplete",
			description: "Display autocomplete installation instructions",
			icon,
			options: [{
				name: ["-r", "--refresh-cache"],
				description: "Refresh cache (ignores displaying instructions)"
			}],
			args: {
				name: "shell",
				description: "Shell type",
				suggestions: ["zsh", "bash"],
				isOptional: true
			}
		}
	]
};
//#endregion
export { completionSpec as default };
