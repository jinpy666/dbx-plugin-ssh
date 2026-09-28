//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/create-completion-spec.ts
var completionSpec = {
	name: "create-completion-spec",
	description: "Setup fig folder and create spec with the given name",
	subcommands: [{
		name: "help",
		description: "Display help for command",
		priority: 49,
		args: {
			name: "command",
			isOptional: true
		}
	}],
	options: [{
		name: "--here",
		description: "Set if the spec should be created in the current folder"
	}, {
		name: ["-h", "--help"],
		description: "Display help for command",
		priority: 49
	}],
	args: { name: "name" }
};
//#endregion
export { completionSpec as default };
