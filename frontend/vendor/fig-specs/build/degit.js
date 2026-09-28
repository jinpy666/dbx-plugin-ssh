//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/degit.ts
var completionSpec = {
	name: "degit",
	description: "Straightforward project scaffolding",
	args: [{
		name: "user/repo",
		generators: {
			trigger: (newToken, oldToken) => newToken.indexOf("/") !== oldToken.indexOf("/"),
			custom: async (tokens, executeShellCommand) => {
				const lastToken = tokens[tokens.length - 1];
				if (lastToken.includes(":")) return [];
				const { stdout } = await executeShellCommand({
					command: "curl",
					args: ["-sL", `https://api.github.com/users/${lastToken.slice(0, lastToken.indexOf("/"))}/repos`]
				});
				return JSON.parse(stdout).map((repo) => ({
					name: repo.full_name,
					description: repo.description ?? "Repository",
					priority: repo.is_template ? 51 : 50,
					displayName: repo.name,
					icon: "fig://icon?type=git"
				}));
			}
		}
	}, {
		name: "location",
		isOptional: true,
		template: "folders",
		suggestCurrentToken: true
	}],
	options: [
		{
			name: "--help",
			description: "Print help"
		},
		{
			name: ["-f", "--force"],
			description: "Overwrite existing files"
		},
		{
			name: ["-c", "--cache"],
			description: "Use a cache"
		},
		{
			name: ["-v", "--verbose"],
			description: "Be verbose?"
		},
		{
			name: ["-m", "--mode"],
			description: "Clone mode",
			args: {
				name: "mode",
				suggestions: ["git", "tar"]
			}
		}
	]
};
//#endregion
export { completionSpec as default };
