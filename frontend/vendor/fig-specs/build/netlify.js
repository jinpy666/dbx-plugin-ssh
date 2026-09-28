//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/netlify.ts
var debugProxyOptions = [
	{
		name: "--debug",
		description: "Print debugging information"
	},
	{
		name: "--httpProxy",
		description: "Proxy server address to route requests through",
		args: { name: "httpProxy" }
	},
	{
		name: "--httpProxyCertificateFilename",
		description: "Certificate file to use when connecting using a proxy server",
		args: { name: "httpProxyCertificateFilename" }
	}
];
var subcommands = [
	{
		name: ["addons:auth", "addon:auth"],
		description: "Login to add-on provider",
		args: {
			name: "name",
			description: "Add-on slug"
		},
		options: [...debugProxyOptions]
	},
	{
		name: ["addons:config", "addon:config"],
		description: "Configure add-on settings",
		args: {
			name: "name",
			description: "Add-on namespace"
		},
		options: [...debugProxyOptions]
	},
	{
		name: ["addons:create", "addon:create"],
		description: "Add an add-on extension to your site",
		args: {
			name: "name",
			description: "Add-on namespace"
		},
		options: [...debugProxyOptions]
	},
	{
		name: ["addons:delete", "addon:delete"],
		description: "Remove an add-on extension to your site",
		args: {
			name: "name",
			description: "Add-on namespace"
		},
		options: [{
			name: ["-f", "--force"],
			description: "Delete without prompting (useful for CI)",
			isDangerous: true
		}, ...debugProxyOptions]
	},
	{
		name: ["addons:list", "addon:list"],
		description: "List currently installed add-ons for site",
		options: [{
			name: "--json",
			description: "Output return values as JSON"
		}, ...debugProxyOptions]
	},
	{
		name: "api",
		description: "Run any Netlify API method",
		args: {
			name: "apiMethod",
			description: "Open API method to run"
		},
		options: [
			{
				name: ["-d", "--data"],
				description: "Data to use",
				args: { name: "data" }
			},
			{
				name: "--list",
				description: "List out available API methods"
			},
			...debugProxyOptions
		]
	},
	{
		name: "build",
		description: "(Beta) Build on your local machine",
		options: [
			{
				name: ["-o", "--offline"],
				description: "Disables any features that require network access"
			},
			{
				name: "--context",
				description: "Build context",
				args: { name: "context" }
			},
			{
				name: "--dry",
				description: "Dry run: show instructions without running them"
			},
			...debugProxyOptions
		]
	},
	{
		name: "completion",
		description: "(Beta) Generate shell completion script",
		options: [{
			name: ["-s", "--shell"],
			description: "Name of shell (bash|fish|zsh)",
			isRequired: true,
			args: {
				name: "shell",
				suggestions: [
					"bash",
					"fish",
					"zsh"
				]
			}
		}]
	},
	{
		name: "completion:generate",
		description: "Generates completion script",
		options: [{
			name: ["-s", "--shell"],
			description: "(required) Name of shell [bash|fish|zsh]",
			isRequired: true
		}]
	},
	{
		name: "completion:generate:alias",
		description: "Generates completion script for alias",
		options: [{
			name: ["-s", "--shell"],
			description: "(required) Name of shell [bash|fish|zsh]",
			isRequired: true
		}]
	},
	{
		name: "deploy",
		description: "Create a new deploy from the contents of a folder",
		options: [
			{
				name: ["-a", "--auth"],
				description: "Netlify auth token to deploy with",
				args: { name: "auth" }
			},
			{
				name: ["-b", "--branch"],
				description: "Serves the same functionality as --alias. Deprecated and will be removed in future versions",
				args: { name: "branch" }
			},
			{
				name: ["-d", "--dir"],
				description: "Specify a folder to deploy",
				args: {
					name: "dir",
					template: "folders"
				}
			},
			{
				name: ["-f", "--functions"],
				description: "Specify a functions folder to deploy",
				args: {
					name: "functions",
					template: "folders"
				}
			},
			{
				name: ["-m", "--message"],
				description: "A short message to include in the deploy log",
				args: { name: "message" }
			},
			{
				name: ["-o", "--open"],
				description: "Open site after deploy"
			},
			{
				name: ["-p", "--prod"],
				description: "Deploy to production"
			},
			{
				name: ["-s", "--site"],
				description: "A site ID to deploy to",
				args: { name: "site" }
			},
			{
				name: "--alias",
				description: "Specifies the alias for deployment, the string at the beginning of the deploy subdomain",
				args: { name: "alias" }
			},
			{
				name: "--build",
				description: "Run build command before deploying"
			},
			...debugProxyOptions,
			{
				name: "--json",
				description: "Output deployment data as JSON"
			},
			{
				name: "--prodIfUnlocked",
				description: "Deploy to production if unlocked, create a draft otherwise"
			},
			{
				name: "--skip-functions-cache",
				description: "Ignore any functions created as part of a previous `build` or `deploy` commands, forcing them to be bundled again as part of the deployment"
			},
			{
				name: "--timeout",
				description: "Timeout to wait for deployment to finish",
				args: { name: "timeout" }
			},
			{
				name: "trigger",
				description: "Trigger a new build of your site on Netlify without uploading local files"
			}
		]
	},
	{
		name: "dev",
		description: "Local dev server",
		options: [
			{
				name: ["-c", "--command"],
				description: "Command to run",
				args: {
					name: "command",
					isCommand: true
				}
			},
			{
				name: ["-d", "--dir"],
				description: "Dir with static files",
				args: {
					name: "dir",
					template: "filepaths"
				}
			},
			{
				name: ["-f", "--functions"],
				description: "Specify a functions folder to serve",
				args: {
					name: "functions",
					template: "folders"
				}
			},
			{
				name: ["-l", "--live"],
				description: "Start a public live session"
			},
			{
				name: ["-o", "--offline"],
				description: "Disables any features that require network access"
			},
			{
				name: ["-p", "--port"],
				description: "Port of netlify dev",
				args: { name: "port" }
			},
			...debugProxyOptions,
			{
				name: "--framework",
				description: "Framework to use. Defaults to #auto which automatically detects a framework",
				args: { name: "framework" }
			},
			{
				name: "--targetPort",
				description: "Port of target app server",
				args: { name: "targetPort" }
			}
		]
	},
	{
		name: "dev:exec",
		description: "Exec command",
		options: [...debugProxyOptions]
	},
	{
		name: "dev:trace",
		description: "Trace command",
		args: {
			name: "url",
			description: "Sets the request URL"
		},
		options: [
			{
				name: ["-H", "--header"],
				description: "Request header, this flag can be used multiple times. Example: \"Host: netlify.test\"",
				args: { name: "header" }
			},
			{
				name: ["-X", "--request"],
				description: "Specifies a custom request method [default: GET]",
				args: { name: "request" }
			},
			{
				name: ["-B", "--cookie"],
				description: "Request cookie, this flag can be used multiple times. Example: \"nf_jwt=token\"",
				args: { name: "cookie" }
			},
			{
				name: ["-w", "--watch"],
				description: "Path to the publish directory",
				args: {
					name: "watch",
					template: "filepaths"
				}
			},
			{
				name: "--debug",
				description: "Print debugging information"
			}
		]
	},
	{
		name: "env",
		description: "(Beta) Control environment variables for the current site",
		options: [...debugProxyOptions]
	},
	{
		name: "env:get",
		description: "Get resolved value of specified environment variable (includes netlify.toml)",
		options: [...debugProxyOptions]
	},
	{
		name: "env:import",
		description: "Import and set environment variables from .env file",
		args: {
			name: "filename",
			description: ".env file to import",
			template: "filepaths"
		},
		options: [{
			name: ["-r", "--replaceExisting"],
			description: "Replace all existing variables instead of merging them with the current ones"
		}, ...debugProxyOptions]
	},
	{
		name: "env:list",
		description: "Lists resolved environment variables for site (includes netlify.toml)",
		options: [...debugProxyOptions]
	},
	{
		name: "env:set",
		description: "Set value of environment variable",
		args: [{
			name: "name",
			description: "Environment variable name"
		}, {
			name: "value",
			description: "Value to set to"
		}],
		options: [...debugProxyOptions]
	},
	{
		name: [
			"env:unset",
			"env:delete",
			"env:remove"
		],
		description: "Unset an environment variable which removes it from the UI",
		args: {
			name: "name",
			description: "Environment variable name"
		},
		options: [...debugProxyOptions]
	},
	{
		name: ["functions:build", "function:build"],
		description: "Build functions locally",
		options: [
			{
				name: ["-f", "--functions"],
				description: "Specify a functions directory to build to",
				args: {
					name: "functions",
					template: "folders"
				}
			},
			{
				name: ["-s", "--src"],
				description: "Specify the source directory for the functions",
				args: { name: "src" }
			},
			...debugProxyOptions
		]
	},
	{
		name: ["functions:create", "function:create"],
		description: "Create a new function locally",
		args: {
			name: "name",
			description: "Name of your new function file inside your functions directory"
		},
		options: [
			{
				name: ["-n", "--name"],
				description: "Function name",
				args: { name: "name" }
			},
			{
				name: ["-u", "--url"],
				description: "Pull template from URL",
				args: { name: "url" }
			},
			...debugProxyOptions
		]
	},
	{
		name: ["functions:invoke", "function:trigger"],
		description: "Trigger a function while in netlify dev with simulated data, good for testing function calls including Netlify's Event Triggered Functions",
		args: {
			name: "name",
			description: "Function name to invoke"
		},
		options: [
			{
				name: ["-f", "--functions"],
				description: "Specify a functions folder to parse, overriding netlify.toml",
				args: {
					name: "functions",
					template: "folders"
				}
			},
			{
				name: ["-n", "--name"],
				description: "Function name to invoke",
				args: { name: "name" }
			},
			{
				name: ["-p", "--payload"],
				description: "Supply POST payload in stringified json, or a path to a json file",
				args: {
					name: "payload",
					template: "filepaths"
				}
			},
			{
				name: ["-q", "--querystring"],
				description: "Querystring to add to your function invocation",
				args: { name: "querystring" }
			},
			...debugProxyOptions,
			{
				name: "--identity",
				description: "Simulate Netlify Identity authentication JWT",
				exclusiveOn: ["--no-identity"]
			},
			{
				name: "--no-identity",
				description: "Affirm unauthenticated request",
				exclusiveOn: ["--identity"]
			},
			{
				name: "port",
				description: "Port where netlify dev is accessible. e.g. 8888",
				args: { name: "port" }
			}
		]
	},
	{
		name: ["functions:list", "function:list"],
		description: "List functions that exist locally",
		options: [
			{
				name: ["-f", "--functions"],
				description: "Specify a functions directory to list",
				args: {
					name: "functions",
					template: "folders"
				}
			},
			{
				name: ["-n", "--name"],
				description: "Name to print",
				args: { name: "name" }
			},
			...debugProxyOptions,
			{
				name: "--json",
				description: "Output function data as JSON"
			}
		]
	},
	{
		name: ["functions:serve", "function:server"],
		description: "(Beta) Serve functions locally",
		options: [
			{
				name: ["-f", "--functions"],
				description: "Specify a functions folder to deploy",
				args: {
					name: "functions",
					template: "folders"
				}
			},
			{
				name: ["-o", "--offline"],
				description: "Disables any features that require network access"
			},
			{
				name: ["-p", "--port"],
				description: "Port of netlify dev",
				args: { name: "port" }
			},
			...debugProxyOptions
		]
	},
	{
		name: "init",
		description: "Configure continuous deployment for a new or existing site. To create a new site without continuous deployment, use `netlify sites:create`",
		options: [
			{
				name: ["-m", "--manual"],
				description: "Manually configure a git remote for CI"
			},
			{
				name: "--force",
				description: "Reinitialize CI hooks if the linked site is already configured to use CI"
			},
			{
				name: "--gitRemoteName",
				description: "Name of Git remote to use. e.g. \"origin\"",
				args: { name: "gitRemoteName" }
			},
			...debugProxyOptions
		]
	},
	{
		name: "link",
		description: "Link a local repo or project folder to an existing site on Netlify",
		options: [
			{
				name: "--gitRemoteName",
				description: "Name of Git remote to use. e.g. \"origin\"",
				args: { name: "gitRemoteName" }
			},
			{
				name: "--id",
				description: "ID of site to link to",
				args: { name: "id" }
			},
			{
				name: "--name",
				description: "Name of site to link to",
				args: { name: "name" }
			},
			...debugProxyOptions
		]
	},
	{
		name: "lm",
		description: "Handle Netlify Large Media operations",
		options: [...debugProxyOptions]
	},
	{
		name: "lm:info",
		description: "Show large media requirements information",
		options: [...debugProxyOptions]
	},
	{
		name: ["lm:install", "lm:init"],
		description: "Configures your computer to use Netlify Large Media",
		options: [{
			name: ["-f", "--force"],
			description: "Force the credentials helper installation"
		}]
	},
	{
		name: "lm:setup",
		description: "Configures your site to use Netlify Large Media",
		options: [
			{
				name: ["-f", "--force-install"],
				description: "Force the credentials helper installation"
			},
			{
				name: ["-s", "--skip-install"],
				description: "Skip the credentials helper installation check"
			},
			...debugProxyOptions
		]
	},
	{
		name: "login",
		description: "Login to your Netlify account",
		options: [
			{
				name: "--auth",
				description: "Netlify auth token",
				args: { name: "auth" }
			},
			...debugProxyOptions,
			{
				name: "--json",
				description: "Output return values as JSON"
			},
			{
				name: "--new",
				description: "Login to new Netlify account"
			},
			{
				name: "--silent",
				description: "Silence CLI output"
			}
		]
	},
	{
		name: "open",
		description: "Open settings for the site linked to the current folder",
		options: [
			{
				name: "--admin",
				description: "Open Netlify site"
			},
			{
				name: "--site",
				description: "Open site"
			},
			...debugProxyOptions
		]
	},
	{
		name: "open:admin",
		description: "Opens current site admin UI in Netlify",
		options: [...debugProxyOptions]
	},
	{
		name: "open:site",
		description: "Opens current site url in browser",
		options: [...debugProxyOptions]
	},
	{
		name: "sites:create",
		description: "Create an empty site (advanced)",
		options: [
			{
				name: ["-a", "--account-slug"],
				description: "Account slug to create the site under"
			},
			{
				name: ["-c", "--with-ci"],
				description: "Initialize CI hooks during site creation"
			},
			{
				name: ["-m", "--manual"],
				description: "Force manual CI setup. Used --with-ci flag",
				dependsOn: ["-c", "--with-ci"]
			},
			{
				name: ["-n", "--name"],
				description: "Name of site"
			},
			...debugProxyOptions
		]
	},
	{
		name: "sites:delete",
		description: "Delete a site",
		args: {
			name: "siteId",
			description: "Site ID to delete"
		},
		options: [{
			name: ["-f", "--force"],
			description: "Delete without prompting (useful for CI)",
			isDangerous: true
		}, ...debugProxyOptions]
	},
	{
		name: "sites:list",
		description: "List all sites you have access to",
		options: [{
			name: "--json",
			description: "Output site data as JSON"
		}, ...debugProxyOptions]
	},
	{
		name: "status",
		description: "Print status information",
		options: [{
			name: "verbose",
			description: "Output system info"
		}, ...debugProxyOptions]
	},
	{
		name: "status:hooks",
		description: "Print hook information of the linked site",
		options: [...debugProxyOptions]
	},
	{
		name: "unlink",
		description: "Unlink a local folder from a Netlify site",
		options: [...debugProxyOptions]
	},
	{
		name: "watch",
		description: "Watch for site deploy to finish",
		options: [...debugProxyOptions]
	}
];
var completionSpec = {
	name: "netlify",
	description: "Netlify command line tool",
	subcommands: [...subcommands, {
		name: "help",
		description: "List available sub-commands",
		args: {
			name: "subcommand",
			description: "The command to display help for",
			isOptional: true,
			suggestions: subcommands
		}
	}],
	options: [{
		name: "--telemetry-disable",
		description: "Opt out of sharing usage data",
		exclusiveOn: ["--telemetry-enable"]
	}, {
		name: "--telemetry-enable",
		description: "Allow your usage to help shape development",
		exclusiveOn: ["--telemetry-disable"]
	}]
};
//#endregion
export { completionSpec as default };
