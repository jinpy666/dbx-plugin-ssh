//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/az/2.53.0/interactive.ts
var completion = {
	name: "interactive",
	description: "Start interactive mode. Installs the Interactive extension if not installed already",
	options: [{
		name: ["--style", "-s"],
		description: "The colors of the shell",
		args: {
			name: "style",
			suggestions: [
				"bg",
				"br",
				"contrast",
				"default",
				"grey",
				"halloween",
				"neon",
				"none",
				"pastel",
				"primary",
				"purple",
				"quiet"
			]
		}
	}, {
		name: "--update",
		description: "Update the Interactive extension to the latest available",
		args: { name: "update" }
	}]
};
//#endregion
export { completion as default };
