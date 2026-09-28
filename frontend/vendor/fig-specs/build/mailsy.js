//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/mailsy.ts
var completionSpec = {
	name: "mailsy",
	description: "⚡️ Quickly generate a disposable email straight from terminal",
	subcommands: [
		{
			name: "g",
			description: "Generate a new email"
		},
		{
			name: "m",
			description: "Fetch messages from the inbox"
		},
		{
			name: "d",
			description: "Delete account"
		},
		{
			name: "me",
			description: "Show details of the account"
		},
		{
			name: "help",
			description: "Get help for a command",
			args: {
				name: "command",
				isOptional: true,
				template: "help"
			}
		}
	],
	options: [{
		name: ["-v", "--version"],
		description: "Output the current version"
	}, {
		name: ["-h", "--help"],
		description: "Display help for command",
		priority: 49,
		isPersistent: true
	}]
};
//#endregion
export { completionSpec as default };
