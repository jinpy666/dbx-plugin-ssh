//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/passwd.ts
var completionSpec = {
	name: "passwd",
	description: "Modify a user's password",
	options: [
		{
			name: "-i",
			description: "Specify where the password update should be applied",
			args: {
				name: "infosystem",
				description: "The directory system",
				suggestions: [
					"PAM",
					"opendirectory",
					"file",
					"nis"
				]
			}
		},
		{
			name: "-l",
			description: "Causes the password to be updated in the given location of the chosen directory system",
			args: {
				name: "location",
				description: "The location of the chosen directory system",
				template: ["filepaths", "folders"]
			}
		},
		{
			name: "-u",
			description: "Specify the user name to use when authenticating to the directory node",
			args: {
				name: "authname",
				description: "The user name",
				generators: {
					script: [
						"bash",
						"-c",
						"dscl . -list /Users | grep -E -v '^_'"
					],
					postProcess: (out) => out.trim().split("\n").map((name) => ({
						name,
						icon: "👤"
					}))
				}
			}
		}
	]
};
//#endregion
export { completionSpec as default };
