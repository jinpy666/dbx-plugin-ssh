//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/gibo.ts
var completionSpec = {
	name: "gibo",
	description: "Easy access to gitignore boilerplates",
	subcommands: [
		{
			name: "dump",
			description: "Dump one or more boilerplates to STDOUT",
			args: {
				name: "boilerplate",
				description: "Name of the boilerplate to dump",
				generators: {
					script: ["gibo", "list"],
					splitOn: "\n"
				},
				isVariadic: true
			}
		},
		{
			name: "search",
			description: "Search for boilerplates",
			args: {
				name: "search term",
				description: "Name of the language or framework to search for"
			}
		},
		{
			name: "root",
			description: "Show the directory where gibo stores its boilerplates"
		},
		{
			name: "help",
			description: "Show help information"
		},
		{
			name: "list",
			description: "Show the list of available boilerplates"
		},
		{
			name: "update",
			description: "Update the list of available boilerplates"
		},
		{
			name: "version",
			description: "Show the current version of gibo installed"
		}
	],
	options: [{
		name: ["--help", "-h"],
		description: "Show help for gibo"
	}]
};
//#endregion
export { completionSpec as default };
