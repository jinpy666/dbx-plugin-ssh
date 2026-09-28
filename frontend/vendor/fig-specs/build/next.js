//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/next.ts
var icon = "https://nextjs.org/static/favicon/favicon-16x16.png";
var hostPortOptions = [{
	name: ["-p", "--port"],
	description: "A port number on which to start the application",
	args: {}
}, {
	name: [
		"-H",
		,
		"--hostname"
	],
	description: "Hostname on which to start the application",
	args: {}
}];
var dirArgument = {
	name: "dir",
	description: "Represent the directory of the Next.js application",
	template: "folders",
	isOptional: true
};
var completionSpec = {
	name: "next",
	description: "Next.js CLI to start, build and export your application",
	options: [{
		name: ["-h", "--help"],
		description: "Output usage information"
	}, {
		name: ["-v", "--version"],
		description: "Output the version number"
	}],
	subcommands: [
		{
			name: "build",
			description: "Create an optimized production build of your application",
			icon,
			args: dirArgument,
			options: [{
				name: "--profile",
				description: "Enable production profiling"
			}, {
				name: "--debug",
				description: "Enable more verbose build output"
			}]
		},
		{
			name: "dev",
			description: "Start the application in development mode",
			icon,
			args: dirArgument,
			options: hostPortOptions
		},
		{
			name: "start",
			description: "Start the application in production mode",
			icon,
			args: dirArgument,
			options: hostPortOptions
		},
		{
			name: "export",
			description: "Exports the application for production deployment",
			icon,
			args: dirArgument,
			options: [{
				name: "-s",
				description: "Do not print any messages to console"
			}]
		},
		{
			name: "telemetry",
			description: "Allows you to control Next.js' telemetry collection",
			icon,
			args: {
				name: "status",
				description: "Turn Next.js' telemetry collection on or off",
				suggestions: [{
					name: "enable",
					description: "Enable Next.js' telemetry collection"
				}, {
					name: "disable",
					description: "Disable Next.js' telemetry collection"
				}]
			}
		}
	]
};
//#endregion
export { completionSpec as default };
