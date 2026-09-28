//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/wasm-pack.ts
var completionSpec = {
	name: "wasm-pack",
	description: "",
	subcommands: [
		{
			name: "build",
			icon: "🏗️",
			description: "Build an npm package"
		},
		{
			name: "help",
			description: "Prints this message or the help of the given subcommand(s)",
			args: {
				name: "subcommand",
				isOptional: true,
				template: "help"
			}
		},
		{
			name: [
				"login",
				"adduser",
				"add-user"
			],
			icon: "👤",
			description: "Add an npm registry user account"
		},
		{
			name: "new",
			icon: "🐑",
			description: "Create a new project with a template"
		},
		{
			name: "pack",
			icon: "📦",
			description: "Create a tarball of the npm package (does not publish)"
		},
		{
			name: "publish",
			icon: "🎆",
			description: "Pack and publish a package to npm"
		},
		{
			name: "test",
			description: "Run tests for WebAssembly module"
		}
	],
	options: [
		{
			name: ["--help", "-h"],
			description: "Show help for wasm-pack or for the given subcommand(s)"
		},
		{
			name: ["--quiet", "-q"],
			description: "Suppress output from stdout"
		},
		{
			name: ["--version", "-V"],
			description: "Show version for wasm-pack"
		},
		{
			name: ["--verbose", "-v"],
			description: "Log verbosity is based off the number of v used"
		},
		{
			name: ["--log-level", "-l"],
			description: "The maximum level of messages that should be logged by wasm-pack",
			args: {
				name: "log-level",
				default: "info",
				suggestions: [
					"info",
					"warn",
					"error"
				]
			}
		}
	]
};
//#endregion
export { completionSpec as default };
