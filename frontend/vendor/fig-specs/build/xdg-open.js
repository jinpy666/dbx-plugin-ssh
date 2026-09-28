//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/xdg-open.ts
var completionSpec = {
	name: "xdg-open",
	description: "Opens a file or URL in the user's preferred application",
	args: {
		name: "FILE or URL",
		template: "filepaths"
	},
	options: [
		{
			name: "--help",
			description: "Show command synopsis"
		},
		{
			name: "--manual",
			description: "Show manual page"
		},
		{
			name: "--version",
			description: "Show the xdg-utils version information"
		}
	]
};
//#endregion
export { completionSpec as default };
