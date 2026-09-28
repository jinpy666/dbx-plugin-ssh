//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/login.ts
var completionSpec = {
	name: "login",
	description: "Begin session on the system",
	options: [
		{
			name: "-p",
			description: "Preserve environment"
		},
		{
			name: "-r",
			description: "Perform autologin protocol for rlogin"
		},
		{
			name: "-h",
			description: "Specify host",
			args: { name: "host" }
		},
		{
			name: "-f",
			description: "Don't authenticate user, user is preauthenticated"
		}
	],
	args: {
		name: "username",
		generators: {
			script: ["cat", "/etc/passwd"],
			postProcess: (out) => {
				return out.split("\n").map((line) => {
					const [username] = line.split(":");
					return {
						name: username,
						icon: "👤"
					};
				});
			}
		}
	}
};
//#endregion
export { completionSpec as default };
