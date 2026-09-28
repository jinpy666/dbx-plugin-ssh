//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/crontab.ts
var completionSpec = {
	name: "crontab",
	description: "Maintain crontab file for individual users",
	options: [
		{
			name: "-e",
			description: "Edit the current crontab"
		},
		{
			name: "-l",
			description: "Display the current crontab"
		},
		{
			name: "-r",
			description: "Remove the current crontab",
			isDangerous: true
		},
		{
			name: "-u",
			description: "Specify the name of the user whose crontab is to be tweaked"
		}
	]
};
//#endregion
export { completionSpec as default };
