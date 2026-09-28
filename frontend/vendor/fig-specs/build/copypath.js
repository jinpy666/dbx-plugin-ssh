//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/copypath.ts
var completionSpec = {
	name: "copypath",
	description: "Oh-My-Zsh plugin that copies the path of given directory or file to the clipboard",
	args: {
		name: "path",
		isOptional: true,
		template: ["filepaths", "folders"]
	}
};
//#endregion
export { completionSpec as default };
