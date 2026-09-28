//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/zip.ts
var completionSpec = {
	name: "zip",
	description: "Package and compress (archive) files into zip file",
	args: [{
		name: "name",
		description: "Name of archive"
	}, {
		name: "dir",
		template: "folders"
	}],
	options: [
		{
			name: "-r",
			description: "Package and compress a directory and its contents, recursively"
		},
		{ name: "-e" },
		{
			name: "-s",
			args: { name: "split size" }
		},
		{
			name: "-d",
			args: {
				name: "file",
				template: "filepaths"
			}
		},
		{
			name: "-9",
			description: "Archive a directory and its contents with the highest level [9] of compression"
		}
	]
};
//#endregion
export { completionSpec as default };
