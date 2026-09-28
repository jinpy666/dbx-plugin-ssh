//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/clear.ts
var completionSpec = {
	name: "clear",
	description: "Clear the terminal screen",
	options: [
		{
			name: "-T",
			description: "Indicates the type of terminal",
			args: { name: "type" }
		},
		{
			name: "-V",
			description: "Reports version of ncurses used in this program, and exits"
		},
		{
			name: "-x",
			description: "Do not attempt to clear terminal's scrollback buffer using the extended E3 capability"
		}
	]
};
//#endregion
export { completionSpec as default };
