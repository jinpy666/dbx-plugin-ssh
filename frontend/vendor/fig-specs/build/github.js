//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/github.ts
var completionSpec = {
	name: "github",
	description: "Open a git repository in GitHub Desktop",
	args: {
		name: "path",
		isOptional: true,
		generators: { template: "folders" }
	},
	options: [{
		name: "--help",
		description: "Show the help page for a command",
		args: {
			name: "command",
			isOptional: true,
			suggestions: [
				"clone",
				"open",
				"help"
			]
		}
	}],
	subcommands: [
		{
			name: "clone",
			description: "Clone a repository",
			args: {
				name: "url|slug",
				suggestions: [
					{
						name: "https://github.com/",
						icon: "https://github.com/fluidicon.png"
					},
					{
						name: "https://gitlab.com/",
						icon: "https://about.gitlab.com/ico/favicon-32x32.png"
					},
					{
						name: "https://bitbucket.com/",
						icon: "https://wac-cdn.atlassian.com/assets/img/favicons/bitbucket/favicon-32x32.png"
					}
				]
			},
			options: [{
				name: ["--branch", "-b"],
				description: "The branch to checkout after cloning",
				args: { name: "branch" }
			}]
		},
		{
			name: "open",
			description: "Open a git repository in GitHub Desktop",
			args: {
				name: "path",
				isOptional: true,
				generators: { template: "folders" }
			}
		},
		{
			name: "help",
			description: "Show the help page for a command",
			args: {
				name: "command",
				isOptional: true,
				suggestions: [
					"clone",
					"open",
					"help"
				]
			}
		}
	]
};
//#endregion
export { completionSpec as default };
