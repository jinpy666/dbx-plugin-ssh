//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/rm.ts
var completionSpec = {
	name: "rm",
	description: "Remove directory entries",
	args: {
		isVariadic: true,
		template: ["folders", "filepaths"]
	},
	options: [
		{
			name: ["-r", "-R"],
			description: "Recursive. Attempt to remove the file hierarchy rooted in each file argument",
			isDangerous: true
		},
		{
			name: "-P",
			description: "Overwrite regular files before deleting them",
			isDangerous: true
		},
		{
			name: "-d",
			description: "Attempt to remove directories as well as other types of files"
		},
		{
			name: "-f",
			description: "⚠️ Attempt to remove the files without prompting for confirmation",
			isDangerous: true
		},
		{
			name: "-i",
			description: "Request confirmation before attempting to remove each file"
		},
		{
			name: "-v",
			description: "Be verbose when deleting files"
		}
	]
};
//#endregion
export { completionSpec as default };
