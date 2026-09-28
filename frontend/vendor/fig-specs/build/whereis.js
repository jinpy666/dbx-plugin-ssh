//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/whereis.ts
var completionSpec = {
	name: "whereis",
	description: "Locate the binary, source, and manual page files for a command",
	options: [
		{
			name: "-b",
			description: "Search only for binaries"
		},
		{
			name: "-m",
			description: "Search only for manual sections"
		},
		{
			name: "-s",
			description: "Search only for sources"
		},
		{
			name: "-u",
			description: "Search for unusual entries"
		},
		{
			name: "-B",
			description: "Search for binaries only in the specified directory",
			args: {
				name: "directory",
				description: "The directory to search in",
				template: "folders"
			}
		},
		{
			name: "-M",
			description: "Search for manual pages only in the specified directory",
			args: {
				name: "directory",
				description: "The directory to search in",
				template: "folders"
			}
		},
		{
			name: "-S",
			description: "Search for sources only in the specified directory",
			args: {
				name: "directory",
				description: "The directory to search in",
				template: "folders"
			}
		},
		{
			name: "-f",
			description: "Terminate the -B, -M, and -S options"
		}
	],
	args: {
		name: "Filename",
		description: "The file to search for"
	}
};
//#endregion
export { completionSpec as default };
