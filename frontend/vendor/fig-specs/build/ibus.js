//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/ibus.ts
var completionSpec = {
	name: "ibus",
	subcommands: [
		{
			name: "engine",
			description: "Set or get engine",
			args: {
				isOptional: true,
				generators: {
					script: ["ibus", "list-engine"],
					postProcess: (out) => out.split("\n").filter((line) => line.startsWith(" ")).map((line) => {
						const [id, name] = line.trim().split(" - ", 2);
						return {
							name: id,
							description: name
						};
					})
				}
			}
		},
		{
			name: "exit",
			description: "Exit ibus-daemon"
		},
		{
			name: "list-engine",
			description: "Show available engines"
		},
		{
			name: "watch",
			description: "Not implemented",
			hidden: true
		},
		{
			name: "version",
			description: "Show version"
		},
		{
			name: "read-cache",
			description: "Show the content of registry cache"
		},
		{
			name: "write-cache",
			description: "Create registry cache"
		},
		{
			name: "address",
			description: "Print the D-Bus address of ibus-daemon"
		},
		{
			name: "read-config",
			description: "Show the configuration values"
		},
		{
			name: "reset-config",
			description: "Reset the configuration values"
		},
		{
			name: "emoji",
			description: "Save emoji on dialog to clipboard"
		},
		{
			name: "help",
			description: "Show this information"
		}
	]
};
//#endregion
export { completionSpec as default };
