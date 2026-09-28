//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/ln.ts
var sourceDestArgs = [{
	name: "source_file",
	template: ["filepaths", "folders"]
}, {
	name: "link_name or link_dirname",
	isOptional: true
}];
var completionSpec = {
	name: "ln",
	description: "Create (default hard) symbolic links to files",
	args: sourceDestArgs,
	options: [
		{
			name: "-s",
			description: "Create a symbolic link",
			args: sourceDestArgs
		},
		{
			name: "-v",
			description: "Verbose"
		},
		{
			name: "-F",
			description: "If link name already exists replace it",
			args: sourceDestArgs
		},
		{
			name: "-h",
			description: "Don't follow symbolic links"
		},
		{
			name: "-f",
			description: "If link name already exists unlink the old one before creating the new one",
			args: sourceDestArgs
		},
		{
			name: "-i",
			description: "Prompt if proposed link already exists",
			args: sourceDestArgs
		},
		{
			name: "-n",
			description: "Same as -h don't follow symbolic links"
		}
	]
};
//#endregion
export { completionSpec as default };
