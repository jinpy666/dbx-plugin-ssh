//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/hostname.ts
var completionSpec = {
	name: "hostname",
	description: "Set or print name of current host system",
	options: [
		{
			name: "-f",
			description: "Include domain information in the printed name"
		},
		{
			name: "-s",
			description: "Trim off any domain information from the printed name"
		},
		{
			name: "-d",
			description: "Only print domain information"
		}
	],
	args: {
		name: "hostname",
		description: "The hostname to use for this machine"
	}
};
//#endregion
export { completionSpec as default };
