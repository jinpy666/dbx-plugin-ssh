//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/head.ts
var completionSpec = {
	name: "head",
	description: "Output the first part of files",
	args: {
		name: "file",
		template: "filepaths"
	},
	options: [
		{
			name: ["-c", "--bytes"],
			description: "Print the first [numBytes] bytes of each file",
			args: { name: "numBytes" }
		},
		{
			name: ["-n", "--lines"],
			description: "Print the first [numLines] lines instead of the first 10",
			args: { name: "numLines" }
		},
		{
			name: [
				"-q",
				"--quiet",
				"--silent"
			],
			description: "Never print headers giving file names"
		},
		{
			name: ["-v", "--verbose"],
			description: "Always print headers giving file names"
		},
		{
			name: "--help",
			description: "Display this help and exit"
		},
		{
			name: "--version",
			description: "Output version information and exit"
		}
	]
};
//#endregion
export { completionSpec as default };
