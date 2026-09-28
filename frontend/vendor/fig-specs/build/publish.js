//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/publish.ts
var completionSpec = {
	name: "publish",
	description: "",
	subcommands: [
		{
			name: "new",
			description: "Set up a new website in the current folder"
		},
		{
			name: "run",
			description: "Generate and run a localhost server on default port 8000 for the website in the current folder",
			parserDirectives: { flagsArePosixNoncompliant: true },
			options: [{
				name: ["-p", "--port"],
				description: "Customize the port",
				args: {
					name: "port",
					default: "8000"
				}
			}]
		},
		{
			name: "deploy",
			description: "Generate and deploy the website in the current folder"
		},
		{
			name: "generate",
			description: "Generate the website in the current folder"
		}
	],
	options: [{
		name: ["--help", "-h"],
		description: "Show help for publish"
	}]
};
//#endregion
export { completionSpec as default };
