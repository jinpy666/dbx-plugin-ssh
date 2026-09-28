//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/python/http.server.ts
var completionSpec = {
	name: "http.server",
	description: "",
	options: [
		{
			name: ["-d", "--directory"],
			description: "Choose the directory to initiate the server from",
			args: { template: "folders" }
		},
		{
			name: ["-b", "--bind"],
			description: "Bind to a specific IP address",
			args: {
				name: "IP Address",
				description: "E.g. 127.0.0.1"
			}
		},
		{
			name: "--cgi",
			description: "Enable the CGIHTTPRequestHandler"
		}
	],
	args: {
		name: "port",
		description: "Port number"
	}
};
//#endregion
export { completionSpec as default };
