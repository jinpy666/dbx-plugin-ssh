//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/hx.ts
var completionSpec = {
	name: "hx",
	description: "A post-modern text editor",
	parserDirectives: { flagsArePosixNoncompliant: true },
	args: {
		name: "files",
		template: ["filepaths", "folders"],
		isVariadic: true
	},
	options: [
		{
			name: ["-h", "--help"],
			description: "Show help"
		},
		{
			name: "--tutor",
			description: "Open the tutorial"
		},
		{
			name: "--health",
			description: "Check for errors in editor setup",
			args: {
				name: "language",
				isOptional: true
			}
		},
		{
			name: "-v",
			description: "Increases logging verbosity",
			isRepeatable: true
		},
		{
			name: ["-g", "--grammar"],
			description: "Fetch or build tree-sitter grammars",
			args: {
				name: "action",
				suggestions: [{
					name: "fetch",
					icon: "fig://icon?type=command"
				}, {
					name: "build",
					icon: "fig://icon?type=command"
				}]
			}
		},
		{
			name: ["-V", "--version"],
			description: "Print version information"
		}
	]
};
//#endregion
export { completionSpec as default };
