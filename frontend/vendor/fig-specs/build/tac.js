//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/tac.ts
var completionSpec = {
	name: "tac",
	description: "Concatenate and print files in reverse",
	parserDirectives: { optionsMustPrecedeArguments: true },
	options: [
		{
			name: "--help",
			description: "Display this help and exit"
		},
		{
			name: ["--before", "-b"],
			description: "Attach the separator before instead of after"
		},
		{
			name: ["--regex", "-r"],
			description: "Interpret the separator as a regular expression"
		},
		{
			name: ["--separator", "-s"],
			description: "Use STRING as the separator instead of newline",
			args: { name: "STRING" }
		},
		{
			name: "--version",
			description: "Output version information and exit"
		}
	],
	args: {
		name: "FILE",
		template: "filepaths"
	}
};
//#endregion
export { completionSpec as default };
