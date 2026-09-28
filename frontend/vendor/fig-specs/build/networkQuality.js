//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/networkQuality.ts
var completionSpec = {
	name: "networkQuality",
	description: "Measure the different aspects of network quality",
	options: [
		{
			name: "-h",
			description: "Show help for networkQuality"
		},
		{
			name: "-c",
			description: "Produce computer readable output"
		},
		{
			name: "-s",
			description: "Run tests sequentially instead of in parallel"
		},
		{
			name: "-v",
			description: "Verbose output"
		},
		{
			name: "-C",
			description: "Use a custom configuration URL",
			args: { name: "URL" }
		},
		{
			name: "-I",
			description: "Bind test to interface",
			args: {
				name: "interface",
				generators: {
					script: ["networksetup", "-listallhardwareports"],
					postProcess: (out) => {
						const suggestions = [];
						for (const match of out.matchAll(/^Hardware Port: (.*?)\n.*?Device: (.*?)$/gms)) suggestions.push({
							name: match[2],
							description: match[1]
						});
						return suggestions;
					}
				}
			}
		}
	]
};
//#endregion
export { completionSpec as default };
