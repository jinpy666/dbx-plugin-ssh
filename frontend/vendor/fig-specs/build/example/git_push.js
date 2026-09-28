//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/example/git_push.ts
var completionSpec = {
	name: "git_push_example",
	description: "",
	args: [{
		name: "repository",
		isOptional: true
	}, {
		name: "refspec",
		isOptional: true,
		isVariadic: true
	}],
	options: [
		{ name: "--all" },
		{ name: "--mirror" },
		{ name: "--tags" },
		{ name: ["-n", "--dry-run"] },
		{
			name: "--receive-pack",
			args: { name: "git-receive-pack" }
		},
		{ name: ["-u", "--set-upstream"] },
		{
			name: "-o",
			args: { name: "string" }
		},
		{
			name: "--push-option",
			args: { name: "string" }
		}
	]
};
//#endregion
export { completionSpec as default };
