//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/gron.ts
var completionSpec = {
	name: "gron",
	description: "Gron is a tool to make it easier to understand big blobs of JSON",
	options: [
		{
			name: ["--help", "-h"],
			description: "Show help for gron"
		},
		{
			name: ["-u", "--ungron"],
			description: "Reverse the operation (turn assignments back into JSON)"
		},
		{
			name: ["-v", "--values"],
			description: "Print just the values of provided assignments"
		},
		{
			name: ["-c", "--colorize"],
			description: "Colorize output (default on tty)"
		},
		{
			name: ["-m", "--monochrome"],
			description: "Monochrome (don't colorize output)"
		},
		{
			name: ["-s", "--stream"],
			description: "Treat each line of input as a separate JSON object"
		},
		{
			name: ["-k", "--insecure"],
			description: "Disable certificate validation"
		},
		{
			name: ["-j", "--json"],
			description: "Represent gron data as JSON stream"
		},
		{
			name: "--no-sort",
			description: "Don't sort output (faster)"
		},
		{
			name: "--version",
			description: "Print version information"
		}
	]
};
//#endregion
export { completionSpec as default };
