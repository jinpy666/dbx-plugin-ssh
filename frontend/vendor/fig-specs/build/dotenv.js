//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/dotenv.ts
var completionSpec = {
	name: "dotenv",
	description: "Loads environment variables from .env",
	args: { isCommand: true },
	options: [
		{
			name: "-f",
			exclusiveOn: [
				"-h",
				"-v",
				"-t"
			],
			description: "List of env files to parse",
			args: { template: "filepaths" }
		},
		{
			name: ["-h", "--help"],
			exclusiveOn: [
				"-f",
				"-v",
				"-t"
			],
			description: "Display help"
		},
		{
			name: ["-v", "--version"],
			exclusiveOn: [
				"-f",
				"-h",
				"-t"
			],
			description: "Show version"
		},
		{
			name: ["-t", "--template"],
			exclusiveOn: [
				"-f",
				"-h",
				"-v"
			],
			description: "Create a template env file",
			args: { template: "filepaths" }
		}
	]
};
//#endregion
export { completionSpec as default };
