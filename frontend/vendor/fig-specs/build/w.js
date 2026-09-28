//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/w.ts
var completionSpec = {
	name: "w",
	description: "Display who is logged in and what they are doing",
	parserDirectives: { optionsMustPrecedeArguments: true },
	options: [{
		name: "-h",
		description: "Suppress the heading"
	}, {
		name: "-i",
		description: "Output is sorted by idle time"
	}],
	args: {
		name: "user",
		isVariadic: true,
		isOptional: true
	}
};
//#endregion
export { completionSpec as default };
