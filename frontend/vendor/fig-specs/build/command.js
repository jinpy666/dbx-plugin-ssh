//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/command.ts
var completionSpec = {
	name: "command",
	description: "Run an external command",
	options: [{
		name: "-v",
		description: "Print the location of the command"
	}],
	args: { isCommand: true }
};
//#endregion
export { completionSpec as default };
