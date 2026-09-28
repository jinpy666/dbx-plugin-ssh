//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/unset.ts
var completionSpec = {
	name: "unset",
	description: "Named variable shall be undefined",
	args: {
		name: "string",
		generators: {
			script: ["env"],
			postProcess: (out) => out.length === 0 ? [] : out.split("\n").map((env) => env.split("=")[0]).map((suggestion) => ({
				name: `${suggestion}`,
				type: "arg",
				description: "Environment Variable"
			}))
		}
	},
	options: [{
		name: "-v",
		description: "Variable definition will be unset"
	}]
};
//#endregion
export { completionSpec as default };
