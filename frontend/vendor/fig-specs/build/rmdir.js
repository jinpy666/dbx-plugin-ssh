//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/rmdir.ts
var completionSpec = {
	name: "rmdir",
	description: "Remove directories",
	args: {
		isVariadic: true,
		template: "folders"
	},
	options: [{
		name: "-p",
		description: "Remove each directory of path",
		isDangerous: true
	}]
};
//#endregion
export { completionSpec as default };
