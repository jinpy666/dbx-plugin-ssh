//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/git-profile.ts
var completionSpec = {
	name: "git-profile",
	description: "Switch profiles",
	subcommands: [{
		name: "use",
		description: "Use a profile",
		args: {
			name: "profile",
			description: "Profile you want to apply in this repository",
			generators: {
				script: ["git-profile", "list"],
				postProcess: (output) => {
					return Array.from(output.matchAll(/^\[(.+?)\]$/gm)).map((result) => ({
						name: result[1],
						description: `Use profile "${result[1]}"`
					}));
				}
			}
		}
	}],
	options: [{
		name: ["--help", "-h"],
		description: "Help for git-profile script"
	}, {
		name: ["--config", "-c"],
		description: "Config file (default \"~/.gitprofile\")"
	}]
};
//#endregion
export { completionSpec as default };
