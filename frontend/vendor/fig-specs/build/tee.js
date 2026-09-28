//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/tee.ts
var completionSpec = {
	name: "tee",
	description: "Duplicate standard input",
	options: [{
		name: "-a",
		description: "Append the output to the files rather than overwriting them"
	}, {
		name: "-i",
		description: "Ignore the SIGINT signal"
	}],
	args: {
		name: "file",
		description: "Pathname of an output file",
		isVariadic: true,
		template: "filepaths"
	}
};
//#endregion
export { completionSpec as default };
