//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/unzip.ts
var completionSpec = {
	name: "unzip",
	description: "Extract compressed files in a ZIP archive",
	args: {
		name: "file",
		template: "filepaths"
	},
	options: [
		{
			name: "-l",
			description: "List the contents of a zip file without extracting",
			args: {
				name: "file",
				template: "filepaths"
			}
		},
		{
			name: "-c",
			args: {
				name: "file",
				template: "filepaths"
			}
		},
		{
			name: "-0",
			description: "Extract a zip file created in windows, containing files with non-ascii (chinese) filenames",
			args: [{ name: "gbk" }, {
				name: "file",
				template: "filepaths"
			}]
		},
		{
			name: "-d",
			args: {
				name: "destination",
				template: "folders"
			}
		}
	]
};
//#endregion
export { completionSpec as default };
