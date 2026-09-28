//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/chsh.ts
var completionSpec = {
	name: "chsh",
	description: "Change your login shell",
	options: [
		{
			name: ["-s", "--shell"],
			description: "Specify login shell",
			args: {
				name: "shell",
				generators: {
					script: ["chsh", "-l"],
					postProcess: (output) => {
						if (output.startsWith("fatal:")) return [];
						return output.split("\n").map((shell) => {
							return { name: shell.replace("*", "").trim() };
						});
					}
				}
			}
		},
		{
			name: ["-l", "--list-shells"],
			description: "Print list of shells and exit"
		},
		{
			name: [
				"-u",
				"-h",
				"--help"
			],
			description: "Print help message and exit"
		},
		{
			name: ["-v", "--version"],
			description: "Print version and exit"
		}
	],
	args: {
		name: "username",
		description: "Target user",
		isOptional: true
	}
};
//#endregion
export { completionSpec as default };
