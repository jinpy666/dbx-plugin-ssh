//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/svokit.ts
var completionSpec = {
	name: "svokit",
	description: "Runs built svokit project",
	subcommands: [{
		name: "setup",
		description: "Creates svokit config (experimental)"
	}, {
		name: "run",
		description: "Runs build svokit project"
	}],
	options: [{
		name: ["--help", "-h"],
		description: "Show help for svokit"
	}]
};
//#endregion
export { completionSpec as default };
