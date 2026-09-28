//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/tail.ts
var completionSpec = {
	name: "tail",
	description: "Display the last part of a file",
	args: {
		isVariadic: true,
		template: "filepaths"
	},
	options: [{
		name: "-f",
		description: "Wait for additional data to be appended"
	}, {
		name: "-r",
		description: "Display in reverse order"
	}]
};
//#endregion
export { completionSpec as default };
