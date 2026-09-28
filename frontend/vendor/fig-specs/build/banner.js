//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/banner.ts
var completionSpec = {
	name: "banner",
	description: "Prints a large, high quality banner on the standard output",
	args: { name: "text" },
	options: [
		{
			name: "-t",
			description: "Enable trace"
		},
		{
			name: "-d",
			description: "Enable debug"
		},
		{
			name: "-w",
			description: "Change the output from a width of 132 to width, suitable for a narrow terminal"
		}
	]
};
//#endregion
export { completionSpec as default };
