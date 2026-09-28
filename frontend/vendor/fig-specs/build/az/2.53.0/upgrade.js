//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/az/2.53.0/upgrade.ts
var completion = {
	name: "upgrade",
	description: "Upgrade Azure CLI and extensions",
	options: [{
		name: "--all",
		description: "Enable updating extensions as well",
		args: {
			name: "all",
			suggestions: ["false", "true"]
		}
	}, {
		name: ["--yes", "-y"],
		description: "Do not prompt for checking release notes"
	}]
};
//#endregion
export { completion as default };
