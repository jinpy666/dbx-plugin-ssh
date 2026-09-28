//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/which.ts
var completionSpec = {
	name: "which",
	description: "Locate a program in the user's PATH",
	args: {
		name: "names",
		isVariadic: true,
		generators: {
			script: [
				"bash",
				"-c",
				`for i in $(echo $PATH | tr ":" "\n"); do find $i -maxdepth 1 -perm -111 -type f; done`
			],
			postProcess: (out) => out.split("\n").map((path) => path.split("/")[path.split("/").length - 1]).map((pr) => ({
				name: pr,
				description: "Executable file",
				type: "arg"
			}))
		},
		filterStrategy: "fuzzy",
		suggestCurrentToken: true
	},
	options: [{
		name: "-s",
		description: "No output, return 0 if all the executables are found, 1 if not"
	}, {
		name: "-a",
		description: "List all instances of executables found, instead of just the first"
	}]
};
//#endregion
export { completionSpec as default };
