//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/xc.ts
/**
* https://github.com/joerdav/xc
* xc - Simple, Convenient, Markdown-based task runner.
* v0.2.0
*/
var completionSpec = {
	name: "xc",
	description: "List tasks from an xc-compatible markdown file",
	generateSpec: async (context, executeShellCommand) => {
		const options = [
			{
				name: ["-f", "-file"],
				args: {
					name: "path",
					template: "filepaths"
				},
				description: "Specify a markdown file that contains tasks (default: \"README.md\")"
			},
			{
				name: ["-d", "-display"],
				description: "Print the markdown code of a task rather than running it"
			},
			{
				name: ["-H", "-heading"],
				args: {
					name: "heading",
					suggestions: [
						"Tasks",
						"Usage",
						"Examples"
					]
				},
				description: "Specify the heading for xc tasks (default: \"Tasks\")"
			}
		];
		const { stdout } = await executeShellCommand({
			command: "xc",
			args: []
		});
		return {
			name: "xc",
			subcommands: stdout.trim().split("\n").map((line) => line.trim().split(/^([^ ]* )/).map((s) => s.trim())).map(([_, task, desc]) => ({
				name: task,
				description: desc,
				options
			}))
		};
	},
	options: [
		{
			name: ["-s", "-short"],
			description: "List task names in a short format"
		},
		{
			name: ["-h", "-help"],
			description: "Print this help text"
		},
		{
			name: ["-f", "-file"],
			args: {
				name: "path",
				template: "filepaths"
			},
			description: "Specify a markdown file that contains tasks (default: \"README.md\")"
		},
		{
			name: ["-H", "-heading"],
			args: {
				name: "heading",
				suggestions: [
					"Tasks",
					"Usage",
					"Examples"
				]
			},
			description: "Specify the heading for xc tasks (default: \"Tasks\")"
		},
		{
			name: ["-V", "-version"],
			description: "Show xc version"
		},
		{
			name: "-complete",
			description: "Install shell completion for xc"
		},
		{
			name: "-uncomplete",
			description: "Uninstall shell completion for xc"
		}
	]
};
//#endregion
export { completionSpec as default };
