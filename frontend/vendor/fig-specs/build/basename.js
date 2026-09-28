//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/basename.ts
var completionSpec = {
	name: "basename",
	description: "Return filename portion of pathname",
	options: [{
		name: "-a",
		description: "Treat every argument as a string"
	}, {
		name: "-s",
		description: "Suffix to remove from string",
		args: { name: "suffix" }
	}],
	args: {
		name: "string",
		description: "String to operate on (typically filenames)",
		isVariadic: true,
		template: "filepaths"
	}
};
//#endregion
export { completionSpec as default };
