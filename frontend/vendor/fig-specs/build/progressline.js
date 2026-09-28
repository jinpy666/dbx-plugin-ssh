//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/progressline.ts
var completionSpec = {
	name: "progressline",
	description: "⏳Track commands progress in a compact one-line format",
	options: [
		{
			name: ["--help", "-h"],
			description: "Show help for progressline"
		},
		{
			name: ["--log-all", "-a"],
			description: "Log all lines above the progress line"
		},
		{
			name: ["--static-text", "-t"],
			description: "Set static text to display instead of the latest stdin data",
			args: { name: "text" }
		},
		{
			name: ["--activity-style", "-s"],
			args: {
				name: "style",
				default: "dots",
				suggestions: [
					"dots",
					"kitt",
					"snake"
				]
			},
			description: "Set style of the activity indicator"
		},
		{
			name: ["--original-log-path", "-l"],
			description: "Save the original log to a file",
			args: {
				name: "path",
				template: "filepaths"
			}
		},
		{
			name: ["--log-matches", "-m"],
			description: "Log above progress line lines matching the given regular expressions",
			args: { name: "regex" }
		}
	]
};
//#endregion
export { completionSpec as default };
