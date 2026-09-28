//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/mdfind.ts
var completionSpec = {
	name: "mdfind",
	description: "Finds files matching a given query",
	parserDirectives: { flagsArePosixNoncompliant: true },
	options: [
		{
			name: ["--help", "-h"],
			description: "Show help for mdfind"
		},
		{
			name: "-0",
			description: "Prints an ASCII NUL character after each result path"
		},
		{
			name: "-live",
			description: "Provide live-updates to the number of files matching the query"
		},
		{
			name: "-count",
			description: "Output the total number of matches, instead of the path to the matching items"
		},
		{
			name: "-onlyin",
			description: "Limit the scope of the search to <dir>",
			args: {
				name: "dir",
				description: "Directory",
				template: "folders"
			}
		},
		{
			name: "-name",
			description: "Search for matching file names to <filename> only",
			args: { name: "filename" }
		},
		{
			name: "-reprint",
			description: "Reprint results on live update"
		},
		{
			name: "-s",
			description: "Show contents of smart folder ~/Library/Saved Searches/<folder>.savedSearch",
			args: {
				name: "folder",
				description: "Smart folder in  ~/Library/Saved Searches",
				generators: {
					custom: async (_, executeCommand, context) => {
						const { stdout } = await executeCommand({
							command: "ls",
							args: ["-1A", `${context.environmentVariables["HOME"]}/Library/Saved Searches/`]
						});
						return stdout.split("\n").filter((file) => file.endsWith("savedSearch")).map((path) => {
							const components = path.split("/");
							const filename = components[components.length - 1];
							return {
								name: filename.substring(0, filename.indexOf(".")),
								displayName: filename,
								icon: "fig://" + path,
								description: "Smart folder"
							};
						});
					},
					trigger: "/"
				}
			}
		},
		{
			name: "-literal",
			description: "Force the provided query string to be taken as a literal query string, without interpretation"
		},
		{
			name: "-interpret",
			description: "Force the provided query string to be interpreted as if it had been typed into the Spotlight menu"
		}
	],
	args: { name: "query" }
};
//#endregion
export { completionSpec as default };
