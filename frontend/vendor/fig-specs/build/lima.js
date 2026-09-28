//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/lima.ts
var completionSpec = {
	name: "lima",
	description: "Lima is an alias for \"limactl shell $LIMA_INSTANCE\"",
	args: {
		name: "COMMAND",
		isVariadic: true,
		isOptional: true,
		isCommand: true
	},
	options: [{
		name: ["-h", "--help"],
		description: "Help for lima"
	}]
};
//#endregion
export { completionSpec as default };
